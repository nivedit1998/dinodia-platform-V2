import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { alexaScopeForRole, isAlexaEligibleRole } from '@/lib/alexaScope';

function nativeModeEnabled(homeId: number) {
  if (String(process.env.ALEXA_NATIVE_DINODIA_OS_ENABLED || '').toLowerCase() !== 'true') return false;
  const allowlist = String(process.env.ALEXA_NATIVE_DINODIA_OS_HOME_ALLOWLIST || '').trim();
  if (!allowlist || allowlist === '*') return true;
  return new Set(allowlist.split(',').map((value) => Number(value.trim())).filter(Number.isFinite)).has(homeId);
}

function text(value: unknown, fallback: string) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

export async function getNativeAlexaContext(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, homeId: true, home: { select: { haConnectionId: true } }, accessRules: { select: { area: true } } },
  });
  if (!user || !isAlexaEligibleRole(user.role)) throw Object.assign(new Error('Alexa is not available for this account.'), { statusCode: 403, code: 'alexa_role_forbidden' });
  if (!user.homeId) throw Object.assign(new Error('This account is not assigned to a home.'), { statusCode: 403, code: 'home_required' });
  if (!nativeModeEnabled(user.homeId)) throw Object.assign(new Error('Native Alexa is not enabled for this home.'), { statusCode: 409, code: 'legacy_source_required' });

  const connection = await prisma.alexaHomeConnection.findUnique({
    where: { homeId: user.homeId },
    include: { endpoints: true },
  });
  if (!connection || connection.status !== 'LINKED') throw Object.assign(new Error('Alexa is not linked to this home.'), { statusCode: 409, code: 'alexa_not_linked' });
  const maxStaleSeconds = Math.max(60, Number(process.env.ALEXA_NATIVE_CATALOG_MAX_STALE_SECONDS || 900));
  if (!connection.catalogUpdatedAt || Date.now() - connection.catalogUpdatedAt.getTime() > maxStaleSeconds * 1000) throw Object.assign(new Error('Native Alexa catalogue is stale.'), { statusCode: 409, code: 'legacy_source_required' });

  const [areas, devices, tenantOverrides] = await Promise.all([
    prisma.areaDisplayOverride.findMany({ where: { haConnectionId: user.home?.haConnectionId ?? -1 }, select: { haAreaName: true, displayName: true } }),
    prisma.device.findMany({ where: { haConnectionId: user.home?.haConnectionId ?? -1 }, select: { entityId: true, name: true } }),
    user.role === Role.TENANT
      ? prisma.tenantDeviceDisplayOverride.findMany({ where: { tenantUserId: user.id, haConnectionId: user.home?.haConnectionId ?? -1 }, select: { haDeviceId: true, entityId: true, displayName: true } })
      : Promise.resolve([]),
  ]);
  const areaMap = new Map(areas.map((area) => [area.haAreaName, area.displayName]));
  const deviceMap = new Map(devices.map((device) => [device.entityId, device.name]));
  const tenantDeviceMap = new Map<string, string>();
  for (const override of tenantOverrides) {
    if (override.haDeviceId) tenantDeviceMap.set(override.haDeviceId, override.displayName);
    if (override.entityId) tenantDeviceMap.set(override.entityId, override.displayName);
  }
  const allowedAreas = new Set(user.accessRules.map((rule) => rule.area));
  const visible = user.role === Role.ADMIN
    ? connection.endpoints
    : connection.endpoints.filter((endpoint) => allowedAreas.has(endpoint.originalAreaName));

  return {
    user,
    connection,
    scope: alexaScopeForRole(user.role),
    endpoints: visible.filter((endpoint) => !endpoint.retiredAt).map((endpoint) => ({
      ...endpoint,
      displayDeviceName: text(tenantDeviceMap.get(endpoint.deviceId) || deviceMap.get(endpoint.deviceId), endpoint.originalDeviceName),
      displayAreaName: text(areaMap.get(endpoint.originalAreaName), endpoint.originalAreaName),
    })),
  };
}

export function toAlexaDiscoveryEndpoint(endpoint: Awaited<ReturnType<typeof getNativeAlexaContext>>['endpoints'][number]) {
  return {
    endpointId: endpoint.endpointId,
    friendlyName: endpoint.displayDeviceName,
    description: endpoint.description || `Dinodia ${endpoint.displayAreaName} device`,
    displayCategories: Array.isArray(endpoint.displayCategories) ? endpoint.displayCategories : ['OTHER'],
    manufacturerName: endpoint.manufacturerName || 'Dinodia',
    ...(endpoint.modelName ? { cookie: { modelName: endpoint.modelName } } : {}),
    capabilities: endpoint.capabilities,
  };
}

export function toAlexaContextProperties(endpoint: Awaited<ReturnType<typeof getNativeAlexaContext>>['endpoints'][number]) {
  return Array.isArray(endpoint.state) ? endpoint.state : [];
}
