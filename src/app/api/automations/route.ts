// Architecture: API boundary /automations; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { requireUserFromRequest } from '@/lib/apiGuards';
import { getUserWithHaConnection, resolveHaForRequestedMode } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { summarizeAutomation } from '@/lib/automationSummaries';
import {
  AutomationDraft,
  buildHaAutomationConfigFromDraft,
  createAutomation,
  ensureDinodiaManagedMarker,
  extractEntityIdsFromAutomationConfig,
  getAutomationConfig,
  hasDinodiaManagedMarker,
  listAutomationConfigs,
  setAutomationEnabled,
  stripDinodiaManagedMarker,
} from '@/lib/homeAssistantAutomations';
import type { DeviceCommandId } from '@/lib/deviceCapabilities';
import { getAdvancedServicesForDevice, isDeviceCommandId } from '@/lib/deviceCapabilities';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { prisma } from '@/lib/prisma';
import { getTenantOwnedTargetsForHome, getTenantOwnedTargetsForUser } from '@/lib/tenantOwnership';
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

function buildDeviceMappings(devices: Awaited<ReturnType<typeof getDevicesForHaConnection>>) {
  const entityToDeviceId = new Map(devices.map((d) => [d.entityId, d.deviceId ?? null]));
  const deviceIdToEntities = new Map<string, string[]>();
  devices.forEach((d) => {
    if (!d.deviceId) return;
    const existing = deviceIdToEntities.get(d.deviceId) ?? [];
    existing.push(d.entityId);
    deviceIdToEntities.set(d.deviceId, existing);
  });
  return { entityToDeviceId, deviceIdToEntities };
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

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const deviceError = await guardAdminDevice(req, user as { id: number; role: Role });
  if (deviceError) return deviceError;

  const entityFilter = req.nextUrl.searchParams.get('entityId');
  const mode = parseMode(req.nextUrl.searchParams.get('mode'));

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

  const [allowedRows, allowedEntities, devices, allTenantOwnedTargets] = await Promise.all([
    prisma.homeAutomation.findMany({ where: { homeId }, select: { automationId: true } }),
    getAllowedEntitiesForUser({ userId: user.id, role: user.role as Role, homeId, haConnectionId }),
    getDevicesForHaConnection(haConnectionId, { bypassCache: true }),
    getTenantOwnedTargetsForHome(homeId, haConnectionId),
  ]);

  const allowlistedAutomationIds = new Set(
    allowedRows.map((row) => normalizeAutomationId(row.automationId)).filter(Boolean)
  );
  if (allowlistedAutomationIds.size === 0) {
    return NextResponse.json({ ok: true, automations: [] });
  }

  const allTenantOwnedEntityIds = new Set(allTenantOwnedTargets.entityIds);
  const { entityToDeviceId, deviceIdToEntities } = buildDeviceMappings(devices);
  const selectedDeviceId = entityFilter ? entityToDeviceId.get(entityFilter) ?? null : null;

  let configs;
  try {
    configs = await listAutomationConfigs(ha);
  } catch (err) {
    logServerError('[api/automations] Failed to list automations', err, { userId: user.id, haConnectionId });
    return apiFailFromStatus(502, 'Failed to fetch automations from Home Assistant');
  }

  const shaped = configs
    .filter((config) => allowlistedAutomationIds.has(normalizeAutomationId(config.id)))
    .map((config) => {
      const { triggerEntities, conditionEntities, actionEntities, actionDeviceIds, hasTemplates } =
        extractEntityIdsFromAutomationConfig(config);

      const actionList = Array.from(actionEntities);
      const actionDeviceList = Array.from(actionDeviceIds ?? []);
      if (actionList.length === 0 && actionDeviceList.length === 0) return null;

      const actionEntitiesWithDevices = new Set(actionList);
      actionDeviceList.forEach((deviceId) => {
        const mapped = deviceIdToEntities.get(deviceId);
        mapped?.forEach((entityId) => actionEntitiesWithDevices.add(entityId));
      });

      const allEntities = new Set<string>([
        ...triggerEntities,
        ...conditionEntities,
        ...actionEntitiesWithDevices,
      ]);

      if (user.role === Role.TENANT && !Array.from(allEntities).every((entityId) => allowedEntities.has(entityId))) {
        return null;
      }

      if (user.role === Role.ADMIN && Array.from(allEntities).some((entityId) => allTenantOwnedEntityIds.has(entityId))) {
        return null;
      }

      const matchesFilter =
        !entityFilter ||
        actionEntitiesWithDevices.has(entityFilter) ||
        (selectedDeviceId &&
          (actionDeviceList.includes(selectedDeviceId) ||
            Array.from(actionEntitiesWithDevices).some(
              (entityId) => entityToDeviceId.get(entityId) === selectedDeviceId
            )));
      if (!matchesFilter) return null;

      const cleanedDescription = stripDinodiaManagedMarker(config.description ?? '');
      const cleanRaw = {
        ...config,
        description: cleanedDescription,
      };
      const summary = summarizeAutomation({ raw: cleanRaw }, devices);
      const basicSummary = cleanedDescription.trim() || config.alias;

      return {
        id: normalizeAutomationId(config.id),
        entityId: config.entityId ?? `automation.${normalizeAutomationId(config.id)}`,
        alias: config.alias,
        description: cleanedDescription,
        mode: config.mode ?? 'single',
        entities: actionList,
        actionDeviceIds: actionDeviceList,
        hasTemplates,
        canEdit: !hasTemplates,
        basicSummary,
        triggerSummary: summary.triggerSummary,
        actionSummary: summary.actionSummary,
        primaryName: summary.primaryName,
        raw: {
          ...cleanRaw,
        },
        enabled: config.enabled ?? true,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return NextResponse.json({ ok: true, automations: shaped });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUserFromRequest(req);
  } catch {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const recordOnly = req.nextUrl.searchParams.get('recordOnly') === '1';
  const mode = parseMode(req.nextUrl.searchParams.get('mode'));

  const deviceError = await guardAdminDevice(req, user as { id: number; role: Role });
  if (deviceError) return deviceError;

  if (recordOnly) {
    const body = await req.json().catch(() => null);
    const automationIdRaw =
      body &&
      typeof body === 'object' &&
      (body as Record<string, unknown>) !== null &&
      typeof (body as Record<string, unknown>).automationId === 'string'
        ? (body as Record<string, unknown>).automationId
        : null;
    const automationId = typeof automationIdRaw === 'string' ? normalizeAutomationId(automationIdRaw) : '';
    if (!automationId) {
      return badRequest('automationId is required for record-only mode');
    }

    try {
      const result = await getUserWithHaConnection(user.id);
      if (!result.user.homeId) {
        return apiFailFromStatus(400, 'Dinodia Hub connection isn’t linked to a home.');
      }
      const ha = resolveHaForRequestedMode(result.haConnection, mode);
      const config = await getAutomationConfig(ha, automationId);
      if (!config || !hasDinodiaManagedMarker(config.description)) {
        return forbidden('Only Dinodia-managed automations can be synced.');
      }

      const [allowedEntities, allTenantOwnedTargets, devices] = await Promise.all([
        getAllowedEntitiesForUser({
          userId: result.user.id,
          role: result.user.role as Role,
          homeId: result.user.homeId,
          haConnectionId: result.haConnection.id,
        }),
        getTenantOwnedTargetsForHome(result.user.homeId, result.haConnection.id),
        getDevicesForHaConnection(result.haConnection.id, { bypassCache: true }),
      ]);
      const allTenantOwnedEntityIds = new Set(allTenantOwnedTargets.entityIds);
      const { deviceIdToEntities } = buildDeviceMappings(devices);
      const { triggerEntities, conditionEntities, actionEntities, actionDeviceIds } =
        extractEntityIdsFromAutomationConfig(config);
      const actionEntitiesWithDevices = new Set(actionEntities);
      actionDeviceIds.forEach((deviceId) => {
        const mapped = deviceIdToEntities.get(deviceId);
        mapped?.forEach((entityId) => actionEntitiesWithDevices.add(entityId));
      });
      const combined = new Set<string>([
        ...triggerEntities,
        ...conditionEntities,
        ...actionEntitiesWithDevices,
      ]);

      if (
        result.user.role === Role.TENANT &&
        !Array.from(combined).every((entityId) => allowedEntities.has(entityId))
      ) {
        return forbidden('You cannot sync an automation that controls a device outside your areas.');
      }

      if (
        result.user.role === Role.ADMIN &&
        Array.from(combined).some((entityId) => allTenantOwnedEntityIds.has(entityId))
      ) {
        return apiFailFromStatus(404, 'Automation not found.');
      }

      await prisma.$transaction(async (tx) => {
        await tx.automationOwnership.upsert({
          where: { automationId_homeId: { automationId, homeId: result.user.homeId! } },
          update: { userId: result.user.id },
          create: { automationId, homeId: result.user.homeId!, userId: result.user.id },
        });
        await tx.homeAutomation.upsert({
          where: { homeId_automationId: { homeId: result.user.homeId!, automationId } },
          update: { createdByUserId: result.user.id },
          create: {
            homeId: result.user.homeId!,
            automationId,
            createdByUserId: result.user.id,
            source: 'DINODIA_UI',
          },
        });
        await tx.auditEvent.create({
          data: {
            type: AuditEventType.AUTOMATION_CREATED,
            homeId: result.user.homeId!,
            actorUserId: result.user.id,
            metadata: {
              automationId,
              mode: mode ?? 'cloud',
              recordOnly: true,
            },
          },
        });
      });

      return NextResponse.json({ ok: true });
    } catch (err) {
      logServerError('[api/automations] recordOnly failed', err, { userId: user.id });
      return apiFailFromStatus(400, 'We could not record this automation. Please try again.');
    }
  }

  const draft = parseDraft(await req.json().catch(() => null));
  if (!draft) {
    return badRequest('Invalid automation payload');
  }

  let homeId: number;
  let haConnectionId: number;
  let ha;
  try {
    const result = await getUserWithHaConnection(user.id);
    if (!result.user.homeId) throw new Error('Dinodia Hub connection isn’t linked to a home.');
    homeId = result.user.homeId;
    haConnectionId = result.haConnection.id;
    ha = resolveHaForRequestedMode(result.haConnection, mode);
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  const allowedEntities = await getAllowedEntitiesForUser({
    userId: user.id,
    role: user.role as Role,
    homeId,
    haConnectionId,
  });

  const config = buildHaAutomationConfigFromDraft(draft);
  config.description = ensureDinodiaManagedMarker(config.description);

  const { triggerEntities, conditionEntities, actionEntities } = extractEntityIdsFromAutomationConfig(config);
  const combined = new Set<string>([
    ...triggerEntities,
    ...conditionEntities,
    ...actionEntities,
  ]);
  const allAllowed = Array.from(combined).every((entityId) => allowedEntities.has(entityId));
  if (!allAllowed) {
    return forbidden('You cannot create an automation that controls a device outside your areas.');
  }

  if (draft.action.type === 'ha_service') {
    const devices = await getDevicesForHaConnection(haConnectionId, { bypassCache: true });
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
    const result = await createAutomation(ha, config);
    const automationId = normalizeAutomationId((result as { id?: string })?.id ?? config.id);

    await prisma.$transaction(async (tx) => {
      await tx.automationOwnership.upsert({
        where: { automationId_homeId: { automationId, homeId } },
        update: { userId: user.id },
        create: { automationId, homeId, userId: user.id },
      });
      await tx.homeAutomation.upsert({
        where: { homeId_automationId: { homeId, automationId } },
        update: { createdByUserId: user.id },
        create: {
          homeId,
          automationId,
          createdByUserId: user.id,
          source: 'DINODIA_UI',
        },
      });
      await tx.auditEvent.create({
        data: {
          type: AuditEventType.AUTOMATION_CREATED,
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

    if (draft.enabled !== undefined) {
      await setAutomationEnabled(ha, `automation.${automationId}`, draft.enabled);
    }

    return NextResponse.json({ ok: true, id: automationId });
  } catch (err) {
    logServerError('[api/automations] Failed to create automation', err, { userId: user.id, haConnectionId });
    return apiFailFromStatus(502, 'Dinodia Hub unavailable. Please refresh and try again.');
  }
}
