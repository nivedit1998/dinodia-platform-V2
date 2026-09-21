// Architecture: API boundary /device-control; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  DEVICE_CONTROL_NUMERIC_COMMANDS,
  executeDeviceCommand,
  executeDeviceService,
} from '@/lib/deviceControl';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { Role } from '@prisma/client';
import { bumpDevicesVersion } from '@/lib/devicesVersion';
import { getTenantOwnedTargetsForHome, getTenantOwnedTargetsForUser } from '@/lib/tenantOwnership';
import { getServicesForTargetCached } from '@/lib/homeAssistant';
import { hashForLog, safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  if (me.role !== Role.TENANT) {
    return apiFailFromStatus(403, 'Device control is available to tenants only.');
  }

  const allowed = await checkRateLimit(`device-control:${me.id}`, {
    maxRequests: 30,
    windowMs: 10_000,
  });
  if (!allowed) {
    return apiFailFromStatus(429, "You've sent a lot of commands at once. Please wait a moment and try again.");
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return apiFailFromStatus(400, 'Invalid body');
  }

  const { entityId, command, value, serviceId, serviceData } = body as {
    entityId?: string;
    command?: string;
    value?: number;
    serviceId?: string;
    serviceData?: Record<string, unknown>;
  };

  if (!entityId || (!command && !serviceId)) {
    return apiFailFromStatus(400, 'Missing entityId and command/serviceId');
  }

  if (command && DEVICE_CONTROL_NUMERIC_COMMANDS.has(command) && typeof value !== 'number') {
    return apiFailFromStatus(400, 'Command requires numeric value');
  }

  try {
    const { user, haConnection } = await getUserWithHaConnection(me.id);
    const effectiveHa = resolveHaCloudFirst(haConnection);

    if (user.role === Role.TENANT) {
      const allowedAreas = new Set(user.accessRules.map((r) => r.area));
      const devices = await getDevicesForHaConnection(haConnection.id, { bypassCache: true });
      const [tenantOwnedForHome, tenantOwnedForUser] = await Promise.all([
        getTenantOwnedTargetsForHome(user.homeId!, haConnection.id),
        getTenantOwnedTargetsForUser(user.id, haConnection.id),
      ]);
      const allTenantOwnedEntityIds = new Set(tenantOwnedForHome.entityIds);
      const ownTenantOwnedEntityIds = new Set(tenantOwnedForUser.entityIds);
      const allowedByAreaEntityIds = new Set(
        devices
          .filter((device) => device.areaName && allowedAreas.has(device.areaName))
          .map((device) => device.entityId)
      );

      const canAccess =
        ownTenantOwnedEntityIds.has(entityId) ||
        (!allTenantOwnedEntityIds.has(entityId) && allowedByAreaEntityIds.has(entityId));

      if (!canAccess) {
        return apiFailFromStatus(403, 'You are not allowed to control that device.');
      }

      if (serviceId) {
        let services: string[] = [];
        try {
          services = await getServicesForTargetCached(effectiveHa, entityId);
        } catch (err) {
          safeLog('warn', '[api/device-control] Failed to validate servicesForTarget', {
            err,
            haConnectionId: haConnection.id,
            entityIdHash: hashForLog(entityId),
          });
          return apiFailFromStatus(502, 'Dinodia Hub did not respond when validating services.');
        }
        if (!services.includes(serviceId)) {
          return apiFailFromStatus(400, 'Service is not available for that device.');
        }
      }
    }

    if (serviceId) {
      await executeDeviceService(effectiveHa, entityId, serviceId, serviceData ?? {}, {
        source: 'app',
        userId: user.id,
        haConnectionId: haConnection.id,
      });
    } else {
      await executeDeviceCommand(effectiveHa, entityId, command!, value, {
        source: 'app',
        userId: user.id,
        haConnectionId: haConnection.id,
      });
    }
    await bumpDevicesVersion(haConnection.id).catch((err) =>
      safeLog('warn', '[api/device-control] Failed to bump devicesVersion', { err, haConnectionId: haConnection.id })
    );
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logServerError('[api/device-control] error', err, { userId: me.id });
    return apiFailFromStatus(500, 'Dinodia Hub unavailable. Please refresh and try again.');
  }
}
