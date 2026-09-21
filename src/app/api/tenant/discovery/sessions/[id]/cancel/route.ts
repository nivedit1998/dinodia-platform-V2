// Architecture: API boundary /tenant/discovery/sessions/[id]/cancel; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { CommissioningKind, MatterCommissioningStatus, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { resolveHaCloudFirst } from '@/lib/haConnection';
import { abortConfigFlow } from '@/lib/haConfigFlow';
import { findSessionForUser, shapeSessionResponse } from '@/lib/matterSessions';
import { prisma } from '@/lib/prisma';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';

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
    session.status === MatterCommissioningStatus.CANCELED
  ) {
    return NextResponse.json({
      ok: true,
      session: shapeSessionResponse(session),
    });
  }

  if (session.haFlowId) {
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
    if (haConnection) {
      const ha = resolveHaCloudFirst({ ...haConnection, ...resolveHaLongLivedToken(haConnection) });
      await abortConfigFlow(ha, session.haFlowId);
    }
  }

  session = await prisma.newDeviceCommissioningSession.update({
    where: { id: session.id },
    data: {
      status: MatterCommissioningStatus.CANCELED,
      error: 'Setup was canceled by the user.',
    },
  });

  return NextResponse.json({
    ok: true,
    session: shapeSessionResponse(session),
  });
}
