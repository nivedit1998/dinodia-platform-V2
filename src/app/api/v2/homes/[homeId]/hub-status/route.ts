import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!uuid.test(homeId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Hub status is unavailable for this selected membership');
    }
    const hub = await prisma.hubInstallation.findFirst({
      where: { id: selected.hubInstallationId, homeId, lifecycleStatus: 'ACTIVE' },
      select: { state: true, lastSeenAt: true, cleanupState: true, cleanupGeneration: true, runtimeVersion: true, updatePhase: true, updateStatusAt: true },
    });
    if (!hub) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Hub status is unavailable for this selected membership');
    const now = new Date();
    const ageSeconds = hub.lastSeenAt ? (now.getTime() - hub.lastSeenAt.getTime()) / 1000 : null;
    const status = ageSeconds === null || ageSeconds < -30 ? 'UNKNOWN' : ageSeconds <= 420 ? 'ONLINE' : 'OFFLINE';
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, homeId, hub: {
      status, lastHeartbeatAt: hub.lastSeenAt?.toISOString() ?? null,
      lastOnlineAt: hub.lastSeenAt?.toISOString() ?? null, cleanupState: hub.cleanupState,
      cleanupGeneration: hub.cleanupGeneration, runtimeVersion: hub.runtimeVersion,
      updatePhase: hub.updatePhase, updateStatusAt: hub.updateStatusAt?.toISOString() ?? null,
    } }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
