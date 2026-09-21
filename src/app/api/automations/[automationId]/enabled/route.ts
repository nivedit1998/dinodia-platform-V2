// Architecture: API boundary /automations/[automationId]/enabled; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaForRequestedMode } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import {
  type HaAutomationConfig,
  extractEntityIdsFromAutomationConfig,
  getAutomationConfig,
  setAutomationEnabled,
} from '@/lib/homeAssistantAutomations';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { getTenantOwnedTargetsForHome, getTenantOwnedTargetsForUser } from '@/lib/tenantOwnership';
import { prisma } from '@/lib/prisma';
import { logServerError } from '@/lib/serverErrorLog';

function badRequest(message: string) {
  return apiFailFromStatus(400, message);
}

function forbidden(message: string) {
  return apiFailFromStatus(403, message);
}

function parseMode(value: string | null): 'home' | 'cloud' | undefined {
  if (value === 'home' || value === 'cloud') return value;
  return undefined;
}

function normalizeAutomationId(raw: string) {
  return raw.trim().replace(/^automation\./i, '');
}

function buildDeviceMappings(devices: Awaited<ReturnType<typeof getDevicesForHaConnection>>) {
  const deviceIdToEntities = new Map<string, string[]>();
  devices.forEach((device) => {
    if (!device.deviceId) return;
    const existing = deviceIdToEntities.get(device.deviceId) ?? [];
    existing.push(device.entityId);
    deviceIdToEntities.set(device.deviceId, existing);
  });
  return { deviceIdToEntities };
}

function collectAutomationEntities(
  config: HaAutomationConfig,
  deviceIdToEntities: Map<string, string[]>
) {
  const { triggerEntities, conditionEntities, actionEntities, actionDeviceIds } =
    extractEntityIdsFromAutomationConfig(config);
  const actionEntitiesWithDevices = new Set(actionEntities);
  actionDeviceIds.forEach((deviceId) => {
    const mapped = deviceIdToEntities.get(deviceId);
    mapped?.forEach((entityId) => actionEntitiesWithDevices.add(entityId));
  });
  return new Set<string>([
    ...triggerEntities,
    ...conditionEntities,
    ...actionEntitiesWithDevices,
  ]);
}

async function getAllowedEntitiesForUser(args: {
  userId: number;
  role: Role;
  homeId: number;
  haConnectionId: number;
}) {
  const { userId, role, homeId, haConnectionId } = args;
  const devices = await getDevicesForHaConnection(haConnectionId, { bypassCache: true });
  const allTenantOwnedTargets = await getTenantOwnedTargetsForHome(homeId, haConnectionId);
  const allTenantOwnedEntityIds = new Set(allTenantOwnedTargets.entityIds);

  if (role === Role.ADMIN) {
    return new Set(
      devices
        .map((device) => device.entityId)
        .filter((entityId) => !allTenantOwnedEntityIds.has(entityId))
    );
  }

  const rules = await prisma.accessRule.findMany({ where: { userId } });
  const allowedAreas = new Set(rules.map((rule) => rule.area));
  const allowedByArea = devices
    .filter((device) => device.areaName && allowedAreas.has(device.areaName))
    .map((device) => device.entityId);

  const ownTenantTargets = await getTenantOwnedTargetsForUser(userId, haConnectionId);
  return new Set([...allowedByArea, ...ownTenantTargets.entityIds]);
}

async function guardAdminDevice(req: NextRequest, user: { id: number; role: Role }) {
  if (user.role !== Role.ADMIN) return null;
  try {
    await requireTrustedAdminDevice(req, user.id);
    return null;
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ automationId: string }> }
) {
  const user = await getCurrentUserFromRequest(req);
  if (!user) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const deviceError = await guardAdminDevice(req, user as { id: number; role: Role });
  if (deviceError) return deviceError;

  const { automationId: rawAutomationId } = await context.params;
  const automationId = normalizeAutomationId(rawAutomationId);
  if (!automationId) return badRequest('Missing automation id');

  const mode = parseMode(req.nextUrl.searchParams.get('mode'));
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).enabled !== 'boolean') {
    return badRequest('enabled must be provided as boolean');
  }
  const enabled = (body as Record<string, unknown>).enabled as boolean;

  let homeId: number;
  let haConnectionId: number;
  let ha;
  try {
    const result = await getUserWithHaConnection(user.id);
    if (!result.user.homeId) {
      return apiFailFromStatus(400, 'Dinodia Hub connection isn’t linked to a home.');
    }
    homeId = result.user.homeId;
    haConnectionId = result.haConnection.id;
    ha = resolveHaForRequestedMode(result.haConnection, mode);
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  const allowlisted = await prisma.homeAutomation.findUnique({
    where: { homeId_automationId: { homeId, automationId } },
    select: { automationId: true },
  });
  if (!allowlisted) {
    return apiFailFromStatus(404, 'Automation not found.');
  }

  const [config, allowedEntities, allTenantOwnedTargets, devices] = await Promise.all([
    getAutomationConfig(ha, automationId),
    getAllowedEntitiesForUser({ userId: user.id, role: user.role as Role, homeId, haConnectionId }),
    getTenantOwnedTargetsForHome(homeId, haConnectionId),
    getDevicesForHaConnection(haConnectionId, { bypassCache: true }),
  ]);
  if (!config) {
    return apiFailFromStatus(404, 'Automation not found.');
  }

  const { deviceIdToEntities } = buildDeviceMappings(devices);
  const allEntities = collectAutomationEntities(config, deviceIdToEntities);
  const allTenantOwnedEntityIds = new Set(allTenantOwnedTargets.entityIds);

  if (user.role === Role.TENANT && !Array.from(allEntities).every((entityId) => allowedEntities.has(entityId))) {
    return forbidden('You cannot edit an automation that controls a device outside your areas.');
  }
  if (user.role === Role.ADMIN && Array.from(allEntities).some((entityId) => allTenantOwnedEntityIds.has(entityId))) {
    return apiFailFromStatus(404, 'Automation not found.');
  }

  try {
    await setAutomationEnabled(ha, `automation.${automationId}`, enabled);
    await prisma.auditEvent.create({
      data: {
        type: AuditEventType.AUTOMATION_UPDATED,
        homeId,
        actorUserId: user.id,
        metadata: {
          automationId,
          mode: mode ?? 'cloud',
          enabled,
          entities: Array.from(allEntities),
        },
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logServerError('[api/automations/[id]/enabled] Failed to toggle automation', err, {
      userId: user.id,
      haConnectionId,
    });
    return apiFailFromStatus(502, 'Dinodia Hub unavailable. Please refresh and try again.');
  }
}
