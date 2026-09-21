// Architecture: Shared platform helper src/lib/haLabels.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { HaWsClient } from '@/lib/haWebSocket';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { hashForLog, safeLog } from '@/lib/safeLogger';
import {
  TENANT_DEVICE_LABEL_ID,
  TENANT_DEVICE_LABEL_NAME,
  isTenantDeviceLabelValue,
} from '@/lib/tenantDeviceLabel';
export { TENANT_DEVICE_LABEL_ID, TENANT_DEVICE_LABEL_NAME, isTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';

export type HaLabel = {
  label_id: string;
  name: string;
};

type HaDeviceRegistryEntry = {
  id?: string;
  labels?: string[] | null;
};

type HaEntityRegistryEntry = {
  entity_id?: string;
  labels?: string[] | null;
};

function normalizeLabels(labels: string[] | null | undefined) {
  return Array.from(
    new Set(
      (labels ?? [])
        .filter((lbl) => typeof lbl === 'string')
        .map((lbl) => lbl.trim())
        .filter(Boolean)
    )
  );
}

function findMatchingLabel(
  labels: HaLabel[] | null | undefined,
  labelId: string,
  name?: string
) {
  const normalizedLabelId = labelId.trim();
  const normalizedName = name?.trim() ?? normalizedLabelId;
  return (labels ?? []).find((label) => {
    const entryId = typeof label?.label_id === 'string' ? label.label_id.trim() : '';
    const entryName = typeof label?.name === 'string' ? label.name.trim() : '';
    if (entryId && entryId === normalizedLabelId) return true;
    if (entryName && entryName.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0) return true;
    if (isTenantDeviceLabelValue(normalizedLabelId)) {
      return isTenantDeviceLabelValue(entryId) || isTenantDeviceLabelValue(entryName);
    }
    return false;
  });
}

export async function listHaLabels(ha: HaConnectionLike): Promise<HaLabel[]> {
  const client = await HaWsClient.connect(ha);
  try {
    const labels = await client.call<HaLabel[]>('config/label_registry/list');
    return (labels ?? [])
      .filter((label) => typeof label?.label_id === 'string')
      .map((label) => ({
        label_id: label.label_id,
        name: typeof label?.name === 'string' && label.name.trim().length > 0 ? label.name : label.label_id,
      }));
  } finally {
    client.close();
  }
}

export async function ensureHaLabel(
  ha: HaConnectionLike,
  labelId: string,
  name?: string
): Promise<{ ok: boolean; warning?: string; labelId?: string }> {
  const normalizedLabelId = labelId.trim();
  if (!normalizedLabelId) return { ok: false, warning: 'Missing Home Assistant label id.' };
  const normalizedName = name?.trim() || normalizedLabelId;
  const client = await HaWsClient.connect(ha);
  try {
    const labels = await client.call<HaLabel[]>('config/label_registry/list');
    const existing = findMatchingLabel(labels, normalizedLabelId, normalizedName);
    if (existing?.label_id?.trim()) return { ok: true, labelId: existing.label_id.trim() };
    const created = await client.call<HaLabel>('config/label_registry/create', {
      name: normalizedName,
    });
    const createdId = typeof created?.label_id === 'string' ? created.label_id.trim() : '';
    if (createdId) return { ok: true, labelId: createdId };
    const refreshed = await client.call<HaLabel[]>('config/label_registry/list');
    const resolved = findMatchingLabel(refreshed, normalizedLabelId, normalizedName);
    if (resolved?.label_id?.trim()) return { ok: true, labelId: resolved.label_id.trim() };
    return { ok: false, warning: 'Home Assistant created the label but did not return its id.' };
  } catch (err) {
    const warning =
      err instanceof Error && err.message
        ? err.message
        : 'Failed to ensure Home Assistant label exists.';
    safeLog('warn', '[haLabels] Failed to ensure label', {
      labelIdHash: hashForLog(normalizedLabelId),
      err,
    });
    return { ok: false, warning, labelId: undefined };
  } finally {
    client.close();
  }
}

async function applyLabelToDevices(
  client: HaWsClient,
  labelId: string,
  devices: HaDeviceRegistryEntry[],
  targetDeviceIds: string[]
) {
  const targetSet = new Set(targetDeviceIds.map((id) => id.trim()).filter(Boolean));
  for (const device of devices) {
    const id = typeof device.id === 'string' ? device.id.trim() : '';
    if (!id || !targetSet.has(id)) continue;
    const labels = normalizeLabels(device.labels);
    if (labels.includes(labelId)) continue;
    labels.push(labelId);
    await client.call('config/device_registry/update', {
      device_id: id,
      labels,
    });
  }
}

async function applyLabelToEntities(
  client: HaWsClient,
  labelId: string,
  entities: HaEntityRegistryEntry[],
  targetEntityIds: string[]
) {
  const targetSet = new Set(targetEntityIds.map((id) => id.trim()).filter(Boolean));
  for (const entity of entities) {
    const id = typeof entity.entity_id === 'string' ? entity.entity_id.trim() : '';
    if (!id || !targetSet.has(id)) continue;
    const labels = normalizeLabels(entity.labels);
    if (labels.includes(labelId)) continue;
    labels.push(labelId);
    await client.call('config/entity_registry/update', {
      entity_id: id,
      labels,
    });
  }
}

export async function applyHaLabel(
  ha: HaConnectionLike,
  labelId: string,
  targets: { deviceIds?: string[]; entityIds?: string[] }
): Promise<{ ok: boolean; warning?: string }> {
  const client = await HaWsClient.connect(ha);
  try {
    const [devices, entities] = await Promise.all([
      client.call<HaDeviceRegistryEntry[]>('config/device_registry/list'),
      client.call<HaEntityRegistryEntry[]>('config/entity_registry/list'),
    ]);

    await applyLabelToDevices(client, labelId, devices ?? [], targets.deviceIds ?? []);
    await applyLabelToEntities(client, labelId, entities ?? [], targets.entityIds ?? []);
    return { ok: true };
  } catch (err) {
    const warning =
      err instanceof Error && err.message
        ? err.message
        : 'Failed to apply HA label to new device/entities';
    safeLog('warn', '[haLabels] Failed to apply label', {
      labelIdHash: hashForLog(labelId),
      err,
    });
    return { ok: false, warning };
  } finally {
    client.close();
  }
}

async function removeLabelFromDevices(
  client: HaWsClient,
  labelId: string,
  devices: HaDeviceRegistryEntry[],
  targetDeviceIds: string[]
) {
  const targetSet = new Set(targetDeviceIds.map((id) => id.trim()).filter(Boolean));
  for (const device of devices) {
    const id = typeof device.id === 'string' ? device.id.trim() : '';
    if (!id || !targetSet.has(id)) continue;
    const labels = normalizeLabels(device.labels).filter((label) => label !== labelId);
    await client.call('config/device_registry/update', {
      device_id: id,
      labels,
    });
  }
}

async function removeLabelFromEntities(
  client: HaWsClient,
  labelId: string,
  entities: HaEntityRegistryEntry[],
  targetEntityIds: string[]
) {
  const targetSet = new Set(targetEntityIds.map((id) => id.trim()).filter(Boolean));
  for (const entity of entities) {
    const id = typeof entity.entity_id === 'string' ? entity.entity_id.trim() : '';
    if (!id || !targetSet.has(id)) continue;
    const labels = normalizeLabels(entity.labels).filter((label) => label !== labelId);
    await client.call('config/entity_registry/update', {
      entity_id: id,
      labels,
    });
  }
}

export async function applyTenantDeviceLabel(
  ha: HaConnectionLike,
  targets: { deviceIds?: string[]; entityIds?: string[] }
): Promise<{ ok: boolean; warning?: string }> {
  const ensure = await ensureHaLabel(ha, TENANT_DEVICE_LABEL_ID, TENANT_DEVICE_LABEL_NAME);
  const resolvedLabelId = ensure.labelId?.trim();
  if (!ensure.ok || !resolvedLabelId) {
    return {
      ok: false,
      warning: ensure.warning || 'Failed to ensure Home Assistant tenant label exists.',
    };
  }
  const apply = await applyHaLabel(ha, resolvedLabelId, targets);
  return {
    ok: apply.ok,
    warning: [ensure.warning, apply.warning].filter(Boolean).join(' ') || undefined,
  };
}

export async function removeHaLabelFromTargets(
  ha: HaConnectionLike,
  labelId: string,
  targets: { deviceIds?: string[]; entityIds?: string[] }
): Promise<{ ok: boolean; warning?: string }> {
  const client = await HaWsClient.connect(ha);
  try {
    const labels = await client.call<HaLabel[]>('config/label_registry/list');
    const resolvedLabelId =
      findMatchingLabel(
        labels,
        labelId,
        isTenantDeviceLabelValue(labelId) ? TENANT_DEVICE_LABEL_NAME : undefined
      )?.label_id?.trim() || labelId.trim();
    if (!resolvedLabelId) return { ok: true };
    const [devices, entities] = await Promise.all([
      client.call<HaDeviceRegistryEntry[]>('config/device_registry/list'),
      client.call<HaEntityRegistryEntry[]>('config/entity_registry/list'),
    ]);
    await removeLabelFromDevices(client, resolvedLabelId, devices ?? [], targets.deviceIds ?? []);
    await removeLabelFromEntities(client, resolvedLabelId, entities ?? [], targets.entityIds ?? []);
    return { ok: true };
  } catch (err) {
    const warning =
      err instanceof Error && err.message ? err.message : 'Failed to remove Home Assistant label.';
    safeLog('warn', '[haLabels] Failed to remove label', { labelIdHash: hashForLog(labelId), err });
    return { ok: false, warning };
  } finally {
    client.close();
  }
}
