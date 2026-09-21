// Architecture: Shared platform helper src/lib/adminMonitoringDisplay.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import { normalizeLookupKey } from '@/lib/displayNormalization';
import { OTHER_LABEL } from '@/lib/deviceLabels';
import { isTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { HaWsClient } from '@/lib/haWebSocket';
import { safeLog } from '@/lib/safeLogger';

export const UNASSIGNED_AREA = 'Unassigned';

export type MonitoringDisplayContext = {
  displayName(entityId: string): string;
  displayArea(entityId: string): string;
  displayAreaName(area: string | null | undefined): string;
  displayAreaKey(entityId: string): string;
  displayAreaKeyForArea(area: string | null | undefined): string;
  displayAreaNameForKey(displayKey: string): string | null;
  sourceAreasForDisplayKey(displayKey: string): string[];
  matchesRequestedDisplayAreas(entityId: string, requestedAreas: Set<string>): boolean;
  matchesRequestedAreaValue(area: string | null | undefined, requestedAreas: Set<string>): boolean;
  displayLabel(entityId: string): string | null;
  sourceArea(entityId: string): string | null;
  sourceLabel(entityId: string): string | null;
  isVisibleEntity(entityId: string): boolean;
  isVisibleLabel(label: string | null | undefined): boolean;
};

type HaAreaRegistryEntry = {
  area_id?: string | null;
  name?: string | null;
};

type HaEntityRegistryEntry = {
  entity_id?: string | null;
  area_id?: string | null;
  device_id?: string | null;
};

type HaDeviceRegistryEntry = {
  id?: string | null;
  area_id?: string | null;
};

type LiveAreaCacheEntry = {
  fetchedAt: number;
  entityAreaByEntityId: Map<string, string>;
};

const LIVE_AREA_CACHE_TTL_MS = 15_000;

const globalForLiveAreaCache = globalThis as unknown as {
  __adminMonitoringLiveAreaCache?: Map<number, LiveAreaCacheEntry>;
  __adminMonitoringLiveAreaInflight?: Map<number, Promise<Map<string, string>>>;
};

function getLiveAreaCache() {
  if (!globalForLiveAreaCache.__adminMonitoringLiveAreaCache) {
    globalForLiveAreaCache.__adminMonitoringLiveAreaCache = new Map();
  }
  return globalForLiveAreaCache.__adminMonitoringLiveAreaCache;
}

function getLiveAreaInflight() {
  if (!globalForLiveAreaCache.__adminMonitoringLiveAreaInflight) {
    globalForLiveAreaCache.__adminMonitoringLiveAreaInflight = new Map();
  }
  return globalForLiveAreaCache.__adminMonitoringLiveAreaInflight;
}

function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function asTrimmedString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildHaCandidates(haConnection: {
  baseUrl: string;
  cloudUrl: string | null;
  longLivedToken: string;
}) {
  const candidates: Array<{ baseUrl: string; longLivedToken: string }> = [];
  const seen = new Set<string>();
  const cloud = haConnection.cloudUrl ? normalizeUrl(haConnection.cloudUrl) : '';
  const base = normalizeUrl(haConnection.baseUrl);

  if (cloud && !seen.has(cloud)) {
    candidates.push({ baseUrl: cloud, longLivedToken: haConnection.longLivedToken });
    seen.add(cloud);
  }
  if (base && !seen.has(base)) {
    candidates.push({ baseUrl: base, longLivedToken: haConnection.longLivedToken });
  }

  return candidates;
}

async function fetchLiveEntityAreaMapFromCandidate(ha: {
  baseUrl: string;
  longLivedToken: string;
}) {
  const client = await HaWsClient.connect(ha);
  try {
    const [areas, entities, devices] = await Promise.all([
      client.call<HaAreaRegistryEntry[]>('config/area_registry/list'),
      client.call<HaEntityRegistryEntry[]>('config/entity_registry/list'),
      client.call<HaDeviceRegistryEntry[]>('config/device_registry/list'),
    ]);

    const areaNameById = new Map<string, string>();
    for (const row of areas ?? []) {
      const areaId = asTrimmedString(row?.area_id);
      const areaName = asTrimmedString(row?.name);
      if (areaId && areaName) areaNameById.set(areaId, areaName);
    }

    const areaByDeviceId = new Map<string, string>();
    for (const row of devices ?? []) {
      const deviceId = asTrimmedString(row?.id);
      const areaId = asTrimmedString(row?.area_id);
      const areaName = areaNameById.get(areaId);
      if (deviceId && areaName) areaByDeviceId.set(deviceId, areaName);
    }

    const areaByEntityId = new Map<string, string>();
    for (const row of entities ?? []) {
      const entityId = asTrimmedString(row?.entity_id);
      if (!entityId) continue;
      const entityAreaName = areaNameById.get(asTrimmedString(row?.area_id));
      const deviceAreaName = areaByDeviceId.get(asTrimmedString(row?.device_id));
      const resolvedArea = entityAreaName || deviceAreaName;
      if (resolvedArea) areaByEntityId.set(entityId, resolvedArea);
    }

    return areaByEntityId;
  } finally {
    client.close();
  }
}

async function fetchLiveEntityAreaMap(haConnectionId: number) {
  const haConnection = await prisma.haConnection.findUnique({
    where: { id: haConnectionId },
    select: {
      baseUrl: true,
      cloudUrl: true,
      longLivedToken: true,
      longLivedTokenCiphertext: true,
    },
  });
  if (!haConnection) return new Map<string, string>();

  let longLivedToken = '';
  try {
    longLivedToken = resolveHaLongLivedToken(haConnection).longLivedToken;
  } catch (error) {
    safeLog('warn', '[adminMonitoringDisplay] live area token missing; falling back to stored device areas', {
      haConnectionId,
      error,
    });
    return new Map<string, string>();
  }

  const candidates = buildHaCandidates({
    baseUrl: haConnection.baseUrl,
    cloudUrl: haConnection.cloudUrl,
    longLivedToken,
  });

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await fetchLiveEntityAreaMapFromCandidate(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    safeLog('warn', '[adminMonitoringDisplay] live area lookup failed; falling back to stored device areas', {
      haConnectionId,
      error: lastError,
    });
  }
  return new Map<string, string>();
}

async function getLiveEntityAreaMap(haConnectionId: number) {
  const cache = getLiveAreaCache();
  const cached = cache.get(haConnectionId);
  if (cached && Date.now() - cached.fetchedAt <= LIVE_AREA_CACHE_TTL_MS) {
    return cached.entityAreaByEntityId;
  }

  const inflight = getLiveAreaInflight();
  const existingPromise = inflight.get(haConnectionId);
  if (existingPromise) return existingPromise;

  const promise = fetchLiveEntityAreaMap(haConnectionId)
    .then((entityAreaByEntityId) => {
      cache.set(haConnectionId, {
        fetchedAt: Date.now(),
        entityAreaByEntityId,
      });
      return entityAreaByEntityId;
    })
    .finally(() => {
      inflight.delete(haConnectionId);
    });

  inflight.set(haConnectionId, promise);
  return promise;
}

export async function listLiveMonitoringAreas(haConnectionId: number) {
  const entityAreaByEntityId = await getLiveEntityAreaMap(haConnectionId);
  return Array.from(
    new Set(
      Array.from(entityAreaByEntityId.values())
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function fallbackEntityDisplayName(entityId: string) {
  const objectId = entityId.includes('.') ? entityId.split('.').slice(1).join('.') : entityId;
  return objectId
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || entityId;
}

function inferLabel(entityId: string, existing?: string | null) {
  const cleaned = existing?.trim();
  if (cleaned) return cleaned;
  const id = entityId.toLowerCase();
  if (id.includes('blind')) return 'Blind';
  if (id.includes('motion')) return 'Motion Sensor';
  if (id.includes('spotify')) return 'Spotify';
  if (id.includes('boiler')) return 'Boiler';
  if (id.includes('radiator')) return 'Radiator';
  if (id.includes('doorbell')) return 'Doorbell';
  if (id.includes('security')) return 'Home Security';
  if (id.includes('tv')) return 'TV';
  if (id.includes('speaker')) return 'Speaker';
  if (id.includes('light') || id.includes('lamp') || id.includes('spotlight')) return 'Light';
  return null;
}

export async function buildMonitoringDisplayContext(args: {
  haConnectionId: number;
  entityIds: string[];
}): Promise<MonitoringDisplayContext> {
  const entityIds = Array.from(new Set(args.entityIds.filter(Boolean)));
  const [devices, areaOverrides, labelOverrides, liveAreaByEntityId] = await Promise.all([
    entityIds.length
      ? prisma.device.findMany({
          where: { haConnectionId: args.haConnectionId, entityId: { in: entityIds } },
          select: { entityId: true, name: true, area: true, label: true },
        })
      : Promise.resolve([]),
    prisma.areaDisplayOverride.findMany({
      where: { haConnectionId: args.haConnectionId },
      select: { haAreaName: true, displayName: true, displayKey: true },
    }),
    prisma.labelDisplayOverride.findMany({
      where: { haConnectionId: args.haConnectionId },
      select: { sourceTechnicalLabel: true, displayName: true },
    }),
    getLiveEntityAreaMap(args.haConnectionId),
  ]);

  const deviceByEntity = new Map(devices.map((device) => [device.entityId, device]));
  const areaOverrideBySource = new Map(areaOverrides.map((row) => [row.haAreaName, row]));
  const labelOverrideBySource = new Map(
    labelOverrides.map((row) => [normalizeLookupKey(row.sourceTechnicalLabel), row.displayName])
  );
  const rawAreasByDisplayKey = new Map<string, Set<string>>();
  const displayNameByDisplayKey = new Map<string, string>();

  const addRawAreaToDisplayKey = (rawArea: string) => {
    const override = areaOverrideBySource.get(rawArea);
    const displayName = override?.displayName?.trim() || rawArea;
    const displayKey = override?.displayKey?.trim() || normalizeLookupKey(displayName || rawArea);
    if (!rawAreasByDisplayKey.has(displayKey)) {
      rawAreasByDisplayKey.set(displayKey, new Set<string>());
    }
    rawAreasByDisplayKey.get(displayKey)!.add(rawArea);
    if (!displayNameByDisplayKey.has(displayKey) && displayName) {
      displayNameByDisplayKey.set(displayKey, displayName);
    }
    return displayKey;
  };

  for (const row of areaOverrides) {
    addRawAreaToDisplayKey(row.haAreaName);
  }
  for (const area of liveAreaByEntityId.values()) {
    const source = area.trim();
    if (source) addRawAreaToDisplayKey(source);
  }
  for (const device of devices) {
    const source = device.area?.trim();
    if (source) addRawAreaToDisplayKey(source);
  }

  const isVisibleLabel = (label: string | null | undefined) => {
    const key = normalizeLookupKey(label ?? '');
    return Boolean(key) && key !== normalizeLookupKey(OTHER_LABEL) && !isTenantDeviceLabelValue(label);
  };

  const sourceArea = (entityId: string) => {
    const liveArea = liveAreaByEntityId.get(entityId)?.trim();
    if (liveArea) return liveArea;
    const area = deviceByEntity.get(entityId)?.area?.trim();
    return area || null;
  };

  const displayAreaKeyForArea = (area: string | null | undefined) => {
    const source = area?.trim();
    if (!source) return normalizeLookupKey(UNASSIGNED_AREA);
    return addRawAreaToDisplayKey(source);
  };

  const sourceLabel = (entityId: string) => {
    return inferLabel(entityId, deviceByEntity.get(entityId)?.label);
  };

  const displayLabel = (entityId: string) => {
    const source = sourceLabel(entityId);
    if (!source) return null;
    return labelOverrideBySource.get(normalizeLookupKey(source)) ?? source;
  };

  const displayAreaKey = (entityId: string) => {
    return displayAreaKeyForArea(sourceArea(entityId));
  };

  const displayAreaNameForKey = (displayKey: string) => {
    const cleaned = displayKey.trim();
    if (!cleaned) return null;
    return displayNameByDisplayKey.get(cleaned) ?? null;
  };

  const sourceAreasForDisplayKey = (displayKey: string) => {
    const cleaned = displayKey.trim();
    if (!cleaned) return [];
    return Array.from(rawAreasByDisplayKey.get(cleaned) ?? []).sort((left, right) => left.localeCompare(right));
  };

  const normalizeRequestedAreaKeys = (requestedAreas: Set<string>) => {
    const keys = new Set<string>();
    for (const requestedArea of requestedAreas) {
      const trimmed = requestedArea.trim();
      if (!trimmed) continue;
      keys.add(normalizeLookupKey(trimmed));
      keys.add(displayAreaKeyForArea(trimmed));
    }
    return keys;
  };

  const matchesRequestedAreaValue = (area: string | null | undefined, requestedAreas: Set<string>) => {
    if (requestedAreas.size === 0) return true;
    const areaKey = displayAreaKeyForArea(area);
    const requestedKeys = normalizeRequestedAreaKeys(requestedAreas);
    if (requestedKeys.has(areaKey)) return true;
    const source = area?.trim();
    return Boolean(source && requestedKeys.has(normalizeLookupKey(source)));
  };

  const matchesRequestedDisplayAreas = (entityId: string, requestedAreas: Set<string>) => {
    if (requestedAreas.size === 0) return true;
    return matchesRequestedAreaValue(sourceArea(entityId), requestedAreas);
  };

  return {
    displayName(entityId) {
      return deviceByEntity.get(entityId)?.name?.trim() || fallbackEntityDisplayName(entityId);
    },
    displayArea(entityId) {
      const source = sourceArea(entityId);
      if (!source) return UNASSIGNED_AREA;
      return areaOverrideBySource.get(source)?.displayName ?? source;
    },
    displayAreaName(area) {
      const source = area?.trim();
      if (!source) return UNASSIGNED_AREA;
      return areaOverrideBySource.get(source)?.displayName ?? source;
    },
    displayAreaKey,
    displayAreaKeyForArea,
    displayAreaNameForKey,
    sourceAreasForDisplayKey,
    matchesRequestedDisplayAreas,
    matchesRequestedAreaValue,
    displayLabel,
    sourceArea,
    sourceLabel,
    isVisibleEntity(entityId) {
      return isVisibleLabel(displayLabel(entityId));
    },
    isVisibleLabel,
  };
}
