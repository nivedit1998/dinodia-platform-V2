// Architecture: API boundary /admin/monitoring/electric-light-dashboard; authenticates the homeowner and delegates Light estimate analytics.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { buildAdminElectricLightDashboard } from '@/lib/adminElectricLightDashboard';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  try {
    const { haConnection } = await getUserWithHaConnection(me.id);
    const payload = await buildAdminElectricLightDashboard({ haConnectionId: haConnection.id, searchParams: new URL(req.url).searchParams });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'We could not load lighting usage right now.' }, { status: 400 });
  }
}
