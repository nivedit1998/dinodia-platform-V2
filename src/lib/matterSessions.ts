// Architecture: Shared platform helper src/lib/matterSessions.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { createHash } from 'crypto';
import {
  CommissioningKind,
  MatterCommissioningStatus,
  NewDeviceCommissioningSession,
  Prisma,
} from '@prisma/client';
import { diffRegistrySnapshots, RegistrySnapshot } from '@/lib/haRegistrySnapshot';
import type { HaConfigFlowStep } from '@/lib/matterConfigFlow';
import { prisma } from '@/lib/prisma';

export const FINAL_SESSION_STATUSES = new Set<MatterCommissioningStatus>([
  MatterCommissioningStatus.SUCCEEDED,
  MatterCommissioningStatus.FAILED,
  MatterCommissioningStatus.CANCELED,
]);

function toStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!value || !Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function parseHaStep(step: Prisma.JsonValue | null | undefined): HaConfigFlowStep | null {
  if (!step || typeof step !== 'object') return null;
  const obj = step as Record<string, unknown>;
  return {
    type: typeof obj.type === 'string' ? obj.type : 'unknown',
    flow_id: typeof obj.flow_id === 'string' ? obj.flow_id : undefined,
    handler: typeof obj.handler === 'string' ? obj.handler : undefined,
    step_id: typeof obj.step_id === 'string' ? obj.step_id : undefined,
    data_schema: obj.data_schema,
    description_placeholders:
      obj.description_placeholders && typeof obj.description_placeholders === 'object'
        ? (obj.description_placeholders as Record<string, unknown>)
        : undefined,
    errors:
      obj.errors && typeof obj.errors === 'object'
        ? (obj.errors as Record<string, string>)
        : undefined,
    progress_action: typeof obj.progress_action === 'string' ? obj.progress_action : undefined,
  };
}

function buildSnapshot(deviceIds: Prisma.JsonValue | null, entityIds: Prisma.JsonValue | null): RegistrySnapshot | null {
  const devices = toStringArray(deviceIds);
  const entities = toStringArray(entityIds);
  if (devices.length === 0 && entities.length === 0) return null;
  return { deviceIds: devices, entityIds: entities };
}

export function getSessionSnapshots(session: NewDeviceCommissioningSession) {
  return {
    before: buildSnapshot(session.beforeDeviceIds, session.beforeEntityIds),
    after: buildSnapshot(session.afterDeviceIds, session.afterEntityIds),
  };
}

export function hashCommissioningSecret(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex');
}

export function deriveStatusFromFlowStep(step: HaConfigFlowStep): MatterCommissioningStatus {
  switch (step.type) {
    case 'form':
      return MatterCommissioningStatus.NEEDS_INPUT;
    case 'progress':
      return MatterCommissioningStatus.IN_PROGRESS;
    case 'create_entry':
      return MatterCommissioningStatus.SUCCEEDED;
    case 'abort':
      return MatterCommissioningStatus.FAILED;
    default:
      return MatterCommissioningStatus.IN_PROGRESS;
  }
}

export async function findSessionForUser(
  sessionId: string,
  userId: number,
  opts?: { kind?: CommissioningKind }
) {
  return prisma.newDeviceCommissioningSession.findFirst({
    where: { id: sessionId, userId, ...(opts?.kind ? { kind: opts.kind } : {}) },
  });
}

export function shapeSessionResponse(session: NewDeviceCommissioningSession) {
  const before = buildSnapshot(session.beforeDeviceIds, session.beforeEntityIds);
  const after = buildSnapshot(session.afterDeviceIds, session.afterEntityIds);
  const lastHaStep = parseHaStep(session.lastHaStep);

  const diff = after ? diffRegistrySnapshots(before, after) : { newDeviceIds: [], newEntityIds: [] };

  return {
    id: session.id,
    status: session.status,
    kind: session.kind,
    requestedArea: session.requestedArea,
    requestedName: session.requestedName ?? null,
    requestedDinodiaType: session.requestedDinodiaType ?? null,
    requestedHaLabelId: session.requestedHaLabelId ?? null,
    requestedDisplayLabel: session.requestedDisplayLabel ?? null,
    requestedDisplayLabelKey: session.requestedDisplayLabelKey ?? null,
    requestedParentHaAreaId: session.requestedParentHaAreaId ?? null,
    requestedVirtualAreaId: session.requestedVirtualAreaId ?? null,
    requestedNewVirtualAreaName: session.requestedNewVirtualAreaName ?? null,
    haTechnicalName: session.haTechnicalName ?? null,
    haFlowId: session.haFlowId ?? null,
    error: session.error ?? null,
    lastHaStep,
    newDeviceIds: diff.newDeviceIds,
    newEntityIds: diff.newEntityIds,
    isFinal: FINAL_SESSION_STATUSES.has(session.status),
  };
}
