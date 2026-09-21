// Architecture: API boundary /tenant/discovery/sessions/[id]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { CommissioningKind, MatterCommissioningStatus, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { findSessionForUser, shapeSessionResponse } from '@/lib/matterSessions';
import { checkCommissionedDeviceVisibility } from '@/lib/tenantDashboardVisibility';

function normalizeIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string');
}

function deriveNewIds(beforeValues: unknown, afterValues: unknown): string[] {
  const before = new Set(normalizeIds(beforeValues));
  return normalizeIds(afterValues).filter((value) => !before.has(value));
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await context.params;
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  if (!sessionId) {
    return apiFailFromStatus(400, 'Missing session id');
  }

  const session = await findSessionForUser(sessionId, me.id, { kind: CommissioningKind.DISCOVERY });
  if (!session) {
    return apiFailFromStatus(404, 'Session not found');
  }

  let resolvedSession = session;
  if (session.status === MatterCommissioningStatus.IN_PROGRESS) {
    const visibility = await checkCommissionedDeviceVisibility({
      userId: me.id,
      newDeviceIds: deriveNewIds(session.beforeDeviceIds, session.afterDeviceIds),
      newEntityIds: deriveNewIds(session.beforeEntityIds, session.afterEntityIds),
      fresh: true,
    });
    if (visibility.visible) {
      resolvedSession = await prisma.newDeviceCommissioningSession.update({
        where: { id: session.id },
        data: {
          status: MatterCommissioningStatus.SUCCEEDED,
          error: null,
        },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    session: shapeSessionResponse(resolvedSession),
  });
}
