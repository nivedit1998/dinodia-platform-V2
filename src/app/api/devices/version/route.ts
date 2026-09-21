// Architecture: API boundary /devices/version; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { prisma } from '@/lib/prisma';
import { logApiHit } from '@/lib/requestLog';
import { Role } from '@prisma/client';

export async function GET(req: NextRequest) {
  logApiHit(req, '/api/devices/version');

  const me = await getCurrentUserFromRequest(req);
  if (!me) {
    return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  }

  if (me.role === Role.ADMIN) {
    return NextResponse.json(
      { error: 'Admin dashboards are observe-only.' },
      { status: 403 }
    );
  }

  const { haConnection } = await getUserWithHaConnection(me.id);
  const row = await prisma.haConnection.findUnique({
    where: { id: haConnection.id },
  });

  if (!row) {
    return NextResponse.json({ error: 'HA connection not found' }, { status: 404 });
  }

  const devicesVersion = (row as { devicesVersion?: number }).devicesVersion ?? 0;
  return NextResponse.json({ haConnectionId: row.id, devicesVersion });
}
