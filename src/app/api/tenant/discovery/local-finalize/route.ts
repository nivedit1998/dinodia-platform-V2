// Architecture: API boundary /tenant/discovery/local-finalize; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { CommissioningKind, MatterCommissioningStatus, Prisma, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { shapeSessionResponse } from '@/lib/matterSessions';
import { prisma } from '@/lib/prisma';
import { finalizeCommissioningSuccess } from '@/lib/deviceCommissioningWorkflow';
import { buildTenantHaTechnicalName, normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { sendAlexaAddOrUpdateReportForHaConnection } from '@/lib/alexaEvents';
import { safeLog } from '@/lib/safeLogger';
import { isReservedOtherLabel, OTHER_LABEL_ERROR } from '@/lib/labelValidation';
import { buildAreaAccessMatcher } from '@/lib/areaAccess';
import { waitForCommissionedDeviceVisibility } from '@/lib/tenantDashboardVisibility';
import { invalidateTenantInventoryBootstrap } from '@/lib/tenantInventoryBootstrap';
import { invalidateDevicesSnapshotCache } from '@/lib/devicesSnapshot';
import { clearTriggerDeviceInventoryCache } from '@/lib/triggerDevices';

type Body = {
  beforeDeviceIds?: string[];
  beforeEntityIds?: string[];
  newDeviceIds?: string[];
  newEntityIds?: string[];
  parentAreaName?: string | null;
  parentAreaId?: string | null;
  displayName?: string | null;
  displayLabel?: string | null;
  selectedVirtualAreaId?: string | null;
  newVirtualSubAreaName?: string | null;
  flowId?: string | null;
  haTechnicalName?: string | null;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const beforeDeviceIds = toStringArray(body?.beforeDeviceIds);
  const beforeEntityIds = toStringArray(body?.beforeEntityIds);
  const explicitNewDeviceIds = toStringArray(body?.newDeviceIds);
  const explicitNewEntityIds = toStringArray(body?.newEntityIds);
  const requestedAreaInput = normalizeDisplayText(body?.parentAreaName);
  const requestedName = normalizeDisplayText(body?.displayName);
  const requestedDisplayLabel = normalizeDisplayText(body?.displayLabel);
  const selectedVirtualAreaId = normalizeDisplayText(body?.selectedVirtualAreaId) || null;
  const newVirtualSubAreaName = normalizeDisplayText(body?.newVirtualSubAreaName) || null;
  const requestedParentHaAreaId = normalizeDisplayText(body?.parentAreaId) || null;
  const flowId = normalizeDisplayText(body?.flowId) || null;
  const requestedHaTechnicalName = normalizeDisplayText(body?.haTechnicalName);

  if (!requestedAreaInput) {
    return apiFailFromStatus(400, 'Please choose an area.');
  }
  if (!requestedName) {
    return apiFailFromStatus(400, 'Please enter a device name.');
  }
  if (!requestedDisplayLabel) {
    return apiFailFromStatus(400, 'Please enter a label.');
  }
  if (isReservedOtherLabel(requestedDisplayLabel)) {
    return apiFailFromStatus(400, OTHER_LABEL_ERROR);
  }

  let user;
  let haConnection;
  try {
    ({ user, haConnection } = await getUserWithHaConnection(me.id));
  } catch {
    return apiFailFromStatus(400, "Dinodia Hub connection isn't set up yet for this home.");
  }

  const areaAccess = await buildAreaAccessMatcher({
    haConnectionId: haConnection.id,
    accessAreas: user.accessRules.map((rule) => rule.area),
  });
  const requestedArea = areaAccess.resolveRequestedArea(requestedAreaInput);
  if (!requestedArea) {
    return apiFailFromStatus(403, 'You are not allowed to add devices to that area.');
  }
  const allowedAreas = new Set(user.accessRules.map((r) => r.area));
  if (!allowedAreas.has(requestedArea)) {
    return apiFailFromStatus(403, 'You are not allowed to add devices to that area.');
  }
  const requestedAreaDisplayName =
    areaAccess.displayNameForArea(requestedArea) ?? requestedAreaInput;

  const existingName = await prisma.tenantDeviceDisplayOverride.findFirst({
    where: {
      tenantUserId: user.id,
      haConnectionId: haConnection.id,
      displayNameKey: normalizeLookupKey(requestedName),
    },
    select: { id: true },
  });
  if (existingName) {
    return apiFailFromStatus(409, 'You already have a device with this name. Please choose another name.');
  }

  let requestedVirtualAreaId: string | null = selectedVirtualAreaId;
  if (requestedVirtualAreaId) {
    const virtualArea = await prisma.tenantVirtualArea.findFirst({
      where: {
        id: requestedVirtualAreaId,
        tenantUserId: user.id,
        haConnectionId: haConnection.id,
        parentHaAreaName: requestedArea,
      },
      select: { id: true },
    });
    if (!virtualArea) return apiFailFromStatus(400, 'Selected sub-area is not available.');
  } else if (newVirtualSubAreaName) {
    const virtualArea = await prisma.tenantVirtualArea.upsert({
      where: {
        tenantUserId_haConnectionId_parentHaAreaName_displayKey: {
          tenantUserId: user.id,
          haConnectionId: haConnection.id,
          parentHaAreaName: requestedArea,
          displayKey: normalizeLookupKey(newVirtualSubAreaName),
        },
      },
      update: { displayName: newVirtualSubAreaName, parentAreaDisplaySnapshot: requestedAreaDisplayName },
      create: {
        tenantUserId: user.id,
        haConnectionId: haConnection.id,
        parentHaAreaName: requestedArea,
        parentAreaDisplaySnapshot: requestedAreaDisplayName,
        displayName: newVirtualSubAreaName,
        displayKey: normalizeLookupKey(newVirtualSubAreaName),
      },
      select: { id: true },
    });
    requestedVirtualAreaId = virtualArea.id;
  }

  const ha = resolveHaCloudFirst(haConnection);
  const afterDeviceIds = Array.from(new Set([...beforeDeviceIds, ...explicitNewDeviceIds]));
  const afterEntityIds = Array.from(new Set([...beforeEntityIds, ...explicitNewEntityIds]));

  const session = await prisma.newDeviceCommissioningSession.create({
    data: {
      userId: user.id,
      haConnectionId: haConnection.id,
      requestedArea,
      requestedName,
      requestedDisplayLabel,
      requestedDisplayLabelKey: normalizeLookupKey(requestedDisplayLabel),
      requestedParentHaAreaId,
      requestedVirtualAreaId,
      requestedNewVirtualAreaName: newVirtualSubAreaName,
      haTechnicalName: requestedHaTechnicalName || buildTenantHaTechnicalName(user.id, requestedName),
      haFlowId: flowId,
      status: MatterCommissioningStatus.IN_PROGRESS,
      kind: CommissioningKind.DISCOVERY,
      lastHaStep: {
        type: 'create_entry',
        flow_id: flowId,
      } as Prisma.InputJsonValue,
      beforeDeviceIds,
      beforeEntityIds,
      afterDeviceIds,
      afterEntityIds,
    },
  });

  const { labelWarning, areaWarning, newDeviceIds, newEntityIds } = await finalizeCommissioningSuccess(session, ha, {
    beforeSnapshot: { deviceIds: beforeDeviceIds, entityIds: beforeEntityIds },
    discoveredDeviceIds: explicitNewDeviceIds,
    discoveredEntityIds: explicitNewEntityIds,
    skipHaMutations: explicitNewDeviceIds.length > 0 || explicitNewEntityIds.length > 0,
  });

  if (newDeviceIds.length === 0 && newEntityIds.length === 0) {
    await prisma.newDeviceCommissioningSession.update({
      where: { id: session.id },
      data: {
        status: MatterCommissioningStatus.FAILED,
        error: 'No new Zigbee device was created on your Dinodia Hub. Please try again.',
      },
    });
    return apiFailFromStatus(409, 'No new Zigbee device was created on your Dinodia Hub. Please try again.');
  }

  invalidateDevicesSnapshotCache(haConnection.id);
  invalidateTenantInventoryBootstrap(user.id);
  clearTriggerDeviceInventoryCache();

  await prisma.newDeviceCommissioningSession.update({
    where: { id: session.id },
    data: {
      status: MatterCommissioningStatus.SUCCEEDED,
      error: null,
    },
  });

  const visibility = await waitForCommissionedDeviceVisibility({
    userId: user.id,
    newDeviceIds,
    newEntityIds,
    timeoutMs: 10_000,
    pollIntervalMs: 750,
  });

  const visibilityWarning =
    visibility.visible
      ? null
      : 'Dinodia finished adding the device. Dashboard refresh may take a few more seconds.';

  if (newEntityIds.length > 0) {
    try {
      await sendAlexaAddOrUpdateReportForHaConnection({
        haConnectionId: haConnection.id,
        restrictEntityIds: newEntityIds,
      });
    } catch (err) {
      safeLog('warn', '[api/tenant/discovery/local-finalize] AddOrUpdateReport failed', {
        err,
        haConnectionId: haConnection.id,
      });
    }
  }

  const finalSession = (await prisma.newDeviceCommissioningSession.findUnique({
    where: { id: session.id },
  }))!;

  return NextResponse.json({
    ok: true,
    session: shapeSessionResponse(finalSession),
    localFinalizeSucceeded: true,
    visibilityVerified: visibility.visible,
    visibilitySurface: visibility.surface,
    warnings: [labelWarning, areaWarning, visibilityWarning].filter(Boolean),
  });
}
