// Architecture: API boundary /admin/monitoring/dashboard-bootstrap; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { buildAdminDashboardBootstrap } from '@/lib/adminDashboardBootstrap';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  }

  try {
    const resolved = await getUserWithHaConnection(me.id);
    const payload = await buildAdminDashboardBootstrap({
      homeId: resolved.user.homeId!,
      haConnectionId: resolved.haConnection.id,
    });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'We could not load admin dashboard data right now. Please try again.' },
      { status: 400 }
    );
  }
}
