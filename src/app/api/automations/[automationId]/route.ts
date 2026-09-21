// Architecture: API boundary /automations/[automationId]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaForRequestedMode } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import {
  AutomationDraft,
  type HaAutomationConfig,
  buildHaAutomationConfigFromDraft,
  deleteAutomation as deleteAutomationConfig,
  ensureDinodiaManagedMarker,
  extractEntityIdsFromAutomationConfig,
  getAutomationConfig,
  setAutomationEnabled,
  updateAutomation,
} from '@/lib/homeAssistantAutomations';
import { getAdvancedServicesForDevice, isDeviceCommandId, type DeviceCommandId } from '@/lib/deviceCapabilities';
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
        .map((d) => d.entityId)
        .filter((entityId) => !allTenantOwnedEntityIds.has(entityId))
    );
  }

  const rules = await prisma.accessRule.findMany({ where: { userId } });
  const allowedAreas = new Set(rules.map((r) => r.area));
  const allowedByArea = devices
    .filter((d) => d.areaName && allowedAreas.has(d.areaName))
    .map((d) => d.entityId);

  const ownTenantTargets = await getTenantOwnedTargetsForUser(userId, haConnectionId);
  return new Set([...allowedByArea, ...ownTenantTargets.entityIds]);
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

function parseDraft(body: unknown): AutomationDraft | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  const alias = typeof obj.alias === 'string' ? obj.alias.trim() : '';
  if (!alias) return null;
  const description = typeof obj.description === 'string' ? obj.description : undefined;
  const mode =
    obj.mode === 'single' ||
    obj.mode === 'restart' ||
    obj.mode === 'queued' ||
    obj.mode === 'parallel'
      ? obj.mode
      : undefined;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : undefined;

  const triggerRaw = obj.trigger as Record<string, unknown> | undefined;
  const actionRaw = obj.action as Record<string, unknown> | undefined;
  if (!triggerRaw || !actionRaw) return null;

  let trigger: AutomationDraft['trigger'] | null = null;
  if (triggerRaw.type === 'state') {
    const entityId = typeof triggerRaw.entityId === 'string' ? (triggerRaw.entityId as string) : null;
    if (!entityId) return null;
    trigger = {
      type: 'state',
      entityId,
      to:
        typeof triggerRaw.to === 'string' || typeof triggerRaw.to === 'number'
          ? (triggerRaw.to as string | number)
          : undefined,
    };
  } else if (triggerRaw.type === 'device') {
    const entityId = typeof triggerRaw.entityId === 'string' ? (triggerRaw.entityId as string) : null;
    const mode =
      triggerRaw.mode === 'state_equals' ||
      triggerRaw.mode === 'attribute_delta' ||
      triggerRaw.mode === 'position_equals'
        ? (triggerRaw.mode as 'state_equals' | 'attribute_delta' | 'position_equals')
        : null;
    if (!entityId || !mode) return null;
    const attribute =
      typeof triggerRaw.attribute === 'string'
        ? (triggerRaw.attribute as string)
        : Array.isArray(triggerRaw.attribute) && triggerRaw.attribute.every((v) => typeof v === 'string')
          ? (triggerRaw.attribute as string[])
          : undefined;
    const weekdays =
      Array.isArray(triggerRaw.weekdays) && triggerRaw.weekdays.every((v) => typeof v === 'string')
        ? (triggerRaw.weekdays as string[])
        : [];
    trigger = {
      type: 'device',
      entityId,
      mode,
      to:
        typeof triggerRaw.to === 'string' || typeof triggerRaw.to === 'number'
          ? (triggerRaw.to as string | number)
          : undefined,
      direction:
        triggerRaw.direction === 'increased' || triggerRaw.direction === 'decreased'
          ? (triggerRaw.direction as 'increased' | 'decreased')
          : undefined,
      attribute,
      weekdays,
    };
  } else if (triggerRaw.type === 'schedule') {
    const scheduleType = triggerRaw.scheduleType === 'weekly' ? (triggerRaw.scheduleType as 'weekly') : null;
    const at = typeof triggerRaw.at === 'string' ? (triggerRaw.at as string) : null;
    if (!scheduleType || !at) return null;
    const weekdays =
      Array.isArray(triggerRaw.weekdays) && triggerRaw.weekdays.every((v) => typeof v === 'string')
        ? (triggerRaw.weekdays as string[])
        : [];
    trigger = {
      type: 'schedule',
      scheduleType,
      at,
      weekdays,
    };
  }

  if (!trigger) return null;

  let action: AutomationDraft['action'] | null = null;
  if (actionRaw.type === 'toggle' || actionRaw.type === 'turn_on' || actionRaw.type === 'turn_off') {
    const entityId = typeof actionRaw.entityId === 'string' ? (actionRaw.entityId as string) : null;
    if (!entityId) return null;
    action = { type: actionRaw.type, entityId };
  } else if (actionRaw.type === 'set_brightness') {
    const entityId = typeof actionRaw.entityId === 'string' ? (actionRaw.entityId as string) : null;
    if (!entityId || typeof actionRaw.value !== 'number') return null;
    action = { type: 'set_brightness', entityId, value: actionRaw.value };
  } else if (actionRaw.type === 'set_temperature') {
    const entityId = typeof actionRaw.entityId === 'string' ? (actionRaw.entityId as string) : null;
    if (!entityId || typeof actionRaw.value !== 'number') return null;
    action = { type: 'set_temperature', entityId, value: actionRaw.value };
  } else if (actionRaw.type === 'set_cover_position') {
    const entityId = typeof actionRaw.entityId === 'string' ? (actionRaw.entityId as string) : null;
    if (!entityId || typeof actionRaw.value !== 'number') return null;
    action = { type: 'set_cover_position', entityId, value: actionRaw.value };
  } else if (actionRaw.type === 'device_command') {
    const entityId = typeof actionRaw.entityId === 'string' ? (actionRaw.entityId as string) : null;
    const rawCommand = typeof actionRaw.command === 'string' ? actionRaw.command : null;
    const command = rawCommand && isDeviceCommandId(rawCommand) ? (rawCommand as DeviceCommandId) : null;
    const value =
      typeof actionRaw.value === 'number' || typeof actionRaw.value === 'string'
        ? (actionRaw.value as number | string)
        : undefined;
    if (!entityId || !command) return null;
    action = { type: 'device_command', entityId, command, value };
  } else if (actionRaw.type === 'ha_service') {
    const entityId = typeof actionRaw.entityId === 'string' ? (actionRaw.entityId as string) : null;
    const serviceId = typeof actionRaw.serviceId === 'string' ? (actionRaw.serviceId as string).trim() : '';
    const rawData = actionRaw.serviceData as unknown;
    const serviceData =
      rawData && typeof rawData === 'object' && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : {};
    if (!entityId || !serviceId) return null;
    action = { type: 'ha_service', entityId, serviceId, serviceData };
  }

  if (!action) return null;

  return {
    alias,
    description,
    mode,
    enabled,
    trigger,
    action,
  };
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

export async function PATCH(
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
  const draft = parseDraft(await req.json().catch(() => null));
  if (!draft) {
    return badRequest('Invalid automation payload');
  }

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

  const [allowedEntities, allTenantOwnedTargets, devices, existingConfig] = await Promise.all([
    getAllowedEntitiesForUser({ userId: user.id, role: user.role as Role, homeId, haConnectionId }),
    getTenantOwnedTargetsForHome(homeId, haConnectionId),
    getDevicesForHaConnection(haConnectionId, { bypassCache: true }),
    getAutomationConfig(ha, automationId),
  ]);
  const allTenantOwnedEntityIds = new Set(allTenantOwnedTargets.entityIds);
  if (!existingConfig) {
    return apiFailFromStatus(404, 'Automation not found.');
  }
  const { deviceIdToEntities } = buildDeviceMappings(devices);
  const existingEntities = collectAutomationEntities(existingConfig, deviceIdToEntities);
  if (user.role === Role.TENANT && !Array.from(existingEntities).every((entityId) => allowedEntities.has(entityId))) {
    return forbidden('You cannot edit an automation that controls a device outside your areas.');
  }
  if (user.role === Role.ADMIN && Array.from(existingEntities).some((entityId) => allTenantOwnedEntityIds.has(entityId))) {
    return apiFailFromStatus(404, 'Automation not found.');
  }

  const config = buildHaAutomationConfigFromDraft(draft, automationId);
  config.description = ensureDinodiaManagedMarker(config.description);

  const combined = collectAutomationEntities(config, deviceIdToEntities);

  if (user.role === Role.TENANT && !Array.from(combined).every((entityId) => allowedEntities.has(entityId))) {
    return forbidden('You cannot edit an automation that controls a device outside your areas.');
  }

  if (user.role === Role.ADMIN && Array.from(combined).some((entityId) => allTenantOwnedEntityIds.has(entityId))) {
    return apiFailFromStatus(404, 'Automation not found.');
  }

  if (draft.action.type === 'ha_service') {
    const device = devices.find((d) => d.entityId === draft.action.entityId) ?? null;
    if (!device) {
      return badRequest('Unknown action entity');
    }
    const allowedServiceIds = new Set(getAdvancedServicesForDevice(device).map((s) => s.serviceId));
    if (!allowedServiceIds.has(draft.action.serviceId)) {
      return badRequest('Unsupported advanced service for this device');
    }
  }

  try {
    await updateAutomation(ha, automationId, config);
    if (draft.enabled !== undefined) {
      await setAutomationEnabled(ha, `automation.${automationId}`, draft.enabled);
    }

    await prisma.auditEvent.create({
      data: {
        type: AuditEventType.AUTOMATION_UPDATED,
        homeId,
        actorUserId: user.id,
        metadata: {
          automationId,
          mode: mode ?? 'cloud',
          enabled: draft.enabled,
          entities: Array.from(combined),
        },
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logServerError('[api/automations/[id]] Failed to update automation', err, {
      userId: user.id,
      haConnectionId,
    });
    return apiFailFromStatus(502, 'Dinodia Hub unavailable. Please refresh and try again.');
  }
}

export async function DELETE(
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
  const recordOnly = req.nextUrl.searchParams.get('recordOnly') === '1';

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

  if (recordOnly) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.automationOwnership.deleteMany({
          where: {
            automationId,
            homeId,
          },
        });
        await tx.homeAutomation.deleteMany({
          where: {
            automationId,
            homeId,
          },
        });
      });
      return NextResponse.json({ ok: true });
    } catch {
      return apiFailFromStatus(400, 'Failed to delete automation tracking. Please try again.');
    }
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

  const allTenantOwnedEntityIds = new Set(allTenantOwnedTargets.entityIds);
  const { deviceIdToEntities } = buildDeviceMappings(devices);
  const combined = collectAutomationEntities(config, deviceIdToEntities);

  if (user.role === Role.TENANT && !Array.from(combined).every((entityId) => allowedEntities.has(entityId))) {
    return forbidden('You cannot delete an automation that controls a device outside your areas.');
  }

  if (user.role === Role.ADMIN && Array.from(combined).some((entityId) => allTenantOwnedEntityIds.has(entityId))) {
    return apiFailFromStatus(404, 'Automation not found.');
  }

  try {
    try {
      await deleteAutomationConfig(ha, automationId);
    } catch (err) {
      const message = err instanceof Error ? err.message.toLowerCase() : '';
      const notFound = message.includes('not found') || message.includes('404');
      if (!notFound) {
        throw err;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.automationOwnership.deleteMany({
        where: {
          automationId,
          homeId,
        },
      });
      await tx.homeAutomation.deleteMany({
        where: {
          automationId,
          homeId,
        },
      });
      await tx.auditEvent.create({
        data: {
          type: AuditEventType.AUTOMATION_DELETED,
          homeId,
          actorUserId: user.id,
          metadata: {
            automationId,
            mode: mode ?? 'cloud',
            entities: Array.from(combined),
          },
        },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logServerError('[api/automations/[id]] Failed to delete automation', err, {
      userId: user.id,
      haConnectionId,
    });
    return apiFailFromStatus(502, 'Dinodia Hub unavailable. Please refresh and try again.');
  }
}
