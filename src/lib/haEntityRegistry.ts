// Architecture: Shared platform helper src/lib/haEntityRegistry.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { HaWsClient } from '@/lib/haWebSocket';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { hashForLog, safeLog } from '@/lib/safeLogger';

export type HaEntityRegistryEntry = {
  entity_id: string;
  device_id?: string | null;
  name?: string | null;
  original_name?: string | null;
  labels?: string[] | null;
};

export type HaEntityRenameResult = {
  ok: boolean;
  warning?: string;
  ignoredNotFoundCount: number;
  failedCount: number;
  hardErrors: string[];
};

function parseHaWsError(err: unknown): { code?: string; message?: string } {
  if (!err || typeof err !== 'object') return {};
  const maybeErr = err as {
    error?: { code?: unknown; message?: unknown };
    message?: unknown;
  };
  const code =
    typeof maybeErr.error?.code === 'string'
      ? maybeErr.error.code
      : undefined;
  const message =
    typeof maybeErr.error?.message === 'string'
      ? maybeErr.error.message
      : typeof maybeErr.message === 'string'
        ? maybeErr.message
        : err instanceof Error
          ? err.message
          : undefined;
  return { code, message };
}

function isEntityNotFoundError(err: unknown) {
  const parsed = parseHaWsError(err);
  return parsed.code === 'not_found' || parsed.message === 'Entity not found';
}

export async function getEntityRegistryEntriesForDevices(
  ha: HaConnectionLike,
  deviceIds: string[]
): Promise<HaEntityRegistryEntry[]> {
  const targetSet = new Set(deviceIds.map((id) => id.trim()).filter(Boolean));
  if (targetSet.size === 0) return [];
  const client = await HaWsClient.connect(ha);
  try {
    const entities = await client.call<HaEntityRegistryEntry[]>('config/entity_registry/list');
    return (entities ?? []).filter((entity) => {
      const deviceId = typeof entity.device_id === 'string' ? entity.device_id.trim() : '';
      return deviceId && targetSet.has(deviceId);
    });
  } finally {
    client.close();
  }
}

export async function renameHaEntitiesForTenantDevice(
  ha: HaConnectionLike,
  targets: { deviceIds: string[]; entityIds: string[] },
  haTechnicalName: string
): Promise<HaEntityRenameResult> {
  const entityIds = new Set(targets.entityIds.map((id) => id.trim()).filter(Boolean));
  const deviceEntries = await getEntityRegistryEntriesForDevices(ha, targets.deviceIds);
  for (const entry of deviceEntries) {
    if (entry.entity_id) entityIds.add(entry.entity_id);
  }
  if (entityIds.size === 0) {
    return { ok: true, ignoredNotFoundCount: 0, failedCount: 0, hardErrors: [] };
  }

  const client = await HaWsClient.connect(ha);
  const hardErrors: string[] = [];
  let ignoredNotFoundCount = 0;
  try {
    let index = 0;
    for (const entityId of entityIds) {
      index += 1;
      const domain = entityId.split('.')[0] || '';
      const name = entityIds.size === 1 ? haTechnicalName : `${haTechnicalName}_${index}`;
      const targetEntityId = domain ? `${domain}.${name}` : undefined;
      try {
        await client.call('config/entity_registry/update', {
          entity_id: entityId,
          name,
          ...(targetEntityId ? { new_entity_id: targetEntityId } : {}),
        });
      } catch (err) {
        if (isEntityNotFoundError(err)) {
          ignoredNotFoundCount += 1;
          safeLog('info', '[haEntityRegistry] Ignored stale tenant entity rename', {
            entityIdHash: hashForLog(entityId),
          });
          continue;
        }
        hardErrors.push(parseHaWsError(err).message || String(err));
        safeLog('warn', '[haEntityRegistry] Failed tenant entity rename', {
          entityIdHash: hashForLog(entityId),
          err,
        });
      }
    }
  } finally {
    client.close();
  }

  return {
    ok: hardErrors.length === 0,
    warning: hardErrors.length > 0 ? hardErrors.join('; ') : undefined,
    ignoredNotFoundCount,
    failedCount: hardErrors.length,
    hardErrors,
  };
}
