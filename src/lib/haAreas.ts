// Architecture: Shared platform helper src/lib/haAreas.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { HaWsClient } from '@/lib/haWebSocket';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { hashForLog, safeLog } from '@/lib/safeLogger';

type HaAreaEntry = {
  area_id?: string;
  name?: string;
};

export type HaArea = { area_id: string; name: string };

export type HaEntityAreaAssignResult = {
  ok: boolean;
  warning?: string;
  ignoredNotFoundCount: number;
  failedCount: number;
  hardErrors: string[];
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

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

export async function listHaAreaNames(ha: HaConnectionLike): Promise<string[]> {
  const client = await HaWsClient.connect(ha);
  try {
    const areas = await client.call<HaAreaEntry[]>('config/area_registry/list');
    const deduped = new Map<string, string>();
    for (const area of areas ?? []) {
      const name = typeof area?.name === 'string' ? area.name.trim() : '';
      if (!name) continue;
      const key = normalize(name);
      if (!deduped.has(key)) deduped.set(key, name);
    }
    return Array.from(deduped.values()).sort((a, b) => a.localeCompare(b));
  } finally {
    client.close();
  }
}

export async function listHaAreas(ha: HaConnectionLike): Promise<HaArea[]> {
  const client = await HaWsClient.connect(ha);
  try {
    const areas = await client.call<HaAreaEntry[]>('config/area_registry/list');
    return (areas ?? [])
      .map((area) => ({
        area_id: typeof area.area_id === 'string' ? area.area_id : '',
        name: typeof area.name === 'string' ? area.name.trim() : '',
      }))
      .filter((area) => area.area_id && area.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    client.close();
  }
}

export async function resolveHaAreaByNameOrId(
  ha: HaConnectionLike,
  value: string
): Promise<HaArea | null> {
  const normalizedValue = value.trim();
  if (!normalizedValue) return null;
  const areas = await listHaAreas(ha);
  return (
    areas.find(
      (area) =>
        area.area_id === normalizedValue || normalize(area.name) === normalize(normalizedValue)
    ) ?? null
  );
}

export async function assignHaAreaToDevices(
  ha: HaConnectionLike,
  areaName: string | null | undefined,
  deviceIds: string[]
): Promise<{ ok: boolean; warning?: string }> {
  const normalizedArea = typeof areaName === 'string' ? areaName.trim() : '';
  const targets = deviceIds.map((id) => id.trim()).filter(Boolean);
  if (!normalizedArea || targets.length === 0) {
    return { ok: true };
  }

  const client = await HaWsClient.connect(ha);
  try {
    const areas = await client.call<HaAreaEntry[]>('config/area_registry/list');
    const match = (areas ?? []).find((entry) => {
      const name = typeof entry.name === 'string' ? entry.name : '';
      return normalize(name) === normalize(normalizedArea);
    });
    if (!match?.area_id) {
      return { ok: false, warning: 'Area not found in Home Assistant.' };
    }

    await Promise.all(
      targets.map((deviceId) =>
        client.call('config/device_registry/update', {
          device_id: deviceId,
          area_id: match.area_id,
        })
      )
    );

    return { ok: true };
  } catch (err) {
    const warning =
      err instanceof Error && err.message
        ? err.message
        : 'Failed to assign the device to the selected area.';
    safeLog('warn', '[haAreas] Failed to assign area', {
      areaName,
      deviceIdHashes: deviceIds.map((deviceId) => hashForLog(deviceId)),
      err,
    });
    return { ok: false, warning };
  } finally {
    client.close();
  }
}

export async function assignHaAreaToEntities(
  ha: HaConnectionLike,
  areaNameOrId: string | null | undefined,
  entityIds: string[]
): Promise<HaEntityAreaAssignResult> {
  const normalizedArea = typeof areaNameOrId === 'string' ? areaNameOrId.trim() : '';
  const targets = entityIds.map((id) => id.trim()).filter(Boolean);
  if (!normalizedArea || targets.length === 0) {
    return { ok: true, ignoredNotFoundCount: 0, failedCount: 0, hardErrors: [] };
  }

  const client = await HaWsClient.connect(ha);
  try {
    const areas = await client.call<HaAreaEntry[]>('config/area_registry/list');
    const match = (areas ?? []).find((entry) => {
      const name = typeof entry.name === 'string' ? entry.name : '';
      const areaId = typeof entry.area_id === 'string' ? entry.area_id : '';
      return areaId === normalizedArea || normalize(name) === normalize(normalizedArea);
    });
    if (!match?.area_id) {
      return {
        ok: false,
        warning: 'Area not found in Home Assistant.',
        ignoredNotFoundCount: 0,
        failedCount: 1,
        hardErrors: ['Area not found in Home Assistant.'],
      };
    }

    const hardErrors: string[] = [];
    let ignoredNotFoundCount = 0;

    await Promise.all(
      targets.map(async (entityId) => {
        try {
          await client.call('config/entity_registry/update', {
            entity_id: entityId,
            area_id: match.area_id,
          });
        } catch (err) {
          if (isEntityNotFoundError(err)) {
            ignoredNotFoundCount += 1;
            safeLog('info', '[haAreas] Ignored stale entity area assignment', {
              areaNameOrId,
              entityIdHash: hashForLog(entityId),
            });
            return;
          }
          hardErrors.push(parseHaWsError(err).message || String(err));
          safeLog('warn', '[haAreas] Failed to assign entity area', {
            areaNameOrId,
            entityIdHashes: [hashForLog(entityId)],
            err,
          });
        }
      })
    );
    return {
      ok: hardErrors.length === 0,
      warning: hardErrors.length > 0 ? hardErrors.join('; ') : undefined,
      ignoredNotFoundCount,
      failedCount: hardErrors.length,
      hardErrors,
    };
  } catch (err) {
    const warning =
      err instanceof Error && err.message
        ? err.message
        : 'Failed to assign the entities to the selected area.';
    safeLog('warn', '[haAreas] Failed to assign entity area', {
      areaNameOrId,
      entityIdHashes: entityIds.map((entityId) => hashForLog(entityId)),
      err,
    });
    return { ok: false, warning, ignoredNotFoundCount: 0, failedCount: 1, hardErrors: [warning] };
  } finally {
    client.close();
  }
}
