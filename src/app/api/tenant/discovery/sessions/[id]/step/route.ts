// Architecture: API boundary /tenant/discovery/sessions/[id]/step; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus, apiFailPayload } from '@/lib/apiError';
import { CommissioningKind, MatterCommissioningStatus, Prisma, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { resolveHaCloudFirst } from '@/lib/haConnection';
import { continueConfigFlow, abortConfigFlow } from '@/lib/haConfigFlow';
import {
  deriveStatusFromFlowStep,
  findSessionForUser,
  getSessionSnapshots,
  shapeSessionResponse,
} from '@/lib/matterSessions';
import { prisma } from '@/lib/prisma';
import { fetchRegistrySnapshot } from '@/lib/haRegistrySnapshot';
import { finalizeCommissioningSuccess } from '@/lib/deviceCommissioningWorkflow';
import { isSafeDiscoverySchema, sanitizeHaStep } from '@/lib/haDiscovery';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { sendAlexaAddOrUpdateReportForHaConnection } from '@/lib/alexaEvents';
import { safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';

type Body = {
  userInput?: Record<string, unknown>;
};

function sanitizeUserInput(raw: Body | unknown): Record<string, unknown> {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ((raw as Body).userInput ?? raw)
      : {};
  if (!obj || typeof obj !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof key !== 'string') continue;
    if (typeof value === 'string') {
      result[key] = value.trim();
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (value === null) {
      result[key] = null;
    }
  }
  return result;
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

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await context.params;
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  if (!sessionId) {
    return apiFailFromStatus(400, 'Missing session id');
  }

  let session = await findSessionForUser(sessionId, me.id, { kind: CommissioningKind.DISCOVERY });
  if (!session) {
    return apiFailFromStatus(404, 'Session not found');
  }

  if (
    session.status === MatterCommissioningStatus.SUCCEEDED ||
    session.status === MatterCommissioningStatus.FAILED ||
    session.status === MatterCommissioningStatus.CANCELED
  ) {
    return apiFailPayload(400, {
      error: 'This setup session is already finished.',
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
      safeLog('warn', '[api/tenant/discovery/sessions/step] Failed to capture fallback snapshot', {
        err,
        userId: me.id,
        haConnectionId: session.haConnectionId,
      });
    }
  }

  const userInput = sanitizeUserInput(await req.json().catch(() => ({})));
  const lastHaStep = session.lastHaStep as { flow_id?: string } | null;
  const flowId = session.haFlowId ?? lastHaStep?.flow_id ?? null;
  if (!flowId) {
    return apiFailFromStatus(400, 'The discovery flow is not available. Please start a new session.');
  }

  let haStep;
  try {
    haStep = sanitizeHaStep(await continueConfigFlow(ha, flowId, userInput));
  } catch (err) {
    logServerError('[api/tenant/discovery/sessions/step] Failed to continue HA flow', err, {
      userId: me.id,
      haConnectionId: session.haConnectionId,
    });
    return apiFailFromStatus(502, 'Home Assistant did not accept the details. Please try again.');
  }

  if (haStep.type === 'form' && !isSafeDiscoverySchema(haStep.data_schema)) {
    await abortConfigFlow(ha, haStep.flow_id ?? flowId);
    session = await prisma.newDeviceCommissioningSession.update({
      where: { id: session.id },
      data: {
        status: MatterCommissioningStatus.FAILED,
        lastHaStep: haStep as Prisma.InputJsonValue,
        error: 'This device requires setup in Home Assistant. Please finish it there.',
      },
    });
    return apiFailPayload(400, {
      error: 'This device requires setup in Home Assistant. Please finish it there.',
      session: shapeSessionResponse(session),
    });
  }

  const status = deriveStatusFromFlowStep(haStep);
  const updateData: Prisma.NewDeviceCommissioningSessionUpdateInput = {
    status,
    haFlowId: haStep.flow_id ?? session.haFlowId,
    lastHaStep: haStep as Prisma.InputJsonValue,
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
        safeLog('warn', '[api/tenant/discovery/sessions/step] AddOrUpdateReport failed', {
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
