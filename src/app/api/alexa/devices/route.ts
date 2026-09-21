// Architecture: API boundary /alexa/devices; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { Role } from '@prisma/client';
import { resolveAlexaAuthUser } from '@/app/api/alexa/auth';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  getTenantOwnershipIndexForHome,
  isOwnedByAnotherTenantDeviceFirst,
  isOwnedByTenantDeviceFirst,
} from '@/lib/tenantOwnership';
import { resolveDeviceDisplayBatch } from '@/lib/deviceDisplayResolver';
import { hasTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';
import { logServerError } from '@/lib/serverErrorLog';

export async function GET(req: NextRequest) {
  const authUser = await resolveAlexaAuthUser(req);
  if (!authUser) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  if (authUser.role !== Role.TENANT) {
    return NextResponse.json(
      { error: 'Alexa is available to tenant accounts only.' },
      { status: 403 }
    );
  }

  try {
    const allowed = await checkRateLimit(`alexa-devices:${authUser.id}`, {
      maxRequests: 20,
      windowMs: 60_000,
    });
    if (!allowed) {
      return NextResponse.json(
        { error: 'Slow down. Please retry device discovery shortly.' },
        { status: 429 }
      );
    }

    const { user, haConnection } = await getUserWithHaConnection(authUser.id);
    const includeServicesForTarget =
      req.nextUrl.searchParams.get('include_services_for_target') === '1';
    const devices = await getDevicesForHaConnection(haConnection.id, {
      logSample: true,
      // Keep Alexa discovery fast: only fetch labeled entities (same idea as `/api/devices?fresh=1`)
      // and avoid per-entity `get_services_for_target` calls during discovery.
      labelsOnly: true,
      includeServicesForTarget,
      cacheTtlMs: includeServicesForTarget ? 300_000 : 60_000,
    });

    const ownershipIndex = await getTenantOwnershipIndexForHome({
      homeId: user.homeId!,
      haConnectionId: haConnection.id,
      currentTenantUserId: user.id,
    });

    const filteredDevices =
      user.role === Role.TENANT
        ? (() => {
            const allowedAreas = new Set((user.accessRules ?? []).map((rule) => rule.area));
            return devices.filter((device) => {
              const pending =
                (device.deviceId ? ownershipIndex.pendingDeviceIds.has(device.deviceId) : false) ||
                ownershipIndex.pendingEntityIds.has(device.entityId);
              if (pending) return false;
              if (isOwnedByTenantDeviceFirst(device, ownershipIndex, user.id)) return true;
              if (isOwnedByAnotherTenantDeviceFirst(device, ownershipIndex, user.id)) return false;
              if (hasTenantDeviceLabelValue(device.technicalLabels ?? device.labels ?? [])) return false;
              return Boolean(device.areaName && allowedAreas.has(device.areaName));
            });
          })()
        : devices;

    const resolved = await resolveDeviceDisplayBatch(filteredDevices, {
      viewer: 'alexa_tenant',
      userId: user.id,
      homeId: user.homeId!,
      haConnectionId: haConnection.id,
    });

    return NextResponse.json({ devices: resolved });
  } catch (err) {
    logServerError('[api/alexa/devices] error', err, { userId: authUser.id });
    return NextResponse.json(
      {
        error:
          'Remote access not enabled, check internet connection or enable via your iOS/Android phone or the Dinodia Kiosk',
      },
      { status: 500 }
    );
  }
}
