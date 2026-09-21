// Architecture: Shared platform helper src/lib/haCleanup.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { Prisma } from '@prisma/client';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { callHaService } from '@/lib/homeAssistant';
import { deleteAutomation, listAutomationConfigs } from '@/lib/homeAssistantAutomations';
import { HaWsClient } from '@/lib/haWebSocket';
import { removeHaLabelFromTargets, TENANT_DEVICE_LABEL_ID } from '@/lib/haLabels';
import { prisma } from '@/lib/prisma';

const ERROR_SNIPPET_LIMIT = 240;
export const MAX_REGISTRY_REMOVALS = 200;

function toStringSet(value: Prisma.JsonValue | null | undefined) {
  const result = new Set<string>();
  if (!value || !Array.isArray(value)) return result;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    result.add(trimmed);
  }
  return result;
}

function safeError(err: unknown) {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : JSON.stringify(err ?? '');
  return text.length > ERROR_SNIPPET_LIMIT ? `${text.slice(0, ERROR_SNIPPET_LIMIT)}…` : text;
}

function isNotFoundError(err: unknown) {
  const message = safeError(err).toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('not_found') ||
    message.includes('404') ||
    message.includes('does not exist')
  );
}

export type CleanupTargets = {
  deviceIds: string[];
  entityIds: string[];
  skippedDeviceIds: number;
  skippedEntityIds: number;
};

export async function collectDinodiaEntityAndDeviceIds(haConnectionId: number): Promise<CleanupTargets> {
  const sessions = await prisma.newDeviceCommissioningSession.findMany({
    where: { haConnectionId },
    select: { beforeDeviceIds: true, beforeEntityIds: true, afterDeviceIds: true, afterEntityIds: true },
  });
  // Targets stay limited to Dinodia-run commissioning sessions (afterIds - beforeIds).

  const deviceIds = new Set<string>();
  const entityIds = new Set<string>();
  // No DB override tables are consulted; we only use IDs observed during our commissioning deltas.

  const isCoreOrNativeDeviceId = (id: string) => {
    const normalized = id.trim().toLowerCase();
    return normalized.startsWith('core_') || normalized.startsWith('core.') || normalized.startsWith('native_') || normalized.startsWith('native.');
  };

  for (const session of sessions) {
    const beforeDevices = toStringSet(session.beforeDeviceIds);
    const afterDevices = toStringSet(session.afterDeviceIds);
    const beforeEntities = toStringSet(session.beforeEntityIds);
    const afterEntities = toStringSet(session.afterEntityIds);

    afterDevices.forEach((id) => {
      if (!beforeDevices.has(id) && !isCoreOrNativeDeviceId(id)) {
        deviceIds.add(id);
      }
    });
    afterEntities.forEach((id) => {
      if (!beforeEntities.has(id)) {
        entityIds.add(id);
      }
    });
  }

  const sanitizedDevices = Array.from(deviceIds)
    .map((id) => id.trim())
    .filter(Boolean);
  const sanitizedEntities = Array.from(entityIds)
    .map((id) => id.trim())
    .filter(Boolean);

  const cappedDevices = sanitizedDevices.slice(0, MAX_REGISTRY_REMOVALS);
  const cappedEntities = sanitizedEntities.slice(0, MAX_REGISTRY_REMOVALS);

  return {
    deviceIds: cappedDevices,
    entityIds: cappedEntities,
    skippedDeviceIds: sanitizedDevices.length - cappedDevices.length,
    skippedEntityIds: sanitizedEntities.length - cappedEntities.length,
  };
}

export type AutomationCleanupResult = {
  targeted: number;
  deleted: number;
  failed: number;
  errors: string[];
  targetedIds: string[];
};

function sanitizeAutomationIds(ids: string[]) {
  return Array.from(
    new Set(
      ids
        .map((id) => id.trim().replace(/^automation\./i, ''))
        .filter(Boolean)
    )
  );
}

export async function deleteAutomationIds(
  ha: HaConnectionLike,
  automationIds: string[]
): Promise<AutomationCleanupResult> {
  const targets = sanitizeAutomationIds(automationIds);
  const result: AutomationCleanupResult = {
    targeted: targets.length,
    targetedIds: targets,
    deleted: 0,
    failed: 0,
    errors: [],
  };

  for (const automationId of targets) {
    try {
      await deleteAutomation(ha, automationId);
      result.deleted += 1;
    } catch (err) {
      const message = safeError(err).toLowerCase();
      const isNotFound = message.includes('not found') || message.includes('404');
      if (isNotFound) {
        result.deleted += 1;
        continue;
      }
      result.failed += 1;
      result.errors.push(safeError(err));
    }
  }

  return result;
}

export async function deleteDinodiaAutomations(
  ha: HaConnectionLike
): Promise<AutomationCleanupResult> {
  let automations: { id: string; entityId?: string }[] = [];
  try {
    automations = await listAutomationConfigs(ha);
  } catch (err) {
    return {
      targeted: 0,
      deleted: 0,
      failed: 0,
      errors: [safeError(err)],
      targetedIds: [],
    };
  }

  const targets = Array.from(
    new Set(
      automations
        .filter((a) => {
          const entityId = typeof a.entityId === 'string' ? a.entityId.trim() : '';
          if (!entityId) return true; // if missing, treat as deletable
          return !entityId.toLowerCase().includes('notify');
        })
        .map((a) => a.id.trim())
        .filter(Boolean)
    )
  );

  const result: AutomationCleanupResult = {
    targeted: targets.length,
    targetedIds: targets,
    deleted: 0,
    failed: 0,
    errors: [],
  };

  for (const automationId of targets) {
    try {
      await deleteAutomation(ha, automationId);
      result.deleted += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(safeError(err));
    }
  }

  return result;
}

export type RegistryRemovalResult = {
  targeted: number;
  removed: number;
  failed: number;
  errors: string[];
  skipped: number;
};

function sanitizeRegistryIds(ids: string[]) {
  const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (unique.length <= MAX_REGISTRY_REMOVALS) {
    return { ids: unique, skipped: 0 };
  }
  return {
    ids: unique.slice(0, MAX_REGISTRY_REMOVALS),
    skipped: unique.length - MAX_REGISTRY_REMOVALS,
  };
}

export async function removeEntitiesFromHaRegistry(
  ha: HaConnectionLike,
  entityIds: string[],
  client?: HaWsClient
): Promise<RegistryRemovalResult> {
  const { ids, skipped } = sanitizeRegistryIds(entityIds);
  const result: RegistryRemovalResult = {
    targeted: ids.length,
    removed: 0,
    failed: 0,
    errors: [],
    skipped,
  };

  if (ids.length === 0) return result;

  const ownsClient = !client;
  let ws = client;
  if (!ws) {
    try {
      ws = await HaWsClient.connect(ha);
    } catch (err) {
      return { ...result, failed: ids.length, errors: [safeError(err)] };
    }
  }

  try {
    for (const entityId of ids) {
      try {
        await ws.call('config/entity_registry/remove', { entity_id: entityId });
        result.removed += 1;
      } catch (err) {
        if (isNotFoundError(err)) {
          result.removed += 1;
          continue;
        }
        result.failed += 1;
        result.errors.push(safeError(err));
      }
    }
  } finally {
    if (ownsClient && ws) {
      ws.close();
    }
  }

  return result;
}

export async function removeDevicesFromHaRegistry(
  ha: HaConnectionLike,
  deviceIds: string[],
  client?: HaWsClient
): Promise<RegistryRemovalResult> {
  const { ids, skipped } = sanitizeRegistryIds(deviceIds);
  const result: RegistryRemovalResult = {
    targeted: ids.length,
    removed: 0,
    failed: 0,
    errors: [],
    skipped,
  };

  if (ids.length === 0) return result;

  const ownsClient = !client;
  let ws = client;
  if (!ws) {
    try {
      ws = await HaWsClient.connect(ha);
    } catch (err) {
      return { ...result, failed: ids.length, errors: [safeError(err)] };
    }
  }

  try {
    for (const deviceId of ids) {
      try {
        await ws.call('config/device_registry/remove', { device_id: deviceId });
        result.removed += 1;
      } catch (err) {
        if (isNotFoundError(err)) {
          result.removed += 1;
          continue;
        }
        result.failed += 1;
        result.errors.push(safeError(err));
      }
    }
  } finally {
    if (ownsClient && ws) {
      ws.close();
    }
  }

  return result;
}

export type TenantDeviceCleanupResult = {
  targetedDevices: number;
  targetedEntities: number;
  removedDevices: number;
  removedEntities: number;
  disabledEntities: number;
  hiddenEntities: number;
  labelsRemoved: number;
  failed: number;
  errors: string[];
};

async function updateEntityFlag(
  ws: HaWsClient,
  entityIds: string[],
  field: 'disabled_by' | 'hidden_by',
  value: string
) {
  let changed = 0;
  const errors: string[] = [];
  for (const entityId of entityIds) {
    try {
      await ws.call('config/entity_registry/update', {
        entity_id: entityId,
        [field]: value,
      });
      changed += 1;
    } catch (err) {
      if (isNotFoundError(err)) continue;
      errors.push(safeError(err));
    }
  }
  return { changed, errors };
}

export async function cleanupTenantOwnedHaTargets(
  ha: HaConnectionLike,
  targets: { deviceIds: string[]; entityIds: string[] }
): Promise<TenantDeviceCleanupResult> {
  const deviceIds = sanitizeRegistryIds(targets.deviceIds).ids;
  const entityIds = sanitizeRegistryIds(targets.entityIds).ids;
  const result: TenantDeviceCleanupResult = {
    targetedDevices: deviceIds.length,
    targetedEntities: entityIds.length,
    removedDevices: 0,
    removedEntities: 0,
    disabledEntities: 0,
    hiddenEntities: 0,
    labelsRemoved: 0,
    failed: 0,
    errors: [],
  };

  const ws = await HaWsClient.connect(ha);
  try {
    const entities = await removeEntitiesFromHaRegistry(ha, entityIds, ws);
    const devices = await removeDevicesFromHaRegistry(ha, deviceIds, ws);
    result.removedEntities = entities.removed;
    result.removedDevices = devices.removed;
    result.errors.push(...entities.errors, ...devices.errors);

    const failedEntityIds = entities.failed > 0 ? entityIds : [];
    if (failedEntityIds.length > 0) {
      const disabled = await updateEntityFlag(ws, failedEntityIds, 'disabled_by', 'user');
      result.disabledEntities = disabled.changed;
      result.errors.push(...disabled.errors);
      const hidden = await updateEntityFlag(ws, failedEntityIds, 'hidden_by', 'user');
      result.hiddenEntities = hidden.changed;
      result.errors.push(...hidden.errors);
    }
  } finally {
    ws.close();
  }

  const labelResult = await removeHaLabelFromTargets(ha, TENANT_DEVICE_LABEL_ID, {
    deviceIds,
    entityIds,
  });
  if (labelResult.ok) {
    result.labelsRemoved = deviceIds.length + entityIds.length;
  } else if (labelResult.warning) {
    result.errors.push(labelResult.warning);
  }

  result.failed = result.errors.length;
  return result;
}

export class HaCleanupConnectionError extends Error {
  constructor(message: string, public readonly reasons: string[] = []) {
    super(message);
    this.name = 'HaCleanupConnectionError';
  }
}

export type HaCleanupSummary = {
  targets: { entityIds: string[]; deviceIds: string[]; automations: string[] };
  automations: AutomationCleanupResult;
  entities: RegistryRemovalResult;
  devices: RegistryRemovalResult;
  endpointUsed: string;
  guardrails: {
    maxRegistryRemovals: number;
    skippedDeviceIds: number;
    skippedEntityIds: number;
  };
};

export type HaCloudLogoutResult = {
  attempted: string[];
  succeeded: string[];
  failed: string[];
  errors: string[];
  endpointUsed: string | null;
};

export async function logoutHaCloud(
  haConnection: { baseUrl: string; cloudUrl: string | null; longLivedToken: string },
  preferredBaseUrl?: string | null
): Promise<HaCloudLogoutResult> {
  const candidates: HaConnectionLike[] = [];
  const token = haConnection.longLivedToken;
  const cloudUrl = haConnection.cloudUrl?.trim();
  const baseUrl = haConnection.baseUrl?.trim();
  const preferred = preferredBaseUrl?.trim();

  if (preferred) {
    candidates.push({ baseUrl: preferred, longLivedToken: token });
  }
  if (cloudUrl && !candidates.some((c) => c.baseUrl === cloudUrl)) {
    candidates.push({ baseUrl: cloudUrl, longLivedToken: token });
  }
  if (baseUrl && !candidates.some((c) => c.baseUrl === baseUrl)) {
    candidates.push({ baseUrl, longLivedToken: token });
  }

  const services = [{ domain: 'cloud', service: 'logout' }];

  const attempted: string[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];

  for (const candidate of candidates) {
    for (const svc of services) {
      const key = `${svc.domain}.${svc.service}`;
      attempted.push(key);
      try {
        await callHaService(candidate, svc.domain, svc.service);
        succeeded.push(key);
        return { attempted, succeeded, failed, errors, endpointUsed: candidate.baseUrl };
      } catch (err) {
        failed.push(key);
        errors.push(safeError(err));
      }
    }
  }

  return { attempted, succeeded, failed, errors, endpointUsed: null };
}

export async function performHaCleanup(
  haConnection: { baseUrl: string; cloudUrl: string | null; longLivedToken: string },
  haConnectionId: number
): Promise<HaCleanupSummary> {
  const { entityIds, deviceIds, skippedDeviceIds, skippedEntityIds } =
    await collectDinodiaEntityAndDeviceIds(haConnectionId);

  const candidates: HaConnectionLike[] = [];
  const token = haConnection.longLivedToken;
  const cloudUrl = haConnection.cloudUrl?.trim();
  const baseUrl = haConnection.baseUrl?.trim();

  if (cloudUrl) {
    candidates.push({ baseUrl: cloudUrl, longLivedToken: token });
  }
  if (baseUrl && !candidates.some((c) => c.baseUrl === baseUrl)) {
    candidates.push({ baseUrl, longLivedToken: token });
  }

  const connectionErrors: string[] = [];
  let wsClient: HaWsClient | null = null;
  let ha: HaConnectionLike | null = null;

  for (const candidate of candidates) {
    try {
      wsClient = await HaWsClient.connect(candidate);
      ha = candidate;
      break;
    } catch (err) {
      connectionErrors.push(safeError(err));
    }
  }

  if (!ha || !wsClient) {
    throw new HaCleanupConnectionError('Remote access is required to reset this home', connectionErrors);
  }

  try {
    const automations = await deleteDinodiaAutomations(ha);
    const entities = await removeEntitiesFromHaRegistry(ha, entityIds, wsClient);
    const devices = await removeDevicesFromHaRegistry(ha, deviceIds, wsClient);

    return {
      targets: {
        entityIds,
        deviceIds,
        automations: automations.targetedIds,
      },
      automations,
      entities,
      devices,
      endpointUsed: ha.baseUrl,
      guardrails: {
        maxRegistryRemovals: MAX_REGISTRY_REMOVALS,
        skippedDeviceIds,
        skippedEntityIds,
      },
    };
  } finally {
    wsClient.close();
  }
}

export async function performTenantOwnedHaCleanup(
  haConnection: { baseUrl: string; cloudUrl: string | null; longLivedToken: string },
  targets: { entityIds: string[]; deviceIds: string[]; automationIds: string[] }
): Promise<HaCleanupSummary> {
  const candidates: HaConnectionLike[] = [];
  const token = haConnection.longLivedToken;
  const cloudUrl = haConnection.cloudUrl?.trim();
  const baseUrl = haConnection.baseUrl?.trim();

  if (cloudUrl) {
    candidates.push({ baseUrl: cloudUrl, longLivedToken: token });
  }
  if (baseUrl && !candidates.some((candidate) => candidate.baseUrl === baseUrl)) {
    candidates.push({ baseUrl, longLivedToken: token });
  }

  const connectionErrors: string[] = [];
  let wsClient: HaWsClient | null = null;
  let ha: HaConnectionLike | null = null;

  for (const candidate of candidates) {
    try {
      wsClient = await HaWsClient.connect(candidate);
      ha = candidate;
      break;
    } catch (err) {
      connectionErrors.push(safeError(err));
    }
  }

  if (!ha || !wsClient) {
    throw new HaCleanupConnectionError('Remote access is required to reset this home', connectionErrors);
  }

  try {
    const automations = await deleteAutomationIds(ha, targets.automationIds);
    const entities = await removeEntitiesFromHaRegistry(ha, targets.entityIds, wsClient);
    const devices = await removeDevicesFromHaRegistry(ha, targets.deviceIds, wsClient);

    return {
      targets: {
        entityIds: Array.from(new Set(targets.entityIds.map((id) => id.trim()).filter(Boolean))),
        deviceIds: Array.from(new Set(targets.deviceIds.map((id) => id.trim()).filter(Boolean))),
        automations: automations.targetedIds,
      },
      automations,
      entities,
      devices,
      endpointUsed: ha.baseUrl,
      guardrails: {
        maxRegistryRemovals: MAX_REGISTRY_REMOVALS,
        skippedDeviceIds: 0,
        skippedEntityIds: 0,
      },
    };
  } finally {
    wsClient.close();
  }
}
