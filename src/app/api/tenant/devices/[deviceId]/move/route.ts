// Architecture: API boundary /tenant/devices/[deviceId]/move; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { assignHaAreaToDevices, assignHaAreaToEntities } from '@/lib/haAreas';
import { buildAreaAccessMatcher } from '@/lib/areaAccess';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await context.params;
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }
  const { user, haConnection } = await getUserWithHaConnection(me.id);
  const body = await req.json().catch(() => ({}));
  const requestedParentAreaName = normalizeDisplayText(body?.parentAreaName);
  const selectedVirtualAreaId = normalizeDisplayText(body?.selectedVirtualAreaId) || null;
  const newVirtualSubAreaName = normalizeDisplayText(body?.newVirtualSubAreaName) || null;
  if (!requestedParentAreaName) return apiFailFromStatus(400, 'Please choose an area.');
  const areaAccess = await buildAreaAccessMatcher({
    haConnectionId: haConnection.id,
    accessAreas: user.accessRules.map((rule) => rule.area),
  });
  const parentAreaName = areaAccess.resolveRequestedArea(requestedParentAreaName);
  if (!parentAreaName) {
    return apiFailFromStatus(403, 'You are not allowed to move devices to that area.');
  }
  const allowedAreas = new Set(user.accessRules.map((rule) => rule.area));
  if (!allowedAreas.has(parentAreaName)) {
    return apiFailFromStatus(403, 'You are not allowed to move devices to that area.');
  }
  const parentAreaDisplayName =
    areaAccess.displayNameForArea(parentAreaName) ?? requestedParentAreaName;

  const override = await prisma.tenantDeviceDisplayOverride.findFirst({
    where: {
      tenantUserId: user.id,
      haConnectionId: haConnection.id,
      OR: [{ haDeviceId: deviceId }, { entityId: deviceId }],
    },
  });
  if (!override) return apiFailFromStatus(404, 'Tenant-owned device not found.');

  let tenantVirtualAreaId: string | null = selectedVirtualAreaId;
  if (tenantVirtualAreaId) {
    const existing = await prisma.tenantVirtualArea.findFirst({
      where: {
        id: tenantVirtualAreaId,
        tenantUserId: user.id,
        haConnectionId: haConnection.id,
        parentHaAreaName: parentAreaName,
      },
      select: { id: true },
    });
    if (!existing) return apiFailFromStatus(400, 'Selected sub-area is not available.');
  } else if (newVirtualSubAreaName) {
    const virtualArea = await prisma.tenantVirtualArea.upsert({
      where: {
        tenantUserId_haConnectionId_parentHaAreaName_displayKey: {
          tenantUserId: user.id,
          haConnectionId: haConnection.id,
          parentHaAreaName: parentAreaName,
          displayKey: normalizeLookupKey(newVirtualSubAreaName),
        },
      },
      update: { displayName: newVirtualSubAreaName, parentAreaDisplaySnapshot: parentAreaDisplayName },
      create: {
        tenantUserId: user.id,
        haConnectionId: haConnection.id,
        parentHaAreaName: parentAreaName,
        parentAreaDisplaySnapshot: parentAreaDisplayName,
        displayName: newVirtualSubAreaName,
        displayKey: normalizeLookupKey(newVirtualSubAreaName),
      },
      select: { id: true },
    });
    tenantVirtualAreaId = virtualArea.id;
  }

  const ha = resolveHaCloudFirst(haConnection);
  const deviceIds = override.haDeviceId ? [override.haDeviceId] : [];
  const entityIds = override.entityId ? [override.entityId] : [];
  const [deviceResult, entityResult] = await Promise.all([
    assignHaAreaToDevices(ha, parentAreaName, deviceIds),
    assignHaAreaToEntities(ha, parentAreaName, entityIds),
  ]);
  if (!deviceResult.ok || !entityResult.ok) {
    return apiFailFromStatus(
      502,
      deviceResult.warning || entityResult.warning || 'We could not move this device in Home Assistant.'
    );
  }

  const updated = await prisma.tenantDeviceDisplayOverride.update({
    where: { id: override.id },
    data: {
      parentHaAreaName: parentAreaName,
      parentAreaDisplaySnapshot: parentAreaDisplayName,
      tenantVirtualAreaId,
    },
  });
  return NextResponse.json({ ok: true, device: updated });
}
