// Architecture: Shared Dinodia OS incident-ingestion helper. The hub heartbeat is the authenticated transport; this module validates, bounds and idempotently stores only incident envelopes, never the hub's full activity stream.
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const MAX_INCIDENTS = 50;
const MAX_TEXT = 512;
const MAX_JSON_BYTES = 8192;
const MAX_REVISION = 1_000_000_000;
const ALLOWED_INCIDENT_KINDS = new Set(['device_offline', 'device_unpaired', 'device_remove_failed', 'battery_critical', 'integration_offline', 'pairing_failed']);
const ALLOWED_PROTOCOLS = new Set(['zigbee', 'matter', 'thread', 'virtual', 'unknown']);

type IncidentInput = Record<string, unknown>;

function text(value: unknown, fallback = '', max = MAX_TEXT) {
  const output = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return (output || fallback).slice(0, max);
}

function date(value: unknown, fallback: Date) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function boundedJson(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => boundedJson(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    if (/token|secret|password|credential|dataset|fabric|private.?key|access.?key/i.test(key)) continue;
    const normalized = boundedJson(child, depth + 1);
    if (normalized !== undefined) result[key.slice(0, 128)] = normalized;
  }
  return result;
}

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const bounded = boundedJson(value);
    const serialized = JSON.stringify(bounded);
    if (!serialized || serialized.length > MAX_JSON_BYTES) return { metadata: 'omitted_or_truncated' };
    const result = JSON.parse(serialized);
    return result as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

export type NormalizedHubIncident = {
  id: string;
  incidentId: string;
  revision: number;
  kind: string;
  severity: string;
  state: string;
  summary: string;
  detail: string | null;
  deviceId: string | null;
  deviceName: string | null;
  deviceProtocol: string | null;
  deviceModel: string | null;
  areaName: string | null;
  labels: Prisma.InputJsonValue | undefined;
  details: Prisma.InputJsonValue | undefined;
  firstObservedAt: Date;
  lastObservedAt: Date;
  openedAt: Date | null;
  resolvedAt: Date | null;
};

export function normalizeHubIncident(value: unknown, now = new Date()): NormalizedHubIncident | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as IncidentInput;
  const device = input.device && typeof input.device === 'object' && !Array.isArray(input.device) ? input.device as IncidentInput : {};
  const incidentId = text(input.incidentId);
  const id = text(input.id, incidentId);
  const revision = Number.isInteger(Number(input.revision)) ? Math.min(MAX_REVISION, Math.max(1, Number(input.revision))) : 1;
  const severity = text(input.severity).toLowerCase();
  const state = text(input.state, 'open').toLowerCase();
  const kind = text(input.kind, 'hub_incident').toLowerCase();
  const protocol = text(device.protocol).toLowerCase();
  // The cloud contract is deliberately incident-only: routine activity and
  // amber warnings stay on the hub. A resolved record retains critical
  // severity so it can close the corresponding portal incident.
  if (!incidentId || !id || !ALLOWED_INCIDENT_KINDS.has(kind) || severity !== 'critical' || !['open', 'resolved'].includes(state) || (protocol && !ALLOWED_PROTOCOLS.has(protocol))) return null;
  const observedAt = date(input.lastObservedAt || input.occurredAt, now);
  return {
    id,
    incidentId,
    revision,
    kind,
    severity,
    state,
    summary: text(input.summary, 'Dinodia OS incident'),
    detail: text(input.detail) || null,
    deviceId: text(device.id) || null,
    deviceName: text(device.name) || null,
    deviceProtocol: protocol || null,
    deviceModel: text(device.model) || null,
    areaName: text(device.areaName) || null,
    labels: jsonValue(Array.isArray(device.labels) ? device.labels.slice(0, 10) : undefined),
    details: jsonValue(input.details),
    firstObservedAt: date(input.firstObservedAt, observedAt),
    lastObservedAt: observedAt,
    openedAt: input.openedAt ? date(input.openedAt, observedAt) : null,
    resolvedAt: input.resolvedAt ? date(input.resolvedAt, observedAt) : null,
  };
}

export async function ingestHubActivityIncidents({
  hubInstallId,
  homeId,
  payload,
  now = new Date(),
}: {
  hubInstallId: string;
  homeId: number | null;
  payload: unknown;
  now?: Date;
}): Promise<{ accepted: string[]; ignored: number }> {
  if (!homeId || !payload || typeof payload !== 'object' || Array.isArray(payload)) return { accepted: [], ignored: 0 };
  const input = payload as IncidentInput;
  if (input.schemaVersion !== 1 || !Array.isArray(input.incidents)) return { accepted: [], ignored: 0 };
  const items = input.incidents;
  if (items.length > MAX_INCIDENTS) return { accepted: [], ignored: items.length };
  const incidents = items.map((item) => normalizeHubIncident(item, now));
  if (incidents.some((incident) => !incident)) return { accepted: [], ignored: items.length };
  const normalized = incidents as NormalizedHubIncident[];
  const accepted: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const incident of normalized) {
      const existing = await tx.hubIncident.findUnique({
        where: { hubInstallId_incidentId: { hubInstallId, incidentId: incident.incidentId } },
        select: { revision: true },
      });
      if (existing && incident.revision <= existing.revision) {
        accepted.push(incident.id);
        continue;
      }
      await tx.hubIncident.upsert({
        where: { hubInstallId_incidentId: { hubInstallId, incidentId: incident.incidentId } },
        create: {
          hubInstallId,
          homeId,
          incidentId: incident.incidentId,
          revision: incident.revision,
          kind: incident.kind,
          severity: incident.severity,
          state: incident.state,
          summary: incident.summary,
          detail: incident.detail,
          deviceId: incident.deviceId,
          deviceName: incident.deviceName,
          deviceProtocol: incident.deviceProtocol,
          deviceModel: incident.deviceModel,
          areaName: incident.areaName,
          labels: incident.labels,
          details: incident.details,
          firstObservedAt: incident.firstObservedAt,
          lastObservedAt: incident.lastObservedAt,
          openedAt: incident.openedAt,
          resolvedAt: incident.resolvedAt,
        },
        update: {
          revision: incident.revision,
          kind: incident.kind,
          severity: incident.severity,
          state: incident.state,
          summary: incident.summary,
          detail: incident.detail,
          deviceId: incident.deviceId,
          deviceName: incident.deviceName,
          deviceProtocol: incident.deviceProtocol,
          deviceModel: incident.deviceModel,
          areaName: incident.areaName,
          labels: incident.labels,
          details: incident.details,
          firstObservedAt: incident.firstObservedAt,
          lastObservedAt: incident.lastObservedAt,
          openedAt: incident.openedAt,
          resolvedAt: incident.resolvedAt,
        },
      });
      accepted.push(incident.id);
    }
  });
  return { accepted, ignored: 0 };
}
