// Architecture: API boundary /tenant/discovery/sessions; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { CommissioningKind, MatterCommissioningStatus, Prisma, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { fetchRegistrySnapshot } from '@/lib/haRegistrySnapshot';
import { deriveStatusFromFlowStep, shapeSessionResponse } from '@/lib/matterSessions';
import { listAllowedDiscoveryFlows, isSafeDiscoverySchema, sanitizeHaStep } from '@/lib/haDiscovery';
import { continueConfigFlow, abortConfigFlow } from '@/lib/haConfigFlow';
import { prisma } from '@/lib/prisma';
import { finalizeCommissioningSuccess } from '@/lib/deviceCommissioningWorkflow';
import { CAPABILITIES } from '@/lib/deviceCapabilities';
import { buildTenantHaTechnicalName, normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { TENANT_DEVICE_LABEL_ID } from '@/lib/haLabels';
import { sendAlexaAddOrUpdateReportForHaConnection } from '@/lib/alexaEvents';
import { safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';
import { isReservedOtherLabel, OTHER_LABEL_ERROR } from '@/lib/labelValidation';
import { buildAreaAccessMatcher } from '@/lib/areaAccess';

type Body = {
  flowId?: string;
  requestedArea?: string;
  requestedName?: string | null;
  requestedDinodiaType?: string | null;
  requestedHaLabelId?: string | null;
  parentAreaName?: string | null;
  parentAreaId?: string | null;
  displayName?: string | null;
  displayLabel?: string | null;
  selectedVirtualAreaId?: string | null;
  newVirtualSubAreaName?: string | null;
};

function isValidDinodiaType(value: string | null | undefined) {
  if (!value) return true;
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

function deriveErrorMessage(step: { type?: string; errors?: Record<string, string> | undefined }) {
  if (step.type === 'abort') {
    return 'Home Assistant aborted the setup.';
  }
  const errors = step.errors ? Object.values(step.errors).filter(Boolean) : [];
  if (errors.length > 0) {
    return errors.join(', ');
  }
  return null;
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const flowId = typeof body?.flowId === 'string' ? body.flowId.trim() : '';
  const requestedAreaInput = normalizeDisplayText(body?.parentAreaName ?? body?.requestedArea);
  const requestedName =
    normalizeDisplayText(body?.displayName ?? body?.requestedName).length > 0
      ? normalizeDisplayText(body?.displayName ?? body?.requestedName)
      : null;
  const requestedDinodiaType =
    typeof body?.requestedDinodiaType === 'string'
      ? body.requestedDinodiaType.trim()
      : null;
  const requestedHaLabelId =
    typeof body?.requestedHaLabelId === 'string' && body.requestedHaLabelId.trim().length > 0
      ? body.requestedHaLabelId.trim()
      : null;
  const requestedDisplayLabel =
    normalizeDisplayText(body?.displayLabel) ||
    normalizeDisplayText(body?.requestedDinodiaType) ||
    TENANT_DEVICE_LABEL_ID;
  const selectedVirtualAreaId = normalizeDisplayText(body?.selectedVirtualAreaId) || null;
  const newVirtualSubAreaName = normalizeDisplayText(body?.newVirtualSubAreaName) || null;
  const requestedParentHaAreaId = normalizeDisplayText(body?.parentAreaId) || null;

  if (!flowId) {
    return apiFailFromStatus(400, 'Missing discovery flow id.');
  }
  if (!requestedAreaInput) {
    return apiFailFromStatus(400, 'Please choose an area.');
  }
  if (!requestedName) {
    return apiFailFromStatus(400, 'Please enter a device name.');
  }
  if (isReservedOtherLabel(requestedDisplayLabel)) {
    return apiFailFromStatus(400, OTHER_LABEL_ERROR);
  }
  if (!isValidDinodiaType(requestedDinodiaType)) {
    return apiFailFromStatus(400, 'Invalid device type override.');
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

  let allowedFlows;
  try {
    allowedFlows = await listAllowedDiscoveryFlows(ha);
  } catch (err) {
    logServerError('[api/tenant/discovery/sessions] Failed to load discovery list', err, {
      userId: user.id,
      haConnectionId: haConnection.id,
    });
    return apiFailFromStatus(502, 'We could not read discovered devices from Dinodia Hub. Please try again.');
  }

  const targetFlow = allowedFlows.find((f) => f.flowId === flowId);
  if (!targetFlow) {
    return apiFailFromStatus(404, 'This discovered device is no longer available to claim.');
  }

  let beforeSnapshot;
  try {
    beforeSnapshot = await fetchRegistrySnapshot(ha);
  } catch (err) {
    logServerError('[api/tenant/discovery/sessions] Failed to capture registry snapshot', err, {
      userId: user.id,
      haConnectionId: haConnection.id,
    });
    return apiFailFromStatus(502, 'We could not reach your Dinodia Hub to start setup. Please try again.');
  }

  let haStep;
  try {
    haStep = sanitizeHaStep(await continueConfigFlow(ha, flowId));
  } catch (err) {
    logServerError('[api/tenant/discovery/sessions] Failed to continue HA flow', err, {
      userId: user.id,
      haConnectionId: haConnection.id,
    });
    return apiFailFromStatus(502, 'Home Assistant did not accept the discovery request. Please try again.');
  }

  if (haStep.type === 'form' && !isSafeDiscoverySchema(haStep.data_schema)) {
    await abortConfigFlow(ha, haStep.flow_id ?? flowId);
    return apiFailFromStatus(400, 'This device requires setup in Home Assistant. Please complete it there first.');
  }

  const status = deriveStatusFromFlowStep(haStep);

  let session = await prisma.newDeviceCommissioningSession.create({
    data: {
      userId: user.id,
      haConnectionId: haConnection.id,
      requestedArea,
      requestedName,
      requestedDinodiaType,
      requestedHaLabelId,
      requestedDisplayLabel,
      requestedDisplayLabelKey: normalizeLookupKey(requestedDisplayLabel),
      requestedParentHaAreaId,
      requestedVirtualAreaId,
      requestedNewVirtualAreaName: newVirtualSubAreaName,
      haTechnicalName: buildTenantHaTechnicalName(user.id, requestedName),
      haFlowId: haStep.flow_id ?? flowId,
      status,
      kind: CommissioningKind.DISCOVERY,
      lastHaStep: haStep as Prisma.InputJsonValue,
      beforeDeviceIds: beforeSnapshot.deviceIds,
      beforeEntityIds: beforeSnapshot.entityIds,
      error: status === MatterCommissioningStatus.FAILED ? deriveErrorMessage(haStep) : null,
    },
  });

  const warnings: string[] = [];

  if (status === MatterCommissioningStatus.SUCCEEDED) {
    const { labelWarning, areaWarning, newEntityIds } = await finalizeCommissioningSuccess(session, ha, {
      beforeSnapshot,
    });
    if (labelWarning) warnings.push(labelWarning);
    if (areaWarning) warnings.push(areaWarning);
    session = (await prisma.newDeviceCommissioningSession.findUnique({
      where: { id: session.id },
    }))!;

    if (Array.isArray(newEntityIds) && newEntityIds.length > 0) {
      try {
        await sendAlexaAddOrUpdateReportForHaConnection({
          haConnectionId: haConnection.id,
          restrictEntityIds: newEntityIds,
        });
      } catch (err) {
        safeLog('warn', '[api/tenant/discovery/sessions] AddOrUpdateReport failed', {
          err,
          haConnectionId: haConnection.id,
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    session: shapeSessionResponse(session),
    warnings,
    flow: targetFlow,
  });
}
