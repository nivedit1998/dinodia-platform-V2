// Architecture: Shared platform helper src/lib/devicesSnapshot.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import {
  EnrichedDevice,
  HAState,
  callHomeAssistantAPI,
  getLabeledDevicesWithMetadata,
  getDevicesWithMetadata,
  getEntityRegistryMap,
  getServicesForTargetCached,
} from '@/lib/homeAssistant';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { classifyDeviceByLabel } from '@/lib/labelCatalog';
import { buildFallbackDeviceId } from '@/lib/deviceIdentity';
import type { UIDevice } from '@/types/device';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { safeLog } from '@/lib/safeLogger';

type DeviceFetchOptions = {
  logSample?: boolean;
  bypassCache?: boolean;
  cacheTtlMs?: number;
  labelsOnly?: boolean;
  includeServicesForTarget?: boolean;
};

type DeviceCacheEntry = {
  devices: UIDevice[];
  fetchedAt: number;
};

const DEFAULT_CACHE_TTL_MS = 15_000;

const globalForCache = globalThis as unknown as {
  __devicesCache?: Map<string, DeviceCacheEntry>;
};

function getDeviceCache() {
  if (!globalForCache.__devicesCache) {
    globalForCache.__devicesCache = new Map();
  }
  return globalForCache.__devicesCache;
}

function cacheKeyForDevices(haConnectionId: number, opts: DeviceFetchOptions) {
  const labelsOnly = opts.labelsOnly === true ? 1 : 0;
  const includeServicesForTarget = opts.includeServicesForTarget === true ? 1 : 0;
  return `${haConnectionId}:${labelsOnly}:${includeServicesForTarget}`;
}

async function fetchEnrichedDevicesWithFallback(
  ha: HaConnectionLike,
  haConnectionId: number,
  opts: DeviceFetchOptions
): Promise<EnrichedDevice[]> {
  const fetchStartedAt = Date.now();

  let enriched: EnrichedDevice[] = [];
  const labelsOnly = opts.labelsOnly === true;

  if (labelsOnly) {
    enriched = await getLabeledDevicesWithMetadata(ha);
  } else {
    try {
      enriched = await getDevicesWithMetadata(ha);
    } catch (err) {
      safeLog('warn', '[devicesSnapshot] metadata failed, falling back to states-only', {
        haConnectionId,
        error: err,
      });
      try {
        const [states, registryMap] = await Promise.all([
          callHomeAssistantAPI<HAState[]>(ha, '/api/states'),
          getEntityRegistryMap(ha),
        ]);
        enriched = states.map((s) => {
          const domain = s.entity_id.split('.')[0] || '';
          return {
            entityId: s.entity_id,
            deviceId: registryMap.get(s.entity_id) ?? null,
            name: s.attributes.friendly_name ?? s.entity_id,
            state: s.state,
            areaName: null,
            labels: [],
            entityLabels: [],
            deviceLabels: [],
            labelCategory: null,
            domain,
            attributes: s.attributes ?? {},
          };
        });
      } catch (fallbackErr) {
        safeLog('error', '[devicesSnapshot] Failed to fetch devices from HA after fallback', {
          haConnectionId,
          error: fallbackErr,
        });
        throw new Error('Dinodia Hub did not respond when loading devices.');
      }
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    safeLog('debug', '[devicesSnapshot] fetched from HA', {
      haConnectionId,
      count: enriched.length,
      ms: Date.now() - fetchStartedAt,
    });
  }

  if (labelsOnly) {
    enriched = enriched.filter(
      (d) =>
        (Array.isArray(d.labels) && d.labels.length > 0) ||
        (Array.isArray(d.entityLabels) && d.entityLabels.length > 0) ||
        (Array.isArray(d.deviceLabels) && d.deviceLabels.length > 0)
    );
  }

  if (opts.includeServicesForTarget) {
    enriched = await populateServicesForTarget(ha, enriched);
  }

  return enriched;
}

type DeviceOverride = {
  entityId: string;
  name: string;
  blindTravelSeconds: number | null;
};

function shapeDevices(
  enriched: EnrichedDevice[],
  overrideMap: Map<string, DeviceOverride>
): UIDevice[] {
  return enriched.map((d) => {
    const override = overrideMap.get(d.entityId);
    const name = override?.name ?? d.name;
    // Area/label come from HA metadata; DB overrides no longer apply.
    const areaName = d.areaName ?? null;
    const labels = Array.isArray(d.labels) ? d.labels : [];
    const entityLabels = Array.isArray(d.entityLabels) ? d.entityLabels : [];
    const deviceLabels = Array.isArray(d.deviceLabels) ? d.deviceLabels : [];
    const labelCategory = classifyDeviceByLabel(labels ?? []) ?? d.labelCategory ?? null;
    const primaryLabel =
      labels && labels.length > 0 && labels[0] ? String(labels[0]) : null;
    const label = primaryLabel ?? labelCategory ?? null;
    const deviceId =
      d.deviceId ??
      buildFallbackDeviceId({
        entityId: d.entityId,
        name,
        areaName,
        area: areaName,
      });

    return {
      entityId: d.entityId,
      deviceId,
      name,
      state: d.state,
      area: areaName,
      areaName,
      labels,
      technicalLabels: labels,
      entityLabels,
      deviceLabels,
      label,
      labelCategory,
      displayName: name,
      displayAreaName: areaName,
      canonicalLabel: labelCategory,
      displayLabel: label,
      domain: d.domain,
      attributes: d.attributes ?? {},
      servicesForTarget: d.servicesForTarget ?? [],
      serviceDomains: Array.from(
        new Set(
          (d.servicesForTarget ?? [])
            .map((serviceId) => serviceId.split('.')[0] || '')
            .filter(Boolean)
        )
      ),
      blindTravelSeconds:
        override?.blindTravelSeconds != null ? override.blindTravelSeconds : null,
    };
  });
}

async function populateServicesForTarget(
  ha: HaConnectionLike,
  devices: EnrichedDevice[]
): Promise<EnrichedDevice[]> {
  const concurrency = 8;
  const enrichedDevices = [...devices];

  for (let index = 0; index < enrichedDevices.length; index += concurrency) {
    const batch = enrichedDevices.slice(index, index + concurrency);
    const servicesBatch = await Promise.all(
      batch.map(async (device) => {
        try {
          return await getServicesForTargetCached(ha, device.entityId);
        } catch {
          return [];
        }
      })
    );

    batch.forEach((device, offset) => {
      device.servicesForTarget = servicesBatch[offset] ?? [];
    });
  }

  return enrichedDevices;
}

function logSample(devices: UIDevice[]) {
  const interestingLabels = new Set(['Motion Sensor', 'TV', 'Spotify']);
  const sample = devices.filter((d) => {
    const labels = Array.isArray(d.labels) ? d.labels : [];
    const candidates = [d.label ?? '', ...labels, d.labelCategory ?? ''].map((lbl) =>
      lbl ? lbl.toString().trim() : ''
    );
    return candidates.some((lbl) => interestingLabels.has(lbl));
  });

  if (sample.length > 0) {
    safeLog('debug', '[devicesSnapshot] sample summary', {
      sampleCount: sample.length,
      totalCount: devices.length,
    });
  }
}

function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function buildHaCandidates(haConnection: {
  baseUrl: string;
  cloudUrl: string | null;
  longLivedToken: string;
}): HaConnectionLike[] {
  const candidates: HaConnectionLike[] = [];
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

export async function getDevicesForHaConnection(
  haConnectionId: number,
  opts: DeviceFetchOptions = {}
): Promise<UIDevice[]> {
  const cache = getDeviceCache();
  const cacheKey = cacheKeyForDevices(haConnectionId, opts);
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!opts.bypassCache && cacheTtlMs > 0) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
      return cached.devices;
    }
  }

  const haConnection = await prisma.haConnection.findUnique({
    where: { id: haConnectionId },
    select: {
      id: true,
      baseUrl: true,
      cloudUrl: true,
      longLivedToken: true,
      longLivedTokenCiphertext: true,
    },
  });

  if (!haConnection) {
    throw new Error(`HA connection ${haConnectionId} not found`);
  }

  const { longLivedToken } = resolveHaLongLivedToken(haConnection);
  const hydrated = { ...haConnection, longLivedToken };

  const candidates = buildHaCandidates(hydrated);
  let enriched: EnrichedDevice[] | null = null;
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      enriched = await fetchEnrichedDevicesWithFallback(candidate, haConnectionId, opts);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!enriched) {
    if (opts.labelsOnly) {
      safeLog('warn', '[devicesSnapshot] labeled device fetch failed; returning empty devices', {
        haConnectionId,
        error: lastError,
      });
      enriched = [];
    } else {
      throw lastError instanceof Error
        ? lastError
        : new Error('Dinodia Hub did not respond when loading devices.');
    }
  }

  const dbDevices = await prisma.device.findMany({
    where: { haConnectionId },
  });
  const overrideMap: Map<string, DeviceOverride> = new Map(
    dbDevices.map((d) => [
      d.entityId,
      {
        entityId: d.entityId,
        name: d.name,
        blindTravelSeconds:
          typeof d.blindTravelSeconds === 'number' ? d.blindTravelSeconds : null,
      },
    ])
  );

  const devices = shapeDevices(enriched, overrideMap);

  if (opts.logSample && process.env.NODE_ENV !== 'production') {
    logSample(devices);
  }

  cache.set(cacheKey, { devices, fetchedAt: Date.now() });

  return devices;
}

export function invalidateDevicesSnapshotCache(haConnectionId?: number) {
  const cache = getDeviceCache();
  if (typeof haConnectionId !== 'number') {
    cache.clear();
    return;
  }
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(`${haConnectionId}:`)) {
      cache.delete(key);
    }
  }
}
