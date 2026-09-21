// Architecture: API boundary /tenant/matter/sessions/[id]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { CommissioningKind, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { findSessionForUser, shapeSessionResponse } from '@/lib/matterSessions';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await context.params;
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  if (!sessionId) {
    return apiFailFromStatus(400, 'Missing session id');
  }

  const session = await findSessionForUser(sessionId, me.id, { kind: CommissioningKind.MATTER });
  if (!session) {
    return apiFailFromStatus(404, 'Session not found');
  }

  return NextResponse.json({
    ok: true,
    session: shapeSessionResponse(session),
  });
}
