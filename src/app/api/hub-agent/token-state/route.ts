// Architecture: API boundary /hub-agent/token-state; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { HubTokenStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  decryptSyncSecret,
  generateHubToken,
  cleanupHubTokens,
  getAcceptedTokenHashes,
  getLatestVersion,
  publishPendingIfAcked,
  revokeExpiredGraceTokens,
} from '@/lib/hubTokens';
import { verifyHmac } from '@/lib/hubCrypto';
import { enforceHubReplayProtection, HubReplayError } from '@/lib/hubReplayProtection';
import { normalizeLanBaseUrl } from '@/lib/lanBaseUrl';
import { hashForLog, safeLog } from '@/lib/safeLogger';
import { normalizeHaAreasSnapshot } from '@/lib/haAreasSnapshot';
import { ingestHubActivityIncidents } from '@/lib/hubActivityIncidents';
import { estimateLightCostGbp, estimateLightKwh, readElectricUsageConfig } from '@/lib/electricUsageConfig';
import { acknowledgeOperatorCredential, markOperatorCredentialDelivered, publishAcknowledgedOperatorCredential } from '@/lib/hubOperatorCredentials';
import { decryptSecret } from '@/lib/hubCrypto';
import { createHubEncryptedCredentialEnvelope } from '@/lib/hubCredentialEnvelope';
import { hashRequestBody, verifyHubRequestSignature } from '@/lib/hubSignedRequests';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

type HeatingUsageDeviceLabel = 'Boiler' | 'Radiator';

type HeatingUsageDeviceUpdate = {
  label: HeatingUsageDeviceLabel;
  entityId: string;
  onSeconds: number;
  offSeconds: number;
  unknownSeconds: number | null;
  efficiencyWeightedOnSeconds?: number | null;
  efficiencyOnSeconds?: number | null;
  efficiencyBand?: string | null;
  efficiencyBandVersion?: number | null;
  lastSeenAt: string;
  lastWasOn: boolean | null;
  lastWasKnown: boolean | null;
};

type HeatingUsageUpload = {
  schemaVersion: number;
  capturedAt?: string;
  devices?: unknown;
};

type ElectricUsageDeviceUpdate = {
  label: 'Light';
  entityId: string;
  entityName: string | null;
  trackingStartedAt: Date | null;
  trackingEpoch: string;
  assignmentStartedAt: Date | null;
  assignmentEpoch: string;
  areaId: string | null;
  areaName: string | null;
  onSeconds: number;
  offSeconds: number;
  unknownSeconds: number;
  lastSeenAt: Date;
  lastWasOn: boolean | null;
  lastWasKnown: boolean | null;
  retired: boolean;
};

type ElectricUsageUpload = { schemaVersion: number; capturedAt?: string; devices?: unknown };

type HubRuntimeUpload = {
  kind: 'dinodia_os';
  version: string;
  capabilities: {
    managedAreaProvisioningV1: true;
    managedDevicePresentationV1?: boolean;
    activityIncidentReportingV1?: boolean;
    alexaNativeProjectionV1?: boolean;
    alexaNativeDirectiveV1?: boolean;
  };
};

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeHubRuntime(value: unknown): { reportedAt: Date; runtime: HubRuntimeUpload } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'dinodia_os' || typeof obj.version !== 'string' || !obj.version.trim()) return null;
  const capabilities = obj.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null;
  const cap = capabilities as Record<string, unknown>;
  if (cap.managedAreaProvisioningV1 !== true) return null;
  return {
    reportedAt: new Date(),
    runtime: {
      kind: 'dinodia_os',
      version: obj.version.trim().slice(0, 64),
      capabilities: {
        managedAreaProvisioningV1: true,
        ...(cap.managedDevicePresentationV1 === true ? { managedDevicePresentationV1: true } : {}),
        ...(cap.activityIncidentReportingV1 === true ? { activityIncidentReportingV1: true } : {}),
        ...(cap.alexaNativeProjectionV1 === true ? { alexaNativeProjectionV1: true } : {}),
        ...(cap.alexaNativeDirectiveV1 === true ? { alexaNativeDirectiveV1: true } : {}),
      },
    },
  };
}

function asNonNegativeInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 0) return null;
  return i;
}

function asNonNegativeFloat(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return n;
}

function normalizeEfficiencyBand(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!raw) return null;
  if (!/^[A-G]$/.test(raw)) return null;
  return raw;
}

function normalizeHeatingUsageDeviceUpdate(value: unknown, schemaVersion: number): HeatingUsageDeviceUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const label = obj.label === 'Boiler' || obj.label === 'Radiator' ? (obj.label as HeatingUsageDeviceLabel) : null;
  const entityId = typeof obj.entityId === 'string' ? obj.entityId.trim() : '';
  const onSeconds = asNonNegativeInt(obj.onSeconds);
  const offSeconds = asNonNegativeInt(obj.offSeconds);
  const unknownSeconds = obj.unknownSeconds === undefined ? null : asNonNegativeInt(obj.unknownSeconds);
  const efficiencyWeightedOnSeconds =
    schemaVersion >= 2 && label === 'Boiler' && obj.efficiencyWeightedOnSeconds !== undefined
      ? asNonNegativeFloat(obj.efficiencyWeightedOnSeconds)
      : null;
  const efficiencyOnSeconds =
    schemaVersion >= 2 && label === 'Boiler' && obj.efficiencyOnSeconds !== undefined
      ? asNonNegativeInt(obj.efficiencyOnSeconds)
      : null;
  const efficiencyBand =
    schemaVersion >= 2 && label === 'Boiler' && obj.efficiencyBand !== undefined
      ? normalizeEfficiencyBand(obj.efficiencyBand)
      : null;
  const efficiencyBandVersion =
    schemaVersion >= 2 && label === 'Boiler' && obj.efficiencyBandVersion !== undefined
      ? asNonNegativeInt(obj.efficiencyBandVersion)
      : null;
  const lastSeenAt = parseIsoDate(obj.lastSeenAt);
  const lastWasOn =
    obj.lastWasOn === null ? null : typeof obj.lastWasOn === 'boolean' ? obj.lastWasOn : null;
  const lastWasKnown =
    obj.lastWasKnown === null ? null : typeof obj.lastWasKnown === 'boolean' ? obj.lastWasKnown : null;

  if (!label || !entityId || !lastSeenAt) return null;
  if (onSeconds === null || offSeconds === null) return null;
  if (obj.unknownSeconds !== undefined && unknownSeconds === null) return null;
  if (schemaVersion >= 2 && label === 'Boiler') {
    if (obj.efficiencyWeightedOnSeconds !== undefined && efficiencyWeightedOnSeconds === null) return null;
    if (obj.efficiencyOnSeconds !== undefined && efficiencyOnSeconds === null) return null;
    if (obj.efficiencyBand !== undefined && efficiencyBand === null) return null;
    if (obj.efficiencyBandVersion !== undefined && efficiencyBandVersion === null) return null;
  }

  return {
    label,
    entityId,
    onSeconds,
    offSeconds,
    unknownSeconds,
    ...(schemaVersion >= 2 && label === 'Boiler'
      ? {
          efficiencyWeightedOnSeconds,
          efficiencyOnSeconds,
          efficiencyBand,
          efficiencyBandVersion,
        }
      : {}),
    lastSeenAt: lastSeenAt.toISOString(),
    lastWasOn,
    lastWasKnown,
  };
}

function normalizeElectricUsageDeviceUpdate(value: unknown, now = new Date()): ElectricUsageDeviceUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const entityId = typeof obj.entityId === 'string' ? obj.entityId.trim() : '';
  const trackingEpoch = typeof obj.trackingEpoch === 'string' ? obj.trackingEpoch.trim() : '';
  const assignmentEpoch = typeof obj.assignmentEpoch === 'string' ? obj.assignmentEpoch.trim() : '';
  const lastSeenAt = parseIsoDate(obj.lastSeenAt);
  const trackingStartedAt = obj.trackingStartedAt === undefined || obj.trackingStartedAt === null ? null : parseIsoDate(obj.trackingStartedAt);
  const assignmentStartedAt = obj.assignmentStartedAt === undefined || obj.assignmentStartedAt === null ? null : parseIsoDate(obj.assignmentStartedAt);
  const onSeconds = asNonNegativeInt(obj.onSeconds);
  const offSeconds = asNonNegativeInt(obj.offSeconds);
  const unknownSeconds = asNonNegativeInt(obj.unknownSeconds);
  const lastWasOn = typeof obj.lastWasOn === 'boolean' ? obj.lastWasOn : null;
  const lastWasKnown = typeof obj.lastWasKnown === 'boolean' ? obj.lastWasKnown : null;
  if (obj.label !== 'Light' || !entityId || !/^(light|switch)\.[^\s]{1,200}$/i.test(entityId) || !trackingEpoch || trackingEpoch.length > 128 || !assignmentEpoch || assignmentEpoch.length > 128 || !lastSeenAt || onSeconds === null || offSeconds === null || unknownSeconds === null) return null;
  if (trackingStartedAt === undefined || assignmentStartedAt === undefined) return null;
  if (lastSeenAt.getTime() > now.getTime() + 5 * 60 * 1000) return null;
  const clean = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
  return {
    label: 'Light',
    entityId,
    entityName: clean(obj.entityName, 200),
    trackingStartedAt,
    trackingEpoch,
    assignmentStartedAt,
    assignmentEpoch,
    areaId: clean(obj.areaId, 128),
    areaName: clean(obj.areaName, 200),
    onSeconds,
    offSeconds,
    unknownSeconds,
    lastSeenAt,
    lastWasOn,
    lastWasKnown,
    retired: obj.retired === true,
  };
}

function electricWindowStart(date: Date) {
  const size = 2 * 60 * 60 * 1000;
  return new Date(Math.floor(date.getTime() / size) * size);
}

function boundedElectricDelta(current: { on: number; off: number; unknown: number }, previous: { on: number; off: number; unknown: number }, interval: number) {
  const values = [current.on - previous.on, current.off - previous.off, current.unknown - previous.unknown];
  if (values.some((value) => value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= interval) return { onForSeconds: values[0], offForSeconds: values[1], unknownForSeconds: values[2] };
  if (interval <= 0 || total <= 0) return { onForSeconds: 0, offForSeconds: 0, unknownForSeconds: 0 };
  const scaled = values.map((value) => Math.floor((value * interval) / total));
  for (let i = 0; i < interval - scaled.reduce((sum, value) => sum + value, 0); i += 1) scaled[i % 3] += 1;
  return { onForSeconds: scaled[0], offForSeconds: scaled[1], unknownForSeconds: scaled[2] };
}

async function ingestElectricUsage({ haConnectionId, upload, now = new Date() }: { haConnectionId: number; upload: ElectricUsageUpload; now?: Date }) {
  if (Number(upload?.schemaVersion ?? 0) !== 1 || !Array.isArray(upload.devices)) return { processed: 0, skipped: 0 };
  const normalized = upload.devices.slice(0, 200).map((row) => normalizeElectricUsageDeviceUpdate(row, now)).filter(Boolean) as ElectricUsageDeviceUpdate[];
  const groups = new Map<string, ElectricUsageDeviceUpdate[]>();
  for (const row of normalized) {
    const list = groups.get(row.entityId) || [];
    list.push(row);
    groups.set(row.entityId, list);
  }
  let processed = 0;
  let skipped = upload.devices.length > 200 ? upload.devices.length - 200 : 0;
  const config = readElectricUsageConfig();
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime());
    let existing = await prisma.electricUsageAccumulator.findUnique({ where: { haConnectionId_entityId: { haConnectionId, entityId: rows[0].entityId } } });
    for (const update of rows) {
      if (existing?.lastSeenAt && update.lastSeenAt.getTime() <= existing.lastSeenAt.getTime()) {
        const sameEpoch = existing.trackingEpoch === update.trackingEpoch && existing.assignmentEpoch === update.assignmentEpoch;
        const updateAssignmentStart = update.assignmentStartedAt?.getTime() ?? 0;
        const existingAssignmentStart = existing.assignmentStartedAt?.getTime() ?? 0;
        if (sameEpoch || (existingAssignmentStart > 0 && updateAssignmentStart > 0 && updateAssignmentStart <= existingAssignmentStart)) { skipped += 1; continue; }
      }
      if (existing && (existing.trackingEpoch !== update.trackingEpoch || existing.assignmentEpoch !== update.assignmentEpoch || update.retired)) {
        const previous = { on: existing.onSeconds, off: existing.offSeconds, unknown: existing.unknownSeconds };
        const cursor = { on: existing.lastSnapshotOnSeconds ?? 0, off: existing.lastSnapshotOffSeconds ?? 0, unknown: existing.lastSnapshotUnknownSeconds ?? 0 };
        const startAt = existing.lastSnapshotAt || existing.assignmentStartedAt || existing.trackingStartedAt || update.lastSeenAt;
        const interval = Math.min(24 * 60 * 60 + 10 * 60, Math.max(0, Math.floor((update.lastSeenAt.getTime() - startAt.getTime()) / 1000)));
        const delta = boundedElectricDelta(previous, cursor, interval);
        await prisma.$transaction(async (tx) => {
          if (delta && delta.onForSeconds + delta.offForSeconds + delta.unknownForSeconds > 0) {
            const kwh = estimateLightKwh(config.averageWatts, delta.onForSeconds);
            await tx.electricUsageReading.create({ data: {
              haConnectionId, entityId: existing!.entityId, entityName: existing!.entityName, trackingEpoch: existing!.trackingEpoch, assignmentEpoch: existing!.assignmentEpoch,
              sourceAreaId: existing!.sourceAreaId, sourceAreaName: existing!.sourceAreaName, windowStartedAt: electricWindowStart(startAt), windowEndedAt: update.lastSeenAt,
              onForSeconds: delta.onForSeconds, offForSeconds: delta.offForSeconds, unknownForSeconds: delta.unknownForSeconds,
              averageWattsApplied: config.averageWatts, electricPricePerKwh: config.electricPricePerKwh, estimatedKwh: kwh, estimatedCostGbp: estimateLightCostGbp(kwh, config.electricPricePerKwh),
            } });
          }
          await tx.electricUsageAccumulator.update({ where: { id: existing!.id }, data: {
            entityName: update.entityName, trackingStartedAt: update.trackingStartedAt, trackingEpoch: update.trackingEpoch, assignmentStartedAt: update.assignmentStartedAt, assignmentEpoch: update.assignmentEpoch,
            sourceAreaId: update.areaId, sourceAreaName: update.areaName, onSeconds: update.onSeconds, offSeconds: update.offSeconds, unknownSeconds: update.unknownSeconds,
            lastSeenAt: update.lastSeenAt, lastWasOn: update.lastWasOn, lastWasKnown: update.lastWasKnown, retiredAt: update.retired ? update.lastSeenAt : null,
            lastSnapshotOnSeconds: null, lastSnapshotOffSeconds: null, lastSnapshotUnknownSeconds: null, lastSnapshotAt: null,
          } });
        });
        existing = await prisma.electricUsageAccumulator.findUnique({ where: { id: existing.id } });
        processed += 1;
        continue;
      }
      const next = {
        entityName: update.entityName, trackingStartedAt: update.trackingStartedAt, trackingEpoch: update.trackingEpoch, assignmentStartedAt: update.assignmentStartedAt, assignmentEpoch: update.assignmentEpoch,
        sourceAreaId: update.areaId, sourceAreaName: update.areaName, onSeconds: update.onSeconds, offSeconds: update.offSeconds, unknownSeconds: update.unknownSeconds,
        lastSeenAt: update.lastSeenAt, lastWasOn: update.lastWasOn, lastWasKnown: update.lastWasKnown, retiredAt: update.retired ? update.lastSeenAt : null,
      };
      existing = await prisma.electricUsageAccumulator.upsert({
        where: { haConnectionId_entityId: { haConnectionId, entityId: update.entityId } },
        create: { haConnectionId, entityId: update.entityId, ...next, lastSnapshotOnSeconds: null, lastSnapshotOffSeconds: null, lastSnapshotUnknownSeconds: null, lastSnapshotAt: null },
        update: next,
      });
      processed += 1;
    }
  }
  return { processed, skipped };
}

async function ingestHeatingUsage({
  haConnectionId,
  upload,
}: {
  haConnectionId: number;
  upload: HeatingUsageUpload;
}): Promise<{ processed: number; skipped: number }> {
  const schemaVersion = Number(upload?.schemaVersion ?? 0);
  if (schemaVersion !== 1 && schemaVersion !== 2) return { processed: 0, skipped: 0 };

  const rawDevices = (upload as HeatingUsageUpload)?.devices;
  if (!Array.isArray(rawDevices)) return { processed: 0, skipped: 0 };

  const MAX_DEVICES = 200;
  const normalized = rawDevices
    .slice(0, MAX_DEVICES)
    .map((row) => normalizeHeatingUsageDeviceUpdate(row, schemaVersion))
    .filter(Boolean) as HeatingUsageDeviceUpdate[];

  if (normalized.length === 0) return { processed: 0, skipped: 0 };

  const entityIds = Array.from(new Set(normalized.map((d) => d.entityId)));
  const knownDevices = await prisma.device.findMany({
    where: { haConnectionId, entityId: { in: entityIds } },
    select: { entityId: true, label: true },
  });
  const labelByEntityId = new Map(knownDevices.map((d) => [d.entityId, (d.label || '').trim()]));

  let processed = 0;
  let skipped = 0;

  for (const update of normalized) {
    const dbLabel = (labelByEntityId.get(update.entityId) || '').toLowerCase();
    const expected = update.label.toLowerCase();
    if (dbLabel && dbLabel !== expected) {
      skipped += 1;
      continue;
    }

    const lastSeenAt = new Date(update.lastSeenAt);
    const normalizedLastWasKnown =
      typeof update.lastWasKnown === 'boolean'
        ? update.lastWasKnown
        : typeof update.lastWasOn === 'boolean'
        ? true
        : false;
    const normalizedLastWasOn =
      normalizedLastWasKnown && typeof update.lastWasOn === 'boolean' ? update.lastWasOn : false;
    if (update.label === 'Boiler') {
      const existing = await prisma.boilerUsageAccumulator.findUnique({
        where: { haConnectionId_entityId: { haConnectionId, entityId: update.entityId } },
        select: { lastSeenAt: true },
      });

      if (existing?.lastSeenAt && lastSeenAt.getTime() <= existing.lastSeenAt.getTime()) {
        skipped += 1;
        continue;
      }

      await prisma.boilerUsageAccumulator.upsert({
        where: { haConnectionId_entityId: { haConnectionId, entityId: update.entityId } },
        create: {
          haConnectionId,
          entityId: update.entityId,
          onSeconds: update.onSeconds,
          offSeconds: update.offSeconds,
          unknownSeconds: update.unknownSeconds ?? 0,
          ...(typeof update.efficiencyWeightedOnSeconds === 'number'
            ? { efficiencyWeightedOnSeconds: update.efficiencyWeightedOnSeconds }
            : {}),
          ...(typeof update.efficiencyOnSeconds === 'number'
            ? { efficiencyOnSeconds: update.efficiencyOnSeconds }
            : {}),
          lastSeenAt,
          lastWasOn: normalizedLastWasOn,
          lastWasKnown: normalizedLastWasKnown,
        },
        update: {
          onSeconds: update.onSeconds,
          offSeconds: update.offSeconds,
          ...(update.unknownSeconds !== null ? { unknownSeconds: update.unknownSeconds } : {}),
          ...(typeof update.efficiencyWeightedOnSeconds === 'number'
            ? { efficiencyWeightedOnSeconds: update.efficiencyWeightedOnSeconds }
            : {}),
          ...(typeof update.efficiencyOnSeconds === 'number'
            ? { efficiencyOnSeconds: update.efficiencyOnSeconds }
            : {}),
          lastSeenAt,
          lastWasOn: normalizedLastWasOn,
          lastWasKnown: normalizedLastWasKnown,
        },
      });
      processed += 1;
      continue;
    }

    const existing = await prisma.radiatorUsageAccumulator.findUnique({
      where: { haConnectionId_entityId: { haConnectionId, entityId: update.entityId } },
      select: { lastSeenAt: true },
    });

    if (existing?.lastSeenAt && lastSeenAt.getTime() <= existing.lastSeenAt.getTime()) {
      skipped += 1;
      continue;
    }

    await prisma.radiatorUsageAccumulator.upsert({
      where: { haConnectionId_entityId: { haConnectionId, entityId: update.entityId } },
      create: {
        haConnectionId,
        entityId: update.entityId,
        onSeconds: update.onSeconds,
        offSeconds: update.offSeconds,
        unknownSeconds: update.unknownSeconds ?? 0,
        lastSeenAt,
        lastWasOn: normalizedLastWasOn,
        lastWasKnown: normalizedLastWasKnown,
      },
      update: {
        onSeconds: update.onSeconds,
        offSeconds: update.offSeconds,
        ...(update.unknownSeconds !== null ? { unknownSeconds: update.unknownSeconds } : {}),
        lastSeenAt,
        lastWasOn: normalizedLastWasOn,
        lastWasKnown: normalizedLastWasKnown,
      },
    });
    processed += 1;
  }

  return { processed, skipped };
}

export async function POST(req: NextRequest) {
	  let body: {
	    serial?: string;
	    ts?: number;
	    nonce?: string;
	    sig?: string;
	    agentSeenVersion?: number;
	    lanBaseUrl?: string;
	    heatingUsage?: HeatingUsageUpload;
	    electricUsage?: ElectricUsageUpload;
	    heatingUsageResetAckAt?: string;
	    haAreas?: unknown;
	    hubRuntime?: unknown;
	    activityIncidents?: unknown;
	    operatorCredentialVersion?: number;
	  };
  try {
    body = await req.json();
  } catch {
    return apiFailFromStatus(400, 'Invalid body');
  }

  const { serial, ts, nonce, sig } = body ?? {};
	  const agentSeenVersion = Number(body?.agentSeenVersion ?? 0);
	  const reportedLanBaseUrl = normalizeLanBaseUrl(body?.lanBaseUrl);
	  const heatingUsageResetAckAt = parseIsoDate(body?.heatingUsageResetAckAt);
	  const haAreasSnapshot = normalizeHaAreasSnapshot(body?.haAreas);
	  const hubRuntime = normalizeHubRuntime(body?.hubRuntime);
	  const operatorCredentialVersion = Number(body?.operatorCredentialVersion ?? 0);

  if (!serial || typeof ts !== 'number' || !nonce || !sig) {
    return apiFailFromStatus(400, 'serial, ts, nonce, sig are required.');
  }

	  const hubInstall = await prisma.hubInstall.findUnique({
	    where: { serial: serial.trim() },
	    select: {
	      id: true,
	      serial: true,
	      syncSecretCiphertext: true,
	      platformSyncEnabled: true,
	      platformSyncIntervalMinutes: true,
	      rotateEveryMinutes: true,
	      graceMinutes: true,
	      publishedHubTokenVersion: true,
	      lastAckedHubTokenVersion: true,
	      heatingUsageResetRequestedAt: true,
	      heatingUsageResetCompletedAt: true,
	      lastReportedHaAreasAt: true,
	      runtimeKind: true,
	      runtimeVersion: true,
	      runtimeCapabilities: true,
	      runtimeCapabilitiesReportedAt: true,
	      manufacturingIdentity: { select: { signingPublicKey: true, encryptionPublicKey: true, status: true, revokedAt: true } },
	      hubTokens: true,
	      publishedOperatorCredentialVersion: true,
	      lastAckedOperatorCredentialVersion: true,
	      operatorCredentials: { where: { status: { in: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED'] } }, orderBy: { version: 'asc' }, take: 1 },
	      homeId: true,
	      home: { select: { id: true, haConnectionId: true, timeZone: true } },
	    },
	  });
  if (!hubInstall) {
    return apiFailFromStatus(404, 'Unknown hub serial.');
  }

  const nativeTimestamp = Number(req.headers.get('x-dinodia-hub-timestamp') || 0);
  const nativeNonce = String(req.headers.get('x-dinodia-hub-nonce') || '');
  const nativeSignature = String(req.headers.get('x-dinodia-hub-signature') || '');
  const nativeIdentity = hubInstall.manufacturingIdentity;
  const hasNativeHeaders = Boolean(nativeTimestamp && nativeNonce && nativeSignature);
  if (hasNativeHeaders) {
    if (!nativeIdentity || nativeIdentity.status === 'REVOKED' || nativeIdentity.revokedAt) return apiFailFromStatus(401, 'Hub identity is not trusted.');
    let publicKey: crypto.KeyObject;
    try { publicKey = crypto.createPublicKey(nativeIdentity.signingPublicKey); } catch { return apiFailFromStatus(401, 'Hub identity is invalid.'); }
    if (!verifyHubRequestSignature({ method: 'POST', path: '/api/hub-agent/token-state', timestamp: nativeTimestamp, nonce: nativeNonce, signature: nativeSignature, bodyHash: hashRequestBody(body), publicKey })) return apiFailFromStatus(401, 'Invalid hub signature.');
    try { await enforceHubReplayProtection({ serial: serial.trim(), nonce: nativeNonce, ts: nativeTimestamp }); } catch (err) {
      if (err instanceof HubReplayError) return apiFailFromStatus(401, 'Replay detected');
      throw err;
    }
  } else {
    if (process.env.NODE_ENV === 'production' || !hubInstall.syncSecretCiphertext) return apiFailFromStatus(401, 'A signed hub identity request is required.');
    const syncSecret = decryptSyncSecret(hubInstall.syncSecretCiphertext);
    try {
      verifyHmac({ serial, ts, nonce, sig }, syncSecret);
      await enforceHubReplayProtection({ serial, nonce, ts });
    } catch (err) {
      if (err instanceof HubReplayError) return apiFailFromStatus(401, 'Replay detected');
      return apiFailFromStatus(401, 'Invalid hub signature.');
    }
  }

  const now = new Date();
  await revokeExpiredGraceTokens(hubInstall.id, now);
  await cleanupHubTokens(hubInstall.id);

  let publishedVersion = hubInstall.publishedHubTokenVersion ?? 0;

  // Operator credential acknowledgement travels over the already authenticated
  // outbound hub channel. The response intentionally contains no plaintext or
  // ciphertext credential; publication occurs only after this acknowledgement.
  let publishedOperatorCredentialVersion = hubInstall.publishedOperatorCredentialVersion ?? 0;
  const pendingOperator = hubInstall.operatorCredentials[0];
  let operatorCredentialDelivery: { version: number; envelope: ReturnType<typeof createHubEncryptedCredentialEnvelope> } | null = null;
  if (pendingOperator && (pendingOperator.status === 'PENDING' || pendingOperator.status === 'DELIVERED') && hubInstall.manufacturingIdentity?.encryptionPublicKey) {
    try {
      const delivered = pendingOperator.status === 'PENDING'
        ? await markOperatorCredentialDelivered(hubInstall.id, pendingOperator.version)
        : { record: pendingOperator, ciphertext: pendingOperator.tokenCiphertext };
      const plaintext = decryptSecret(delivered.ciphertext);
      operatorCredentialDelivery = {
        version: pendingOperator.version,
        envelope: createHubEncryptedCredentialEnvelope(plaintext, hubInstall.manufacturingIdentity.encryptionPublicKey, pendingOperator.version),
      };
    } catch {
      await prisma.hubOperatorCredential.update({ where: { id: pendingOperator.id }, data: { lastDeliveryError: 'encrypted_delivery_failed' } }).catch(() => {});
    }
  }
  if (pendingOperator && Number.isInteger(operatorCredentialVersion) && operatorCredentialVersion >= pendingOperator.version) {
    await acknowledgeOperatorCredential(hubInstall.id, pendingOperator.version);
    const published = await publishAcknowledgedOperatorCredential(
      hubInstall.id,
      pendingOperator.version,
      publishedOperatorCredentialVersion,
      20,
    );
    publishedOperatorCredentialVersion = published.version;
  }

  const pending = hubInstall.hubTokens
    .filter((t) => t.status === HubTokenStatus.PENDING)
    .sort((a, b) => a.version - b.version)[0];
  if (pending && agentSeenVersion >= pending.version) {
    publishedVersion = await publishPendingIfAcked(
      hubInstall.id,
      pending.version,
      publishedVersion,
      hubInstall.graceMinutes
    );
  }

  // Seed a pending token if all tokens were wiped (e.g., home reset).
  const pendingToken = await prisma.hubToken.findFirst({
    where: { hubInstallId: hubInstall.id, status: HubTokenStatus.PENDING },
    orderBy: { version: 'asc' },
    select: { id: true, version: true },
  });

  const activeToken = await prisma.hubToken.findFirst({
    where: {
      hubInstallId: hubInstall.id,
      status: HubTokenStatus.ACTIVE,
      publishedAt: { not: null },
    },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, publishedAt: true },
  });

  if (!pendingToken && !activeToken) {
    const seed = generateHubToken();
    try {
      await prisma.hubToken.create({
        data: {
          hubInstallId: hubInstall.id,
          version: 1,
          status: HubTokenStatus.PENDING,
          tokenHash: seed.hash,
          tokenCiphertext: seed.ciphertext,
        },
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }
    await cleanupHubTokens(hubInstall.id);
  } else if (!pendingToken && activeToken && hubInstall.platformSyncEnabled) {
    const rotateMinutes = hubInstall.rotateEveryMinutes ?? 60;
    const rotateMs = rotateMinutes * 60 * 1000;
    const ageMs = now.getTime() - new Date(activeToken.publishedAt as Date).getTime();

    if (ageMs >= rotateMs) {
      const latestVersion = await getLatestVersion(hubInstall.id);
      const nextVersion = latestVersion + 1;
      const token = generateHubToken();
      try {
        await prisma.hubToken.create({
          data: {
            hubInstallId: hubInstall.id,
            version: nextVersion,
            status: HubTokenStatus.PENDING,
            tokenHash: token.hash,
            tokenCiphertext: token.ciphertext,
          },
        });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
      }
      await cleanupHubTokens(hubInstall.id);
    }
  }

  const latestVersion = await getLatestVersion(hubInstall.id);
  const hashes = await getAcceptedTokenHashes(hubInstall.id, now);

  const hubUpdate: Prisma.HubInstallUpdateInput = {
    lastSeenAt: now,
    lastAckedHubTokenVersion: Math.max(agentSeenVersion, hubInstall.lastAckedHubTokenVersion ?? 0),
  };

	  if (reportedLanBaseUrl) {
	    hubUpdate.lastReportedLanBaseUrl = reportedLanBaseUrl;
	    hubUpdate.lastReportedLanBaseUrlAt = now;
	  }

	  if (
	    haAreasSnapshot &&
	    (!hubInstall.lastReportedHaAreasAt ||
	      haAreasSnapshot.capturedAt.getTime() > hubInstall.lastReportedHaAreasAt.getTime())
	  ) {
	    hubUpdate.lastReportedHaAreas = haAreasSnapshot.snapshot;
	    hubUpdate.lastReportedHaAreasAt = haAreasSnapshot.capturedAt;
	  }

	  if (hubRuntime) {
	    hubUpdate.runtimeKind = hubRuntime.runtime.kind;
	    hubUpdate.runtimeVersion = hubRuntime.runtime.version;
	    hubUpdate.runtimeCapabilities = hubRuntime.runtime.capabilities;
	    hubUpdate.runtimeCapabilitiesReportedAt = hubRuntime.reportedAt;
	  }

	  await prisma.$transaction(async (tx) => {
	    await tx.hubInstall.update({
	      where: { id: hubInstall.id },
      data: hubUpdate,
    });

    if (reportedLanBaseUrl && hubInstall.home?.haConnectionId) {
      await tx.haConnection.update({
        where: { id: hubInstall.home.haConnectionId },
        data: { baseUrl: reportedLanBaseUrl },
      });
    }
  });

  const pendingHeatingUsageResetAt =
    hubInstall.heatingUsageResetRequestedAt &&
    (!hubInstall.heatingUsageResetCompletedAt ||
      hubInstall.heatingUsageResetCompletedAt.getTime() < hubInstall.heatingUsageResetRequestedAt.getTime())
      ? hubInstall.heatingUsageResetRequestedAt.toISOString()
      : null;

  // Phase 8: mark hub-side heating usage reset as completed once the hub agent acknowledges it.
  let heatingUsageResetAtForResponse: string | null = pendingHeatingUsageResetAt;
  if (heatingUsageResetAckAt && hubInstall.heatingUsageResetRequestedAt) {
    const requestedAtMs = hubInstall.heatingUsageResetRequestedAt.getTime();
    const ackMs = heatingUsageResetAckAt.getTime();
    const completedMs = hubInstall.heatingUsageResetCompletedAt?.getTime() ?? 0;
    if (ackMs >= requestedAtMs && ackMs > completedMs) {
      await prisma.hubInstall.update({
        where: { id: hubInstall.id },
        data: { heatingUsageResetCompletedAt: heatingUsageResetAckAt },
      });
      heatingUsageResetAtForResponse = null;
    }
  }

  if (hubInstall.home?.haConnectionId && body?.heatingUsage) {
    try {
      const summary = await ingestHeatingUsage({
        haConnectionId: hubInstall.home.haConnectionId,
        upload: body.heatingUsage,
      });
      if (summary.processed > 0 || summary.skipped > 0) {
        safeLog('info', '[hub-agent/token-state] Heating usage upload processed', {
          serialHash: hashForLog(serial),
          haConnectionIdHash: hashForLog(String(hubInstall.home.haConnectionId)),
          processed: summary.processed,
          skipped: summary.skipped,
        });
      }
    } catch (err) {
      safeLog('warn', '[hub-agent/token-state] Heating usage upload failed', {
        serialHash: hashForLog(serial),
        haConnectionIdHash: hashForLog(String(hubInstall.home.haConnectionId)),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let electricUsageSummary = { processed: 0, skipped: 0 };
  if (hubInstall.home?.haConnectionId && body?.electricUsage) {
    try {
      electricUsageSummary = await ingestElectricUsage({ haConnectionId: hubInstall.home.haConnectionId, upload: body.electricUsage, now });
      if (electricUsageSummary.processed > 0 || electricUsageSummary.skipped > 0) {
        safeLog('info', '[hub-agent/token-state] Electric usage upload processed', {
          serialHash: hashForLog(serial),
          haConnectionIdHash: hashForLog(String(hubInstall.home.haConnectionId)),
          processed: electricUsageSummary.processed,
          skipped: electricUsageSummary.skipped,
        });
      }
    } catch (err) {
      safeLog('warn', '[hub-agent/token-state] Electric usage upload failed', {
        serialHash: hashForLog(serial),
        haConnectionIdHash: hashForLog(String(hubInstall.home.haConnectionId)),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let heatingUsageConfig: {
    schemaVersion: number;
    efficiencyBandsVersion: number;
    defaultBoilerEfficiencyBand: string;
    boilerBandsByEntityId: Record<string, string>;
  } | null = null;

  if (hubInstall.home?.haConnectionId) {
    const boilerOverrides = await prisma.device.findMany({
      where: {
        haConnectionId: hubInstall.home.haConnectionId,
        label: 'Boiler',
        boilerEfficiencyBand: { not: null },
      },
      select: { entityId: true, boilerEfficiencyBand: true },
    });
    const map: Record<string, string> = {};
    for (const row of boilerOverrides) {
      const band = typeof row.boilerEfficiencyBand === 'string' ? row.boilerEfficiencyBand.trim().toUpperCase() : '';
      if (/^[A-G]$/.test(band)) map[row.entityId] = band;
    }
    heatingUsageConfig = {
      schemaVersion: 1,
      efficiencyBandsVersion: 1,
      defaultBoilerEfficiencyBand: 'B',
      boilerBandsByEntityId: map,
    };
  }

  let acceptedActivityIncidentIds: string[] = [];
  if (hubRuntime?.runtime.capabilities.activityIncidentReportingV1 === true && body?.activityIncidents) {
    try {
      const incidentSummary = await ingestHubActivityIncidents({
        hubInstallId: hubInstall.id,
        homeId: hubInstall.homeId,
        payload: body.activityIncidents,
        now,
      });
      acceptedActivityIncidentIds = incidentSummary.accepted;
      if (incidentSummary.ignored > 0) {
        safeLog('warn', '[hub-agent/token-state] Ignored invalid activity incident envelopes', {
          serialHash: hashForLog(serial),
          ignored: incidentSummary.ignored,
        });
      }
    } catch (err) {
      safeLog('warn', '[hub-agent/token-state] Activity incident ingestion failed', {
        serialHash: hashForLog(serial),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    platformSyncEnabled: hubInstall.platformSyncEnabled,
    platformSyncIntervalMinutes: hubInstall.platformSyncIntervalMinutes,
    publishedVersion,
    publishedOperatorCredentialVersion,
    operatorCredentialDelivery,
    latestVersion,
    hubTokenHashes: hashes,
    heatingUsageResetAt: heatingUsageResetAtForResponse,
    heatingUsageConfig,
    electricUsage: electricUsageSummary,
    homeTimeZone: hubInstall.home?.timeZone || 'Europe/London',
    acceptedActivityIncidentIds,
  });
}
