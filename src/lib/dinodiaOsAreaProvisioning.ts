// Architecture: Shared Dinodia OS integration helper. Company Portal routes use this module to
// gate managed-area operations, connect through the stored cloud/base URL, and call the hub's
// Home Assistant-compatible area registry without changing Home Assistant-backed homes.
import { prisma } from '@/lib/prisma';
import { resolveHaCloudFirst } from '@/lib/haConnection';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { HaWsClient } from '@/lib/haWebSocket';

const MAX_HEARTBEAT_AGE_MS = 10 * 60 * 1000;

type RuntimeCapabilities = Record<string, unknown>;

export type DinodiaOsHubContext = {
  id: string;
  serial: string;
  runtimeKind: string | null;
  runtimeVersion: string | null;
  runtimeCapabilities: unknown;
  runtimeCapabilitiesReportedAt: Date | null;
  lastSeenAt: Date | null;
  platformSyncIntervalMinutes: number;
  home: {
    id: number;
    haConnection: {
      baseUrl: string;
      cloudUrl: string | null;
      longLivedToken: string | null;
      longLivedTokenCiphertext: string | null;
    } | null;
  } | null;
};

export const dinodiaOsHubSelect = {
  id: true,
  serial: true,
  runtimeKind: true,
  runtimeVersion: true,
  runtimeCapabilities: true,
  runtimeCapabilitiesReportedAt: true,
  lastSeenAt: true,
  platformSyncIntervalMinutes: true,
  home: {
    select: {
      id: true,
      haConnection: {
        select: {
          baseUrl: true,
          cloudUrl: true,
          longLivedToken: true,
          longLivedTokenCiphertext: true,
        },
      },
    },
  },
} as const;

export class DinodiaOsAreaError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DinodiaOsAreaError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeAreaName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function runtimeCapabilities(value: unknown): RuntimeCapabilities {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RuntimeCapabilities)
    : {};
}

export function isDinodiaOsManagedAreaHub(
  hub: Pick<DinodiaOsHubContext, 'runtimeKind' | 'runtimeCapabilities' | 'runtimeCapabilitiesReportedAt' | 'lastSeenAt' | 'platformSyncIntervalMinutes'>,
  now = new Date()
): boolean {
  if (hub.runtimeKind !== 'dinodia_os' || !hub.runtimeCapabilitiesReportedAt || !hub.lastSeenAt) return false;
  if (now.getTime() - hub.lastSeenAt.getTime() > MAX_HEARTBEAT_AGE_MS) return false;
  const intervalMinutes = Math.max(1, Number(hub.platformSyncIntervalMinutes || 2));
  if (now.getTime() - hub.runtimeCapabilitiesReportedAt.getTime() > Math.max(MAX_HEARTBEAT_AGE_MS, intervalMinutes * 3 * 60 * 1000)) return false;
  return runtimeCapabilities(hub.runtimeCapabilities).managedAreaProvisioningV1 === true;
}

export function hubRuntimeSummary(hub: Pick<DinodiaOsHubContext, 'runtimeKind' | 'runtimeVersion' | 'runtimeCapabilities' | 'runtimeCapabilitiesReportedAt' | 'lastSeenAt' | 'platformSyncIntervalMinutes'>) {
  const capabilities = runtimeCapabilities(hub.runtimeCapabilities);
  return {
    kind: hub.runtimeKind,
    version: hub.runtimeVersion,
    managedAreaProvisioningV1: isDinodiaOsManagedAreaHub(hub),
    activityIncidentReportingV1: capabilities.activityIncidentReportingV1 === true,
    capabilitiesReportedAt: hub.runtimeCapabilitiesReportedAt?.toISOString() ?? null,
  };
}

export async function getDinodiaOsHubContext(hubInstallId: string): Promise<DinodiaOsHubContext | null> {
  return prisma.hubInstall.findUnique({ where: { id: hubInstallId }, select: dinodiaOsHubSelect });
}

export async function prepareQrRoomCreation(hubInstallId: string, displayName: string, areaName: string) {
  const requestedAreaName = areaName.trim();
  const requestedDisplayName = displayName.trim();
  if (!requestedAreaName) throw new DinodiaOsAreaError(400, 'area_name_required', 'Home Assistant area name is required.');
  const hub = await getDinodiaOsHubContext(hubInstallId);
  if (!hub) throw new DinodiaOsAreaError(404, 'hub_not_found', 'Hub not found.');
  if (hub.runtimeKind !== 'dinodia_os') {
    if (!requestedDisplayName) throw new DinodiaOsAreaError(400, 'display_name_required', 'Room display name is required for Home Assistant hubs.');
    return { dinodiaOs: false, areaName: requestedAreaName, displayName: requestedDisplayName, area: null };
  }
  if (!isDinodiaOsManagedAreaHub(hub)) {
    throw new DinodiaOsAreaError(409, 'hub_heartbeat_stale', !hub.runtimeCapabilitiesReportedAt || !hub.lastSeenAt
      ? 'This Dinodia OS hub has not reported managed area provisioning yet.'
      : 'The Dinodia OS hub heartbeat is stale. Wait for the hub to reconnect and try again.');
  }
  const area = await ensureDinodiaOsArea(hubInstallId, requestedAreaName);
  return {
    dinodiaOs: true,
    areaName: area.areaName,
    displayName: requestedDisplayName || area.areaName,
    area,
  };
}

function requireManagedAreaHub(hub: DinodiaOsHubContext | null): DinodiaOsHubContext {
  if (!hub) throw new DinodiaOsAreaError(404, 'hub_not_found', 'Hub not found.');
  if (hub.runtimeKind !== 'dinodia_os') {
    throw new DinodiaOsAreaError(409, 'unsupported_hub_runtime', 'Managed area provisioning is available only for Dinodia OS hubs.');
  }
  if (!hub.runtimeCapabilitiesReportedAt || !hub.lastSeenAt) {
    throw new DinodiaOsAreaError(409, 'capability_not_reported', 'This Dinodia OS hub has not reported managed area provisioning yet.');
  }
  if (!isDinodiaOsManagedAreaHub(hub)) {
    throw new DinodiaOsAreaError(409, 'hub_heartbeat_stale', 'The Dinodia OS hub heartbeat is stale. Wait for the hub to reconnect and try again.');
  }
  if (!hub.home?.haConnection) {
    throw new DinodiaOsAreaError(409, 'ha_connection_missing', 'This hub does not have a Home Assistant-compatible connection configured.');
  }
  return hub;
}

function parseWsError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const value = error as { error?: { message?: unknown }; message?: unknown };
    if (typeof value.error?.message === 'string') return value.error.message;
    if (typeof value.message === 'string') return value.message;
  }
  return 'The Dinodia OS area registry request failed.';
}

type AreaEntry = { area_id?: string; name?: string; icon?: string };
type RegistryEntry = { area_id?: string | null; device_id?: string | null; entity_id?: string | null };

function areaFromEntry(entry: AreaEntry | undefined): { areaId: string; areaName: string } | null {
  const areaId = typeof entry?.area_id === 'string' ? entry.area_id.trim() : '';
  const areaName = typeof entry?.name === 'string' ? entry.name.trim() : '';
  return areaId && areaName ? { areaId, areaName } : null;
}

async function withAreaClient<T>(hub: DinodiaOsHubContext, work: (client: HaWsClient) => Promise<T>): Promise<T> {
  const haConnection = hub.home?.haConnection;
  if (!haConnection) throw new DinodiaOsAreaError(409, 'ha_connection_missing', 'This hub does not have a Home Assistant-compatible connection configured.');
  let token: string;
  try {
    token = resolveHaLongLivedToken(haConnection).longLivedToken;
  } catch {
    throw new DinodiaOsAreaError(409, 'ha_token_missing', 'The hub connection token is missing.');
  }
  if (!haConnection.cloudUrl?.trim()) {
    throw new DinodiaOsAreaError(409, 'cloud_url_missing', 'A Cloudflare URL is required before Company Portal can manage Dinodia OS areas.');
  }
  const target = resolveHaCloudFirst({ ...haConnection, longLivedToken: token });
  try {
    const client = await HaWsClient.connect(target);
    try {
      return await work(client);
    } finally {
      client.close();
    }
  } catch (error) {
    if (error instanceof DinodiaOsAreaError) throw error;
    throw new DinodiaOsAreaError(502, 'hub_unreachable', `Unable to reach the Dinodia OS hub: ${parseWsError(error)}`);
  }
}

async function listAreas(client: HaWsClient): Promise<{ areaId: string; areaName: string }[]> {
  const raw = await client.call<AreaEntry[]>('config/area_registry/list');
  return (raw || []).map(areaFromEntry).filter((area): area is { areaId: string; areaName: string } => Boolean(area));
}

function findArea(areas: { areaId: string; areaName: string }[], value: string) {
  const needle = value.trim();
  return areas.find((area) => area.areaId === needle || normalizeAreaName(area.areaName) === normalizeAreaName(needle)) ?? null;
}

export async function ensureDinodiaOsArea(hubInstallId: string, areaName: string) {
  const requestedName = areaName.trim();
  if (!requestedName) throw new DinodiaOsAreaError(400, 'area_name_required', 'Home Assistant area name is required.');
  const hub = requireManagedAreaHub(await getDinodiaOsHubContext(hubInstallId));
  return withAreaClient(hub, async (client) => {
    const areas = await listAreas(client);
    const existing = areas.find((area) => normalizeAreaName(area.areaName) === normalizeAreaName(requestedName));
    if (existing) return { ...existing, created: false };
    try {
      const created = await client.call<AreaEntry>('config/area_registry/create', { name: requestedName });
      const direct = areaFromEntry(created);
      if (direct && normalizeAreaName(direct.areaName) === normalizeAreaName(requestedName)) return { ...direct, created: true };
      const refreshed = await listAreas(client);
      const confirmed = refreshed.find((area) => normalizeAreaName(area.areaName) === normalizeAreaName(requestedName));
      if (!confirmed) throw new Error('The hub did not return the created area.');
      return { ...confirmed, created: true };
    } catch (error) {
      // HA-compatible registries may report a duplicate after another request won
      // the race. Re-list before surfacing the failure so retries stay idempotent.
      try {
        const refreshed = await listAreas(client);
        const raced = refreshed.find((area) => normalizeAreaName(area.areaName) === normalizeAreaName(requestedName));
        if (raced) return { ...raced, created: false };
      } catch {
        // Preserve the original, more useful create error below.
      }
      throw new DinodiaOsAreaError(502, 'area_create_failed', `Unable to create area in Dinodia OS: ${parseWsError(error)}`);
    }
  });
}

export async function inspectDinodiaOsArea(hubInstallId: string, areaName: string) {
  const hub = requireManagedAreaHub(await getDinodiaOsHubContext(hubInstallId));
  return withAreaClient(hub, async (client) => {
    const areas = await listAreas(client);
    const area = findArea(areas, areaName);
    if (!area) return { exists: false, areaId: null, areaName: areaName.trim(), deviceCount: 0, entityCount: 0 };
    const [devices, entities] = await Promise.all([
      client.call<RegistryEntry[]>('config/device_registry/list'),
      client.call<RegistryEntry[]>('config/entity_registry/list'),
    ]);
    return {
      exists: true,
      areaId: area.areaId,
      areaName: area.areaName,
      deviceCount: (devices || []).filter((entry) => entry.area_id === area.areaId).length,
      entityCount: (entities || []).filter((entry) => entry.area_id === area.areaId).length,
    };
  });
}

export async function removeDinodiaOsArea(hubInstallId: string, areaName: string) {
  const hub = requireManagedAreaHub(await getDinodiaOsHubContext(hubInstallId));
  return withAreaClient(hub, async (client) => {
    const areas = await listAreas(client);
    const area = findArea(areas, areaName);
    if (!area) return { removed: false, alreadyMissing: true, areaId: null, areaName: areaName.trim(), deviceCount: 0, entityCount: 0 };
    const [devices, entities] = await Promise.all([
      client.call<RegistryEntry[]>('config/device_registry/list'),
      client.call<RegistryEntry[]>('config/entity_registry/list'),
    ]);
    const deviceCount = (devices || []).filter((entry) => entry.area_id === area.areaId).length;
    const entityCount = (entities || []).filter((entry) => entry.area_id === area.areaId).length;
    try {
      await client.call('config/area_registry/delete', { area_id: area.areaId });
    } catch (error) {
      const message = parseWsError(error).toLowerCase();
      if (!message.includes('not found') && !message.includes('unknown')) {
        throw new DinodiaOsAreaError(502, 'area_delete_failed', `Unable to remove area from Dinodia OS: ${parseWsError(error)}`);
      }
      return { removed: false, alreadyMissing: true, areaId: area.areaId, areaName: area.areaName, deviceCount, entityCount };
    }
    return { removed: true, alreadyMissing: false, areaId: area.areaId, areaName: area.areaName, deviceCount, entityCount };
  });
}

export async function resyncDinodiaOsArea(hubInstallId: string, oldAreaName: string, newAreaName: string) {
  const oldName = oldAreaName.trim();
  const nextName = newAreaName.trim();
  if (!nextName) throw new DinodiaOsAreaError(400, 'area_name_required', 'Home Assistant area name is required.');
  const hub = requireManagedAreaHub(await getDinodiaOsHubContext(hubInstallId));
  return withAreaClient(hub, async (client) => {
    const areas = await listAreas(client);
    const oldArea = findArea(areas, oldName);
    const newArea = areas.find((area) => normalizeAreaName(area.areaName) === normalizeAreaName(nextName)) ?? null;
    if (oldArea && newArea && oldArea.areaId !== newArea.areaId) {
      const [devices, entities] = await Promise.all([
        client.call<RegistryEntry[]>('config/device_registry/list'),
        client.call<RegistryEntry[]>('config/entity_registry/list'),
      ]);
      const devicesToMove = (devices || []).filter((entry) => entry.area_id === oldArea.areaId);
      const entitiesToMove = (entities || []).filter((entry) => entry.area_id === oldArea.areaId);
      try {
        await Promise.all([
          ...devicesToMove.map((entry) => client.call('config/device_registry/update', { device_id: entry.device_id, area_id: newArea.areaId })),
          ...entitiesToMove.map((entry) => client.call('config/entity_registry/update', { entity_id: entry.entity_id, area_id: newArea.areaId })),
        ]);
        await client.call('config/area_registry/delete', { area_id: oldArea.areaId });
      } catch (error) {
        throw new DinodiaOsAreaError(502, 'area_migration_failed', `Unable to migrate the old Dinodia OS area: ${parseWsError(error)}`);
      }
      return { ...newArea, created: false, renamed: false, migrated: true };
    }
    if (newArea) return { ...newArea, created: false, renamed: false };
    if (!oldArea) {
      try {
        const created = await client.call<AreaEntry>('config/area_registry/create', { name: nextName });
        const direct = areaFromEntry(created);
        if (direct && normalizeAreaName(direct.areaName) === normalizeAreaName(nextName)) return { ...direct, created: true, renamed: false };
        const refreshed = await listAreas(client);
        const confirmed = refreshed.find((area) => normalizeAreaName(area.areaName) === normalizeAreaName(nextName));
        if (!confirmed) throw new Error('The hub did not return the created area.');
        return { ...confirmed, created: true, renamed: false };
      } catch (error) {
        if (error instanceof DinodiaOsAreaError) throw error;
        throw new DinodiaOsAreaError(502, 'area_create_failed', `Unable to create area in Dinodia OS: ${parseWsError(error)}`);
      }
    }
    try {
      const renamed = await client.call<AreaEntry>('config/area_registry/update', { area_id: oldArea.areaId, name: nextName });
      const direct = areaFromEntry(renamed);
      return { areaId: oldArea.areaId, areaName: direct?.areaName || nextName, created: false, renamed: true };
    } catch (error) {
      throw new DinodiaOsAreaError(502, 'area_update_failed', `Unable to rename area in Dinodia OS: ${parseWsError(error)}`);
    }
  });
}
