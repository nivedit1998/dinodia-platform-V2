// Architecture: Shared platform helper src/lib/triggerDevices.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getTenantInventoryBootstrap, buildHaCandidates } from '@/lib/tenantInventoryBootstrap';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getTenantDashboardDevices } from '@/lib/deviceCapabilities';
import { getDeviceGroupingId } from '@/lib/deviceIdentity';
import { isIgnoredDashboardHelperEntity } from '@/lib/dashboardEntityFilters';
import { ensureDinodiaRemoteManagerBootstrap } from '@/lib/haConfigFlow';
import { safeLog } from '@/lib/safeLogger';
import { isTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';
import {
  callHaService,
  getDeviceRegistryMetadata,
  type HaConnectionLike,
  type HaDeviceRegistryMetadata,
} from '@/lib/homeAssistant';
import {
  REMOTE_BINDING_UPDATE_TIMEOUT_MS,
  REMOTE_TRIGGER_INVENTORY_TIMEOUT_MS,
  REMOTE_MANAGER_DOMAIN,
  SERVICE_LIST_BINDINGS,
  SERVICE_LIST_TRIGGER_DEVICE_DASHBOARD,
  SERVICE_REMOVE_TENANT_BINDINGS,
  SERVICE_REMOVE_TRIGGER_BINDINGS_FOR_DEVICES,
  SERVICE_SET_TRIGGER_TARGET,
  SERVICE_UNBIND,
} from '@/lib/remoteManager';
import type {
  TriggerDeviceBindingSummary,
  TriggerDeviceCapabilitySummary,
  TriggerDeviceResolutionState,
  TriggerDeviceSummary,
  TriggerDeviceTargetSummary,
  TriggerTargetOption,
} from '@/types/triggerDevice';

function normalize(value: string | null | undefined) {
  return (value ?? '').toString().trim();
}

function normalizeIdentifier(value: string | null | undefined) {
  return normalize(value).toLowerCase();
}

function normalizeLabelList(labels: Array<string | null | undefined> | null | undefined) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels ?? []) {
    const cleaned = normalize(label);
    if (!cleaned) continue;
    const key = normalizeIdentifier(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && /timeout|timed out|abort/i.test(error.message);
}

function isRemoteManagerUnavailableError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('service not found') ||
    message.includes('action not found') ||
    message.includes('unknown command') ||
    message.includes('ha service error 404') ||
    (message.includes('ha service error 400') && message.includes('bad request'))
  );
}

function firstArea(device: { displayAreaName?: string | null; area?: string | null; areaName?: string | null }) {
  return normalize(device.displayAreaName ?? device.areaName ?? device.area) || null;
}

function compactServiceData(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null && value !== undefined && value !== '')
  );
}

type DeviceSnapshot = Awaited<ReturnType<typeof getDevicesForHaConnection>>;
type DeviceSnapshotItem = DeviceSnapshot[number];

type TriggerBindingUpdateResponse = {
  binding?: TriggerDeviceBindingSummary | null;
  capability?: TriggerDeviceCapabilitySummary | null;
  target?: TriggerDeviceTargetSummary | null;
  resolutionState?: TriggerDeviceResolutionState;
  triggerDevice?: TriggerDeviceSummary | null;
  configEntry?: { entryId?: string | null; created?: boolean; updated?: boolean; error?: string | null } | null;
  verified?: boolean;
  retryInBackground?: boolean;
  listener?: Record<string, unknown> | null;
  duplicateCleanup?: Record<string, unknown> | null;
};

type TriggerDeviceDashboardInventoryItem = {
  device_id: string;
  accepted?: boolean;
  name?: string | null;
  area_id?: string | null;
  area_name?: string | null;
  labels?: string[];
  source_entity_id?: string | null;
  trigger_count?: number;
  entity_ids?: string[];
  binding?: TriggerDeviceBindingSummary | null;
  capability?: TriggerDeviceCapabilitySummary | null;
  target?: {
    targetId?: string | null;
    deviceId?: string | null;
    entityId?: string | null;
    name?: string | null;
    domain?: string | null;
    areaName?: string | null;
    labels?: string[];
  } | null;
  resolution_state?: string | null;
};

type TriggerDeviceDashboardInventoryResponse = {
  trigger_devices?: TriggerDeviceDashboardInventoryItem[];
};

const TRIGGER_DEVICE_DASHBOARD_CACHE_TTL_MS = 10_000;
const TRIGGER_DEVICE_DASHBOARD_STALE_TTL_MS = 5 * 60_000;

type TriggerDashboardCacheEntry = {
  expiresAt: number;
  staleUntil: number;
  items: TriggerDeviceDashboardInventoryItem[];
  inFlight?: Promise<TriggerDeviceDashboardInventoryItem[]>;
};

const triggerDashboardCache = new Map<string, TriggerDashboardCacheEntry>();

async function callRemoteManagerServiceWithBootstrap<T>(
  candidate: HaConnectionLike,
  service: string,
  data: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  try {
    return (await callHaService(
      candidate,
      REMOTE_MANAGER_DOMAIN,
      service,
      compactServiceData(data),
      timeoutMs,
      { returnResponse: true }
    )) as T;
  } catch (err) {
    if (!isRemoteManagerUnavailableError(err)) throw err;
    await ensureDinodiaRemoteManagerBootstrap(candidate);
    return (await callHaService(
      candidate,
      REMOTE_MANAGER_DOMAIN,
      service,
      compactServiceData(data),
      timeoutMs,
      { returnResponse: true }
    )) as T;
  }
}

async function listTriggerDeviceDashboardInventory(
  candidate: HaConnectionLike,
  deviceId?: string | null
): Promise<TriggerDeviceDashboardInventoryItem[]> {
  const result = await callRemoteManagerServiceWithBootstrap<TriggerDeviceDashboardInventoryResponse | null | undefined>(
    candidate,
    SERVICE_LIST_TRIGGER_DEVICE_DASHBOARD,
    { remote_device_id: normalize(deviceId) || null },
    REMOTE_TRIGGER_INVENTORY_TIMEOUT_MS
  );
  const typed = result as TriggerDeviceDashboardInventoryResponse | null | undefined;
  return Array.isArray(typed?.trigger_devices) ? typed.trigger_devices : [];
}

function triggerInventoryCacheKey(candidate: HaConnectionLike) {
  return normalize(candidate.baseUrl).replace(/\/+$/, '').toLowerCase();
}

export function clearTriggerDeviceInventoryCache(candidate?: HaConnectionLike | null) {
  if (!candidate) {
    triggerDashboardCache.clear();
    return;
  }
  triggerDashboardCache.delete(triggerInventoryCacheKey(candidate));
}

async function getCachedTriggerDeviceDashboardInventory(
  candidate: HaConnectionLike,
  options: { force?: boolean; deviceId?: string | null } = {}
): Promise<TriggerDeviceDashboardInventoryItem[]> {
  const key = `${triggerInventoryCacheKey(candidate)}::${normalize(options.deviceId) || 'all'}`;
  const now = Date.now();
  const cached = triggerDashboardCache.get(key);

  if (!options.force && cached?.items && cached.expiresAt > now) {
    return cached.items;
  }

  if (!options.force && cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = listTriggerDeviceDashboardInventory(candidate, options.deviceId)
    .then((items) => {
      triggerDashboardCache.set(key, {
        items,
        expiresAt: Date.now() + TRIGGER_DEVICE_DASHBOARD_CACHE_TTL_MS,
        staleUntil: Date.now() + TRIGGER_DEVICE_DASHBOARD_STALE_TTL_MS,
      });
      return items;
    })
    .catch((err) => {
      const staleAgeMs = cached?.staleUntil ? cached.staleUntil - Date.now() : 0;
      if (staleAgeMs <= 0) {
        safeLog('warn', '[triggerDevices] cached trigger inventory refresh failed', { err });
      }
      const fallbackItems = cached?.staleUntil && cached.staleUntil > Date.now() ? cached.items : [];
      triggerDashboardCache.set(key, {
        items: fallbackItems,
        expiresAt: fallbackItems.length > 0 ? Date.now() + Math.min(TRIGGER_DEVICE_DASHBOARD_CACHE_TTL_MS, 5_000) : 0,
        staleUntil: cached?.staleUntil ?? 0,
      });
      return fallbackItems;
    });

  triggerDashboardCache.set(key, {
    items: cached?.items ?? [],
    expiresAt: cached?.expiresAt ?? 0,
    staleUntil: cached?.staleUntil ?? 0,
    inFlight,
  });

  return inFlight;
}

function triggerDeviceIsVisible(args: {
  triggerDeviceId: string;
  triggerAreaName: string | null;
  allDevices: DeviceSnapshot;
  ownTenantOwnedEntityIds: Set<string>;
  allTenantOwnedEntityIds: Set<string>;
  hasAreaAccess: (area: string | null | undefined) => boolean;
}) {
  const {
    triggerDeviceId,
    triggerAreaName,
    allDevices,
    ownTenantOwnedEntityIds,
    allTenantOwnedEntityIds,
    hasAreaAccess,
  } = args;
  const deviceMatches = allDevices.filter((device) => normalize(device.deviceId) === triggerDeviceId);
  if (deviceMatches.some((device) => ownTenantOwnedEntityIds.has(device.entityId))) return true;
  if (deviceMatches.some((device) => allTenantOwnedEntityIds.has(device.entityId))) return false;

  const representative = deviceMatches[0] ?? null;
  const areaName = normalize(triggerAreaName) || firstArea(representative ?? {}) || null;
  return hasAreaAccess(areaName);
}

function buildUnavailableTargetSummary(): TriggerDeviceTargetSummary {
  return {
    targetId: 'unavailable',
    entityId: null,
    deviceId: null,
    name: 'Target unavailable',
    domain: 'unknown',
    areaName: null,
    label: null,
    labelCategory: null,
    state: 'unavailable',
  };
}

function buildTargetSummaryFromDashboardRow(
  row: TriggerDeviceDashboardInventoryItem,
  fallback: TriggerDeviceTargetSummary | null
): TriggerDeviceTargetSummary | null {
  if (row.target) {
    return {
      targetId: normalize(row.target.targetId) || normalize(row.target.deviceId) || normalize(row.target.entityId) || 'target',
      entityId: normalize(row.target.entityId) || null,
      deviceId: normalize(row.target.deviceId) || null,
      name: normalize(row.target.name) || 'Target unavailable',
      domain: normalize(row.target.domain) || 'unknown',
      areaName: normalize(row.target.areaName) || null,
      label: normalizeLabelList(row.target.labels)[0] ?? null,
      labelCategory: normalizeLabelList(row.target.labels)[0] ?? null,
      state: 'unknown',
    };
  }
  if (row.resolution_state === 'target_unavailable') {
    return buildUnavailableTargetSummary();
  }
  return fallback;
}

function buildResolvedTargetSummary(args: {
  row: TriggerDeviceDashboardInventoryItem;
  fallback: TriggerDeviceTargetSummary | null;
  devices: DeviceSnapshot;
  registryByDeviceId: Map<string, HaDeviceRegistryMetadata>;
}) {
  const base = buildTargetSummaryFromDashboardRow(args.row, args.fallback);
  if (!base) return null;

  const group = getDeviceGroup(args.devices, base.deviceId, base.entityId);
  if (group.length === 0) return base;

  const representative =
    group.find((device) => normalize(device.entityId) === normalize(base.entityId)) ??
    getRepresentativeEntity(group, null, args.devices) ??
    group[0];
  const registryItem = base.deviceId ? args.registryByDeviceId.get(normalize(base.deviceId)) ?? null : null;
  const label = getTargetOptionLabel(representative);

  return {
    ...base,
    name: chooseTargetDisplayName({
      group,
      representative,
      registryItem,
      fallback: base.name,
    }),
    areaName: firstArea(representative) ?? base.areaName,
    label,
    labelCategory: label,
  };
}

function getDeviceGroup(devices: DeviceSnapshot, deviceId: string | null, entityId: string | null) {
  const normalizedDeviceId = normalize(deviceId);
  const normalizedEntityId = normalize(entityId);

  if (normalizedDeviceId) {
    const group = devices.filter((device) => normalize(device.deviceId) === normalizedDeviceId);
    if (group.length > 0) return group;
  }

  if (normalizedEntityId) {
    const matched = devices.find((device) => normalize(device.entityId) === normalizedEntityId);
    if (matched?.deviceId) {
      const group = devices.filter((device) => normalize(device.deviceId) === normalize(matched.deviceId));
      if (group.length > 0) return group;
    }
    if (matched) return [matched];
  }

  return [];
}

function getEntityLabels(device: DeviceSnapshotItem) {
  const entityLabels = normalizeLabelList(device.entityLabels);
  if (entityLabels.length > 0) return entityLabels;
  if (device.entityLabels === undefined && device.deviceLabels === undefined) {
    return normalizeLabelList([device.sourceTechnicalLabel]);
  }
  return [];
}

function getDeviceLevelLabels(group: DeviceSnapshot) {
  return normalizeLabelList(group.flatMap((device) => device.deviceLabels ?? []));
}

function chooseTargetDisplayName(args: {
  group: DeviceSnapshot;
  representative: DeviceSnapshotItem | null;
  registryItem?: HaDeviceRegistryMetadata | null;
  inventoryItem?: { name?: string | null } | null;
  fallback?: string | null;
}) {
  const { group, representative, registryItem, inventoryItem, fallback } = args;
  const displayOverride = normalize(
    group.find((device) => normalize(device.displayName) && device.displayName !== device.entityId)?.displayName
  );
  if (displayOverride) return displayOverride;

  const registryNameByUser = normalize(registryItem?.name_by_user);
  if (registryNameByUser) return registryNameByUser;

  const inventoryName = normalize(inventoryItem?.name);
  if (inventoryName) return inventoryName;

  const registryName = normalize(registryItem?.name);
  if (registryName) return registryName;

  const nonHelper = group.find((device) => !isIgnoredDashboardHelperEntity(device));
  const nonHelperName = normalize(nonHelper?.displayName) || normalize(nonHelper?.name);
  if (nonHelperName) return nonHelperName;

  const representativeName = normalize(representative?.displayName) || normalize(representative?.name);
  if (representativeName) return representativeName;

  return normalize(fallback) || 'Target unavailable';
}

function getRepresentativeEntity(
  deviceMatches: DeviceSnapshot,
  fallbackEntityId: string | null,
  allDevices: DeviceSnapshot
) {
  return (
    deviceMatches.find((device) => device.domain !== 'sensor' && device.domain !== 'binary_sensor') ??
    deviceMatches[0] ??
    allDevices.find((device) => normalize(device.entityId) === normalize(fallbackEntityId)) ??
    null
  );
}

function getEffectiveHaLabels(args: {
  deviceMatches: DeviceSnapshot;
  inventoryItem: { labels?: string[] } | null;
  registryItem: HaDeviceRegistryMetadata | null;
}) {
  return normalizeLabelList([
    ...args.deviceMatches.flatMap((device) => device.technicalLabels ?? device.labels ?? []),
    ...args.deviceMatches.map((device) => device.sourceTechnicalLabel),
    ...(args.inventoryItem?.labels ?? []),
    ...(args.registryItem?.labels ?? []),
  ]);
}

function groupDevicesByDeviceId(devices: DeviceSnapshot) {
  const map = new Map<string, DeviceSnapshotItem[]>();
  for (const device of devices) {
    const deviceId = normalize(device.deviceId);
    if (!deviceId) continue;
    if (!map.has(deviceId)) map.set(deviceId, []);
    map.get(deviceId)!.push(device);
  }
  return map;
}

function makeTargetOptionId(deviceId: string, entityId: string, label: string) {
  return `${deviceId}::${entityId}::${normalizeIdentifier(label)}`;
}

function getTargetOptionLabel(device: DeviceSnapshotItem) {
  return (
    normalize(device.displayLabel) ||
    getEntityLabels(device)[0] ||
    getDeviceLevelLabels([device])[0] ||
    normalize(device.label) ||
    normalize(device.labelCategory) ||
    'Device'
  );
}

function targetDeviceIsVisibleToTenant(args: {
  device: DeviceSnapshotItem;
  ownTenantOwnedEntityIds: Set<string>;
  allTenantOwnedEntityIds: Set<string>;
  hasAreaAccess: (area: string | null | undefined) => boolean;
}) {
  const { device, ownTenantOwnedEntityIds, allTenantOwnedEntityIds, hasAreaAccess } = args;
  if (device.ownership === 'pending_cleanup') return false;
  if (ownTenantOwnedEntityIds.has(device.entityId)) return true;
  if (allTenantOwnedEntityIds.has(device.entityId)) return false;
  return hasAreaAccess(firstArea(device));
}

function buildTriggerTargetOptionsForTenant(args: {
  devices: DeviceSnapshot;
  ownTenantOwnedEntityIds: Set<string>;
  allTenantOwnedEntityIds: Set<string>;
  hasAreaAccess: (area: string | null | undefined) => boolean;
  acceptedTriggerDeviceIds: Set<string>;
}) {
  const visibleDashboardDevices = getTenantDashboardDevices(
    args.devices.filter((device) =>
      targetDeviceIsVisibleToTenant({
        device,
        ownTenantOwnedEntityIds: args.ownTenantOwnedEntityIds,
        allTenantOwnedEntityIds: args.allTenantOwnedEntityIds,
        hasAreaAccess: args.hasAreaAccess,
      })
    )
  );

  const options: TriggerTargetOption[] = visibleDashboardDevices.flatMap((device) => {
    const acceptedIdentities = [
      normalize(device.deviceId),
      normalize(getDeviceGroupingId(device) ?? ''),
      normalize(device.entityId),
    ].filter(Boolean);
    if (acceptedIdentities.some((identity) => args.acceptedTriggerDeviceIds.has(identity))) {
      return [];
    }

    const label = getTargetOptionLabel(device);
    const groupingId = normalize(getDeviceGroupingId(device) ?? '') || normalize(device.entityId);
    const targetDeviceId = normalize(device.deviceId) || normalize(device.entityId);
    const deviceName = normalize(device.displayName) || normalize(device.name) || targetDeviceId;

    return [{
      optionId: makeTargetOptionId(groupingId || targetDeviceId, device.entityId, label),
      targetDeviceId,
      targetEntityId: device.entityId,
      deviceName,
      areaName: firstArea(device),
      label,
      domain: device.domain,
      state: device.state,
    }];
  });

  options.sort((left, right) => {
    const areaDelta = (left.areaName ?? '').localeCompare(right.areaName ?? '');
    if (areaDelta !== 0) return areaDelta;
    const labelDelta = left.label.localeCompare(right.label);
    if (labelDelta !== 0) return labelDelta;
    return left.deviceName.localeCompare(right.deviceName);
  });
  return options;
}

function chooseTriggerDeviceDisplayName(args: {
  deviceMatches: DeviceSnapshot;
  representative: DeviceSnapshotItem | null;
  registryItem: HaDeviceRegistryMetadata | null;
  inventoryItem: { name?: string | null } | null;
  triggerDeviceId: string;
}) {
  return chooseTargetDisplayName({
    group: args.deviceMatches,
    representative: args.representative,
    registryItem: args.registryItem,
    inventoryItem: args.inventoryItem,
    fallback: args.triggerDeviceId,
  });
}

async function loadContext(userId: number, fresh: boolean) {
  const bootstrap = await getTenantInventoryBootstrap(userId, {
    fresh,
    includeServicesForTarget: false,
  });

  return {
    user: bootstrap.user,
    haConnection: bootstrap.haConnection,
    allDevices: bootstrap.allDevices,
    labelledDevices: bootstrap.labelledDevices,
    candidates: buildHaCandidates(bootstrap.haConnection),
    allTenantOwnedEntityIds: bootstrap.allTenantOwnedEntityIds,
    ownTenantOwnedEntityIds: bootstrap.ownTenantOwnedEntityIds,
    hasAreaAccess: bootstrap.hasAreaAccess,
  };
}

async function chooseCandidateForUpdate(candidates: HaConnectionLike[]) {
  return candidates;
}

export async function getTriggerDeviceDashboardContextForTenant(args: {
  userId: number;
  fresh?: boolean;
  includeTargetOptions?: boolean;
}): Promise<{
  triggerDevices: TriggerDeviceSummary[];
  targetOptions: TriggerTargetOption[];
  acceptedTriggerDeviceIds: string[];
}> {
  const {
    allDevices,
    labelledDevices,
    candidates,
    allTenantOwnedEntityIds,
    ownTenantOwnedEntityIds,
    hasAreaAccess,
  } = await loadContext(args.userId, args.fresh === true);

  const entitiesByDeviceId = groupDevicesByDeviceId(allDevices);
  let triggerDashboardInventory: TriggerDeviceDashboardInventoryItem[] = [];
  let registryMetadata: HaDeviceRegistryMetadata[] = [];

  for (const candidate of candidates) {
    const inventory = await getCachedTriggerDeviceDashboardInventory(candidate, { force: args.fresh === true });
    if (inventory.length > 0) {
      triggerDashboardInventory = inventory;
      break;
    }
  }

  for (const candidate of candidates) {
    try {
      registryMetadata = await getDeviceRegistryMetadata(candidate);
      if (registryMetadata.length > 0) break;
    } catch (err) {
      safeLog('warn', '[triggerDevices] Device registry metadata unavailable', { err });
      registryMetadata = [];
    }
  }

  const inventoryByDeviceId = new Map(
    triggerDashboardInventory
      .filter((item) => normalize(item.device_id))
      .map((item) => [normalize(item.device_id), item])
  );
  const registryByDeviceId = new Map(
    registryMetadata
      .filter((item) => normalize(item.id))
      .map((item) => [normalize(item.id), item])
  );

  const candidateDeviceIds = new Set(
    triggerDashboardInventory
      .filter((item) => normalize(item.device_id))
      .filter((item) => (item.trigger_count ?? 0) > 0)
      .map((item) => normalize(item.device_id))
  );

  const summaries: TriggerDeviceSummary[] = [];
  for (const triggerDeviceId of candidateDeviceIds) {
    const deviceMatches = entitiesByDeviceId.get(triggerDeviceId) ?? [];
    const representative = getRepresentativeEntity(deviceMatches, null, allDevices);
    const inventoryItem = inventoryByDeviceId.get(triggerDeviceId) ?? null;
    const registryItem = registryByDeviceId.get(triggerDeviceId) ?? null;
    const effectiveHaLabels = normalizeLabelList([
      ...(inventoryItem?.labels ?? []),
      ...getEffectiveHaLabels({ deviceMatches, inventoryItem: null, registryItem }),
    ]);

    if (!inventoryItem || (inventoryItem.trigger_count ?? 0) <= 0) {
      continue;
    }

    const triggerAreaName =
      firstArea(representative ?? {}) ||
      normalize(inventoryItem.area_name) ||
      null;
    if (
      !triggerDeviceIsVisible({
        triggerDeviceId,
        triggerAreaName,
        allDevices,
        ownTenantOwnedEntityIds,
        allTenantOwnedEntityIds,
        hasAreaAccess,
      })
    ) {
      continue;
    }

    const resolvedBinding = inventoryItem.binding ?? null;
    const capability = inventoryItem.capability ?? null;
    let resolutionState = (normalize(inventoryItem.resolution_state) || (resolvedBinding ? 'target_unresolved' : 'unbound')) as TriggerDeviceResolutionState;
    const target = buildResolvedTargetSummary({
      row: inventoryItem,
      fallback: null,
      devices: allDevices,
      registryByDeviceId,
    });
    if (target?.name === 'Target unavailable') {
      resolutionState = 'target_unavailable';
    }

    const visualLabel =
      normalize(representative?.displayLabel) ||
      effectiveHaLabels.find((label) => !isTenantDeviceLabelValue(label)) ||
      effectiveHaLabels[0] ||
      'Trigger';
    const labels = effectiveHaLabels.length > 0 ? effectiveHaLabels : [visualLabel];
    const displayName =
      normalize(inventoryItem.name) ||
      chooseTriggerDeviceDisplayName({
        deviceMatches,
        representative,
        registryItem,
        inventoryItem: null,
        triggerDeviceId,
      });

    summaries.push({
      triggerDeviceId,
      entityId: normalize(inventoryItem.source_entity_id) || representative?.entityId || triggerDeviceId,
      deviceId: triggerDeviceId,
      name: displayName,
      state: representative?.state ?? 'unknown',
      area: triggerAreaName,
      areaName: triggerAreaName,
      label: visualLabel,
      labelCategory: representative?.canonicalLabel ?? representative?.labelCategory ?? visualLabel,
      displayName,
      displayAreaName: triggerAreaName,
      parentAreaName: representative?.parentAreaName ?? representative?.sourceAreaName ?? triggerAreaName,
      displayLabel: visualLabel,
      sourceTechnicalLabel: representative?.sourceTechnicalLabel ?? effectiveHaLabels[0] ?? null,
      labels,
      domain: representative?.domain ?? 'remote',
      attributes: representative?.attributes ?? {},
      ownership: representative?.ownership ?? null,
      tenantVirtualAreaId: representative?.tenantVirtualAreaId ?? null,
      isTriggerDevice: true,
      binding: resolvedBinding,
      capability,
      target,
      resolutionState,
    });
  }

  summaries.sort((left, right) => {
    const leftArea = normalize(left.areaName ?? left.area);
    const rightArea = normalize(right.areaName ?? right.area);
    if (leftArea !== rightArea) return leftArea.localeCompare(rightArea);
    const leftLabel = normalize(left.label);
    const rightLabel = normalize(right.label);
    if (leftLabel !== rightLabel) return leftLabel.localeCompare(rightLabel);
    return left.name.localeCompare(right.name);
  });

  const acceptedTriggerDeviceIds = summaries
    .map((item) => normalize(item.deviceId ?? item.triggerDeviceId))
    .filter(Boolean);
  const acceptedTriggerDeviceIdSet = new Set(acceptedTriggerDeviceIds);

  const targetOptions =
    args.includeTargetOptions === false
      ? []
      : buildTriggerTargetOptionsForTenant({
          devices: labelledDevices,
          ownTenantOwnedEntityIds,
          allTenantOwnedEntityIds,
          hasAreaAccess,
          acceptedTriggerDeviceIds: acceptedTriggerDeviceIdSet,
        });

  return { triggerDevices: summaries, targetOptions, acceptedTriggerDeviceIds };
}

export async function getTriggerDevicesForTenant(args: {
  userId: number;
  fresh?: boolean;
}): Promise<TriggerDeviceSummary[]> {
  const context = await getTriggerDeviceDashboardContextForTenant(args);
  return context.triggerDevices;
}

export async function saveTriggerDeviceTarget(args: {
  userId: number;
  triggerDeviceId: string;
  bindingId?: string | null;
  targetDeviceId?: string | null;
  targetEntityId?: string | null;
  bindingName?: string | null;
}): Promise<{
  binding?: TriggerDeviceBindingSummary | null;
  capability?: TriggerDeviceCapabilitySummary | null;
  target?: TriggerDeviceTargetSummary | null;
  resolutionState?: TriggerDeviceResolutionState;
  configEntry?: TriggerBindingUpdateResponse['configEntry'];
  listener?: TriggerBindingUpdateResponse['listener'];
  verified?: boolean;
  retryInBackground?: boolean;
  ok?: true;
  refreshRecommended?: boolean;
}> {
  const triggerDeviceId = normalize(args.triggerDeviceId);
  const bindingId = normalize(args.bindingId) || null;
  const targetDeviceId = normalize(args.targetDeviceId) || null;
  const targetEntityId = normalize(args.targetEntityId) || null;
  const bindingName = normalize(args.bindingName) || null;

  if (!triggerDeviceId) throw new Error('Trigger device is required.');
  if (!targetDeviceId && !targetEntityId) throw new Error('Choose a target device or entity.');
  if (targetDeviceId && targetDeviceId === triggerDeviceId) {
    throw new Error('Trigger device and target cannot be the same device.');
  }

  const {
    user,
    allDevices,
    labelledDevices,
    candidates,
    allTenantOwnedEntityIds,
    ownTenantOwnedEntityIds,
    hasAreaAccess,
  } = await loadContext(args.userId, true);

  let triggerInventory: TriggerDeviceDashboardInventoryItem[] = [];
  for (const candidate of candidates) {
    const inventory = await getCachedTriggerDeviceDashboardInventory(candidate, { force: false });
    if (inventory.length > 0) {
      triggerInventory = inventory;
      break;
    }
  }
  const acceptedTriggerIds = new Set(
    triggerInventory
      .filter((item) => (item.trigger_count ?? 0) > 0)
      .map((item) => normalize(item.device_id))
      .filter(Boolean)
  );
  if (!acceptedTriggerIds.has(triggerDeviceId)) {
    throw new Error('Trigger device is not available.');
  }

  let registryMetadata: HaDeviceRegistryMetadata[] = [];
  for (const candidate of candidates) {
    try {
      registryMetadata = await getDeviceRegistryMetadata(candidate);
      if (registryMetadata.length > 0) break;
    } catch {
      registryMetadata = [];
    }
  }
  const registryByDeviceId = new Map(
    registryMetadata
      .filter((item) => normalize(item.id))
      .map((item) => [normalize(item.id), item])
  );

  const triggerMatches = allDevices.filter((device) => normalize(device.deviceId) === triggerDeviceId);
  const triggerInventoryItem = triggerInventory.find((item) => normalize(item.device_id) === triggerDeviceId) ?? null;
  const triggerRepresentative = getRepresentativeEntity(triggerMatches, null, allDevices);
  const triggerAreaName = firstArea(triggerRepresentative ?? {}) || normalize(triggerInventoryItem?.area_name) || null;
  if (
    !triggerDeviceIsVisible({
      triggerDeviceId,
      triggerAreaName,
      allDevices,
      ownTenantOwnedEntityIds,
      allTenantOwnedEntityIds,
      hasAreaAccess,
    })
  ) {
    throw new Error('Trigger device is not available.');
  }

  const targetOptions = buildTriggerTargetOptionsForTenant({
    devices: labelledDevices,
    ownTenantOwnedEntityIds,
    allTenantOwnedEntityIds,
    hasAreaAccess,
    acceptedTriggerDeviceIds: acceptedTriggerIds,
  });
  const selectedTargetOption = targetOptions.find((option) => {
    if (targetEntityId && option.targetEntityId !== targetEntityId) return false;
    if (targetDeviceId && option.targetDeviceId !== targetDeviceId) return false;
    return true;
  });
  if (!selectedTargetOption) {
    safeLog('warn', '[triggerDevices] rejected target because it is not a tenant dashboard card option', {
      triggerDeviceIdHash: triggerDeviceId.slice(0, 8),
      targetDeviceIdHash: targetDeviceId?.slice(0, 8) ?? null,
      targetEntityId,
      optionCount: targetOptions.length,
    });
    throw new Error('Target is not available.');
  }

  const targetGroup = getDeviceGroup(labelledDevices, selectedTargetOption.targetDeviceId, selectedTargetOption.targetEntityId);
  const target = targetGroup.find((device) => device.entityId === selectedTargetOption.targetEntityId) ?? null;
  if (!target) {
    safeLog('warn', '[triggerDevices] rejected target because selected dashboard card entity was not found', {
      triggerDeviceIdHash: triggerDeviceId.slice(0, 8),
      targetDeviceIdHash: selectedTargetOption.targetDeviceId.slice(0, 8),
      targetEntityId: selectedTargetOption.targetEntityId,
      targetGroupSize: targetGroup.length,
    });
    throw new Error('Target is not available.');
  }
  const resolvedTargetDeviceId = normalize(selectedTargetOption.targetDeviceId || target.deviceId);
  if (resolvedTargetDeviceId && resolvedTargetDeviceId === triggerDeviceId) {
    throw new Error('Trigger device and target cannot be the same device.');
  }

  let lastError: unknown = null;
  for (const candidate of await chooseCandidateForUpdate(candidates)) {
    try {
      const result = (await callRemoteManagerServiceWithBootstrap<TriggerBindingUpdateResponse | null | undefined>(
        candidate,
        SERVICE_SET_TRIGGER_TARGET,
        {
          binding_id: bindingId,
          remote_device_id: triggerDeviceId,
          target_device_id: resolvedTargetDeviceId || selectedTargetOption.targetDeviceId,
          target_entity_id: selectedTargetOption.targetEntityId,
          binding_name: bindingName || `${triggerMatches[0]?.name || triggerDeviceId} control`,
          owner_user_id: String(user.id),
          create_config_entry: true,
        },
        REMOTE_BINDING_UPDATE_TIMEOUT_MS
      )) as TriggerBindingUpdateResponse | null | undefined;
      const binding = result?.binding ?? null;
      const capability = result?.capability ?? null;
      const confirmed =
        binding &&
        normalizeIdentifier(binding.remoteDeviceId) === normalizeIdentifier(triggerDeviceId) &&
        normalizeIdentifier(binding.targetEntityId) === normalizeIdentifier(selectedTargetOption.targetEntityId);
      clearTriggerDeviceInventoryCache(candidate);
      const verifiedRows = await getCachedTriggerDeviceDashboardInventory(candidate, {
        force: true,
        deviceId: triggerDeviceId,
      });
      const verifiedRow =
        verifiedRows.find(
          (row) =>
            normalizeIdentifier(row.binding?.remoteDeviceId) === normalizeIdentifier(triggerDeviceId) &&
            normalizeIdentifier(row.binding?.targetEntityId) === normalizeIdentifier(selectedTargetOption.targetEntityId)
        ) ?? null;
      if (confirmed && verifiedRow) {
        clearTriggerDeviceInventoryCache(candidate);
        return {
          binding: verifiedRow.binding ?? binding,
          capability: verifiedRow.capability ?? capability,
          target: buildResolvedTargetSummary({
            row: verifiedRow,
            fallback: null,
            devices: allDevices,
            registryByDeviceId,
          }),
          resolutionState:
            (normalize(verifiedRow.resolution_state) as TriggerDeviceResolutionState) || 'bound',
          configEntry: result?.configEntry ?? null,
          listener: result?.listener ?? null,
          verified: true,
          refreshRecommended: true,
        };
      }
      if (confirmed) {
        return {
          binding,
          capability,
          configEntry: result?.configEntry ?? null,
          listener: result?.listener ?? null,
          verified: false,
          retryInBackground: true,
          refreshRecommended: true,
        };
      }
      throw new Error('We could not confirm this trigger link. Please try again.');
    } catch (err) {
      lastError = err;
    }
  }

  safeLog('error', '[triggerDevices] Failed to save trigger-device target', {
    userId: user.id,
    triggerDeviceId,
    targetEntityId,
    targetDeviceId,
    error: lastError,
  });

  if (isTimeoutError(lastError)) {
    throw new Error('Trigger target update is taking longer than expected. Refresh the dashboard and check the current target.');
  }
  throw new Error('Dinodia Hub did not respond when updating this trigger device.');
}

type TriggerBindingCleanupArgs = {
  tenantUserId: number;
  haConnection: {
    baseUrl: string;
    cloudUrl: string | null;
    longLivedToken: string;
  };
};

type TriggerBindingCleanupResult = {
  removedBindings: number;
  removedConfigEntries: number;
  removedListeners: number;
  failed: number;
  errors: string[];
};

function emptyTriggerBindingCleanupResult(): TriggerBindingCleanupResult {
  return {
    removedBindings: 0,
    removedConfigEntries: 0,
    removedListeners: 0,
    failed: 0,
    errors: [],
  };
}

function normalizeCleanupResponse(payload: unknown): TriggerBindingCleanupResult {
  const result = emptyTriggerBindingCleanupResult();
  const data = payload as
    | {
        removed?: { bindings?: number; configEntries?: number; listeners?: number };
        errors?: unknown[];
      }
    | null
    | undefined;
  result.removedBindings = Number(data?.removed?.bindings ?? 0);
  result.removedConfigEntries = Number(data?.removed?.configEntries ?? 0);
  result.removedListeners = Number(data?.removed?.listeners ?? 0);
  result.errors = (data?.errors ?? []).map((item) => String(item));
  result.failed = result.errors.length;
  return result;
}

export async function removeTriggerBindingsForTenant(
  args: TriggerBindingCleanupArgs
): Promise<TriggerBindingCleanupResult> {
  let lastError: unknown = null;
  for (const candidate of buildHaCandidates(args.haConnection)) {
    try {
      const response = await callHaService(
        candidate,
        REMOTE_MANAGER_DOMAIN,
        SERVICE_REMOVE_TENANT_BINDINGS,
        { owner_user_id: String(args.tenantUserId) },
        REMOTE_BINDING_UPDATE_TIMEOUT_MS,
        { returnResponse: true }
      );
      return normalizeCleanupResponse(response);
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ...emptyTriggerBindingCleanupResult(),
    failed: 1,
    errors: [lastError instanceof Error ? lastError.message : 'Failed to remove trigger bindings.'],
  };
}

export async function removeTriggerBindingsForDeletedDeviceIds(
  args: TriggerBindingCleanupArgs & { remoteDeviceIds: string[] }
): Promise<TriggerBindingCleanupResult> {
  const remoteDeviceIds = Array.from(new Set(args.remoteDeviceIds.map(normalize).filter(Boolean)));
  if (remoteDeviceIds.length === 0) return emptyTriggerBindingCleanupResult();
  let lastError: unknown = null;
  for (const candidate of buildHaCandidates(args.haConnection)) {
    try {
      const response = await callHaService(
        candidate,
        REMOTE_MANAGER_DOMAIN,
        SERVICE_REMOVE_TRIGGER_BINDINGS_FOR_DEVICES,
        { owner_user_id: String(args.tenantUserId), remote_device_ids: remoteDeviceIds },
        REMOTE_BINDING_UPDATE_TIMEOUT_MS,
        { returnResponse: true }
      );
      return normalizeCleanupResponse(response);
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ...emptyTriggerBindingCleanupResult(),
    failed: 1,
    errors: [lastError instanceof Error ? lastError.message : 'Failed to remove trigger bindings for devices.'],
  };
}

type RemoteManagerBindingListResponse = {
  bindings?: Array<{
    binding?: {
      bindingId?: string | null;
      remoteDeviceId?: string | null;
      targetDeviceId?: string | null;
      targetEntityId?: string | null;
      ownerUserId?: string | null;
    } | null;
  }>;
};

export async function removeTriggerBindingsReferencingTarget(
  args: TriggerBindingCleanupArgs & {
    targetDeviceIds?: string[];
    targetEntityIds?: string[];
  }
): Promise<TriggerBindingCleanupResult> {
  const targetDeviceIds = new Set((args.targetDeviceIds ?? []).map(normalize).filter(Boolean));
  const targetEntityIds = new Set((args.targetEntityIds ?? []).map(normalize).filter(Boolean));
  if (targetDeviceIds.size === 0 && targetEntityIds.size === 0) {
    return emptyTriggerBindingCleanupResult();
  }

  let lastError: unknown = null;
  for (const candidate of buildHaCandidates(args.haConnection)) {
    try {
      const response = await callRemoteManagerServiceWithBootstrap<RemoteManagerBindingListResponse>(
        candidate,
        SERVICE_LIST_BINDINGS,
        {},
        REMOTE_BINDING_UPDATE_TIMEOUT_MS
      );
      const matches = (response.bindings ?? [])
        .map((row) => row?.binding ?? null)
        .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding))
        .filter((binding) => normalize(binding.ownerUserId) === normalize(String(args.tenantUserId)))
        .filter((binding) => {
          const targetDeviceId = normalize(binding.targetDeviceId);
          const targetEntityId = normalize(binding.targetEntityId);
          return targetDeviceIds.has(targetDeviceId) || targetEntityIds.has(targetEntityId);
        });

      const result = emptyTriggerBindingCleanupResult();
      for (const binding of matches) {
        const bindingId = normalize(binding.bindingId);
        if (!bindingId) continue;
        try {
          await callRemoteManagerServiceWithBootstrap(
            candidate,
            SERVICE_UNBIND,
            { binding_id: bindingId },
            REMOTE_BINDING_UPDATE_TIMEOUT_MS
          );
          result.removedBindings += 1;
        } catch (err) {
          result.failed += 1;
          result.errors.push(err instanceof Error ? err.message : 'Failed to unbind trigger target.');
        }
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ...emptyTriggerBindingCleanupResult(),
    failed: 1,
    errors: [lastError instanceof Error ? lastError.message : 'Failed to remove trigger bindings for target device.'],
  };
}
