// Architecture: API boundary /tenant/matter/sessions/[id]/step; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus, apiFailPayload } from '@/lib/apiError';
import { CommissioningKind, MatterCommissioningStatus, Prisma, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { resolveHaCloudFirst } from '@/lib/haConnection';
import { continueMatterConfigFlow, HaConfigFlowStep } from '@/lib/matterConfigFlow';
import {
  deriveStatusFromFlowStep,
  findSessionForUser,
  getSessionSnapshots,
  hashCommissioningSecret,
  shapeSessionResponse,
} from '@/lib/matterSessions';
import { prisma } from '@/lib/prisma';
import { finalizeCommissioningSuccess } from '../../workflow';
import { fetchRegistrySnapshot } from '@/lib/haRegistrySnapshot';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { sendAlexaAddOrUpdateReportForHaConnection } from '@/lib/alexaEvents';
import { safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';

type StepBody = {
  setupPayload?: string | null;
  manualPairingCode?: string | null;
  wifiSsid?: string | null;
  wifiPassword?: string | null;
};

function sanitizeInput(body: unknown): StepBody {
  const obj = (body ?? {}) as Record<string, unknown>;
  const coerce = (value: unknown) =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  return {
    setupPayload: coerce(obj.setupPayload),
    manualPairingCode: coerce(obj.manualPairingCode),
    wifiSsid: coerce(obj.wifiSsid),
    wifiPassword: coerce(obj.wifiPassword),
  };
}

function buildUserInput(step: HaConfigFlowStep | null, input: StepBody) {
  const userInput: Record<string, unknown> = {};
  const schema = Array.isArray(step?.data_schema) ? step?.data_schema : [];
  const pairingCode = input.setupPayload ?? input.manualPairingCode ?? null;
  const wifiSsid = input.wifiSsid ?? null;
  const wifiPassword = input.wifiPassword ?? null;

  for (const field of schema) {
    const name =
      field && typeof field === 'object' && typeof (field as Record<string, unknown>).name === 'string'
        ? ((field as Record<string, unknown>).name as string)
        : null;
    if (!name) continue;
    const lower = name.toLowerCase();
    if (pairingCode && (lower.includes('code') || lower.includes('pin') || lower.includes('payload'))) {
      userInput[name] = pairingCode;
      continue;
    }
    if (wifiSsid && (lower.includes('ssid') || (lower.includes('network') && lower.includes('name')))) {
      userInput[name] = wifiSsid;
      continue;
    }
    if (
      wifiPassword &&
      (lower.includes('password') || lower.includes('passphrase') || lower.includes('psk'))
    ) {
      userInput[name] = wifiPassword;
    }
  }

  const existingKeys = new Set(Object.keys(userInput).map((k) => k.toLowerCase()));
  if (pairingCode && !Array.from(existingKeys).some((k) => k.includes('code') || k.includes('pin'))) {
    userInput.code = pairingCode;
  }
  if (wifiSsid && !Array.from(existingKeys).some((k) => k.includes('ssid') || k.includes('network'))) {
    userInput.wifi_ssid = wifiSsid;
  }
  if (
    wifiPassword &&
    !Array.from(existingKeys).some(
      (k) => k.includes('password') || k.includes('passphrase') || k.includes('psk')
    )
  ) {
    userInput.wifi_password = wifiPassword;
  }

  return userInput;
}

function deriveErrorMessage(step: HaConfigFlowStep) {
  if (step.type === 'abort') {
    return 'Home Assistant aborted the commissioning flow.';
  }
  const errors = step.errors ? Object.values(step.errors).filter(Boolean) : [];
  if (errors.length > 0) {
    return errors.join(', ');
  }
  return null;
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await context.params;
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  if (!sessionId) {
    return apiFailFromStatus(400, 'Missing session id');
  }

  let session = await findSessionForUser(sessionId, me.id, { kind: CommissioningKind.MATTER });
  if (!session) {
    return apiFailFromStatus(404, 'Session not found');
  }

  if (
    session.status === MatterCommissioningStatus.SUCCEEDED ||
    session.status === MatterCommissioningStatus.FAILED ||
    session.status === MatterCommissioningStatus.CANCELED
  ) {
    return apiFailPayload(400, {
      error: 'This commissioning session is already finished.',
      session: shapeSessionResponse(session),
    });
  }

  const haConnection = await prisma.haConnection.findUnique({
    where: { id: session.haConnectionId },
    select: {
      baseUrl: true,
      cloudUrl: true,
      longLivedToken: true,
      haUsername: true,
      haUsernameCiphertext: true,
      haPassword: true,
      haPasswordCiphertext: true,
      longLivedTokenCiphertext: true,
    },
  });
  if (!haConnection) {
    return apiFailFromStatus(400, 'Dinodia Hub connection is no longer available for this session.');
  }
  const ha = resolveHaCloudFirst({ ...haConnection, ...resolveHaLongLivedToken(haConnection) });

  let { before } = getSessionSnapshots(session);
  if (!before) {
    try {
      before = await fetchRegistrySnapshot(ha);
      session = await prisma.newDeviceCommissioningSession.update({
        where: { id: session.id },
        data: {
          beforeDeviceIds: before.deviceIds,
          beforeEntityIds: before.entityIds,
        },
      });
    } catch (err) {
      safeLog('warn', '[api/tenant/matter/sessions/step] Failed to capture fallback snapshot', {
        err,
        userId: me.id,
        haConnectionId: session.haConnectionId,
      });
    }
  }

  const body = sanitizeInput(await req.json().catch(() => ({})));
  if (!body.setupPayload && !body.manualPairingCode && !body.wifiSsid && !body.wifiPassword) {
    return apiFailFromStatus(400, 'Pairing details are required to continue commissioning.');
  }
  if ((body.wifiSsid && !body.wifiPassword) || (!body.wifiSsid && body.wifiPassword)) {
    return apiFailFromStatus(400, 'Please provide both Wi-Fi name and password.');
  }

  const flowId = session.haFlowId ?? (session.lastHaStep as HaConfigFlowStep | null)?.flow_id ?? null;
  if (!flowId) {
    return apiFailFromStatus(400, 'The commissioning flow is not available. Please start a new session.');
  }

  const userInput = buildUserInput(session.lastHaStep as HaConfigFlowStep | null, body);

  let haStep: HaConfigFlowStep;
  try {
    haStep = await continueMatterConfigFlow(ha, flowId, userInput);
  } catch (err) {
    logServerError('[api/tenant/matter/sessions/step] Failed to continue HA flow', err, {
      userId: me.id,
      haConnectionId: session.haConnectionId,
    });
    return apiFailFromStatus(502, 'Home Assistant did not accept the commissioning details. Please try again.');
  }

  const status = deriveStatusFromFlowStep(haStep);
  const setupPayloadHash = hashCommissioningSecret(body.setupPayload) ?? session.setupPayloadHash;
  const manualPairingCodeHash =
    hashCommissioningSecret(body.manualPairingCode) ?? session.manualPairingCodeHash;
  const updateData: Prisma.NewDeviceCommissioningSessionUpdateInput = {
    status,
    haFlowId: haStep.flow_id ?? session.haFlowId,
    lastHaStep: haStep as Prisma.InputJsonValue,
    setupPayloadHash,
    manualPairingCodeHash,
    error: status === MatterCommissioningStatus.FAILED ? deriveErrorMessage(haStep) : null,
  };

  const warnings: string[] = [];

  if (status === MatterCommissioningStatus.SUCCEEDED) {
    const updated = await prisma.newDeviceCommissioningSession.update({
      where: { id: session.id },
      data: updateData,
    });
    const { labelWarning, areaWarning, newEntityIds } = await finalizeCommissioningSuccess(updated, ha, {
      beforeSnapshot: before ?? undefined,
    });
    if (labelWarning) warnings.push(labelWarning);
    if (areaWarning) warnings.push(areaWarning);
    session = (await prisma.newDeviceCommissioningSession.findUnique({
      where: { id: session.id },
    }))!;

    if (Array.isArray(newEntityIds) && newEntityIds.length > 0) {
      try {
        await sendAlexaAddOrUpdateReportForHaConnection({
          haConnectionId: session.haConnectionId,
          restrictEntityIds: newEntityIds,
        });
      } catch (err) {
        safeLog('warn', '[api/tenant/matter/sessions/step] AddOrUpdateReport failed', {
          err,
          haConnectionId: session.haConnectionId,
        });
      }
    }
  } else {
    session = await prisma.newDeviceCommissioningSession.update({
      where: { id: session.id },
      data: updateData,
    });
  }

  return NextResponse.json({
    ok: true,
    session: shapeSessionResponse(session),
    warnings,
  });
}
