// Architecture: Shared platform helper src/lib/tenantInventoryBootstrap.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getUserWithHaConnection } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { resolveDeviceDisplayBatch } from '@/lib/deviceDisplayResolver';
import {
  getTenantOwnedTargetsForHome,
  getTenantOwnedTargetsForUser,
  getTenantOwnershipIndexForHome,
} from '@/lib/tenantOwnership';
import { buildAreaAccessMatcher } from '@/lib/areaAccess';
import type { HaConnectionLike } from '@/lib/homeAssistant';

const TENANT_INVENTORY_BOOTSTRAP_TTL_MS = 15_000;

function normalize(value: string | null | undefined) {
  return (value ?? '').toString().trim();
}

export function buildHaCandidates(haConnection: {
  baseUrl: string;
  cloudUrl: string | null;
  longLivedToken: string;
}): HaConnectionLike[] {
  const seen = new Set<string>();
  const ordered: HaConnectionLike[] = [];
  for (const value of [haConnection.cloudUrl, haConnection.baseUrl]) {
    const normalized = normalize(value).replace(/\/+$/, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push({ baseUrl: normalized, longLivedToken: haConnection.longLivedToken });
  }
  return ordered;
}

type TenantInventoryBootstrapSnapshot = {
  user: Awaited<ReturnType<typeof getUserWithHaConnection>>['user'];
  haConnection: Awaited<ReturnType<typeof getUserWithHaConnection>>['haConnection'];
  allDevices: Awaited<ReturnType<typeof resolveDeviceDisplayBatch>>;
  labelledDevices: Awaited<ReturnType<typeof resolveDeviceDisplayBatch>>;
  candidates: HaConnectionLike[];
  allTenantOwnedEntityIds: Set<string>;
  ownTenantOwnedEntityIds: Set<string>;
  ownershipIndex: Awaited<
    ReturnType<typeof getTenantOwnershipIndexForHome>
  >;
  sourceAreaByEntity: Map<string, string | null>;
  displayAreaByEntity: Map<string, string | null>;
  hasAreaAccess: (area: string | null | undefined) => boolean;
  builtAt: number;
};

type CacheEntry = {
  snapshot: TenantInventoryBootstrapSnapshot | null;
  expiresAt: number;
  inFlight: Promise<TenantInventoryBootstrapSnapshot> | null;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(userId: number, includeServicesForTarget: boolean) {
  return `${userId}::${includeServicesForTarget ? 'with-services' : 'base'}`;
}

async function buildSnapshot(
  userId: number,
  fresh: boolean,
  includeServicesForTarget: boolean
): Promise<TenantInventoryBootstrapSnapshot> {
  const { user, haConnection } = await getUserWithHaConnection(userId);
  if (!user.homeId) throw new Error('Your home is not set up yet.');

  const [
    allDevicesRaw,
    labelledDevicesRaw,
    tenantOwnedForHome,
    tenantOwnedForUser,
    ownershipIndex,
    areaAccess,
  ] = await Promise.all([
    getDevicesForHaConnection(haConnection.id, {
      bypassCache: fresh,
      labelsOnly: false,
      includeServicesForTarget,
    }),
    getDevicesForHaConnection(haConnection.id, {
      bypassCache: fresh,
      labelsOnly: true,
      includeServicesForTarget,
    }),
    getTenantOwnedTargetsForHome(user.homeId, haConnection.id),
    getTenantOwnedTargetsForUser(user.id, haConnection.id),
    getTenantOwnershipIndexForHome({
      homeId: user.homeId,
      haConnectionId: haConnection.id,
      currentTenantUserId: user.id,
    }),
    buildAreaAccessMatcher({
      haConnectionId: haConnection.id,
      accessAreas: (user.accessRules ?? []).map((rule) => rule.area),
    }),
  ]);

  const [allDevices, labelledDevices] = await Promise.all([
    resolveDeviceDisplayBatch(allDevicesRaw, {
      viewer: 'tenant',
      userId: user.id,
      homeId: user.homeId,
      haConnectionId: haConnection.id,
    }),
    resolveDeviceDisplayBatch(labelledDevicesRaw, {
      viewer: 'tenant',
      userId: user.id,
      homeId: user.homeId,
      haConnectionId: haConnection.id,
    }),
  ]);

  return {
    user,
    haConnection,
    allDevices,
    labelledDevices,
    candidates: buildHaCandidates(haConnection),
    allTenantOwnedEntityIds: new Set(tenantOwnedForHome.entityIds),
    ownTenantOwnedEntityIds: new Set(tenantOwnedForUser.entityIds),
    ownershipIndex,
    sourceAreaByEntity: new Map(
      allDevices
        .map((device) => [device.entityId, device.sourceAreaName?.trim() || null] as const)
        .filter(([, area]) => Boolean(area))
    ),
    displayAreaByEntity: new Map(
      allDevices
        .map((device) => [device.entityId, device.displayAreaName?.trim() || null] as const)
        .filter(([, area]) => Boolean(area))
    ),
    hasAreaAccess: areaAccess.hasAreaAccess,
    builtAt: Date.now(),
  };
}

export async function getTenantInventoryBootstrap(
  userId: number,
  options: { fresh?: boolean; includeServicesForTarget?: boolean } = {}
) {
  const fresh = options.fresh === true;
  const includeServicesForTarget = options.includeServicesForTarget === true;
  const key = cacheKey(userId, includeServicesForTarget);
  const now = Date.now();
  const cached = cache.get(key);

  if (!fresh && cached?.snapshot && cached.expiresAt > now) {
    return cached.snapshot;
  }

  if (!fresh && cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = buildSnapshot(userId, fresh, includeServicesForTarget)
    .then((snapshot) => {
      cache.set(key, {
        snapshot,
        expiresAt: Date.now() + TENANT_INVENTORY_BOOTSTRAP_TTL_MS,
        inFlight: null,
      });
      return snapshot;
    })
    .catch((error) => {
      if (cached) {
        cache.set(key, { ...cached, inFlight: null });
      } else {
        cache.delete(key);
      }
      throw error;
    });

  cache.set(key, {
    snapshot: cached?.snapshot ?? null,
    expiresAt: cached?.expiresAt ?? 0,
    inFlight,
  });
  return inFlight;
}

export function invalidateTenantInventoryBootstrap(userId?: number) {
  if (typeof userId === 'number') {
    cache.delete(cacheKey(userId, false));
    cache.delete(cacheKey(userId, true));
    return;
  }
  cache.clear();
}
