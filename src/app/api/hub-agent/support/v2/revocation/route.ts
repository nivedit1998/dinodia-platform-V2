import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { sha256 } from '@/lib/stage1Crypto';
import { createPropertySupportNotifications } from '@/lib/supportNotifications';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const sessionId = String(hub.body.sessionId ?? '');
    const lease = String(hub.body.lease ?? '');
    if (!sessionId || !lease) throw new Stage1AuthError(400, 'support_lease_invalid', 'A support lease is required');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const session = await tx.supportSession.findFirst({ where: { id: sessionId, hubInstallationId: hub.installation.id, leaseHash: sha256(lease), status: { in: ['ACTIVE', 'PENDING_HUB_REVOKE'] } }, select: { id: true, ticketId: true, accessRequestId: true, homeId: true } });
      if (!session) throw new Stage1AuthError(403, 'support_lease_denied', 'The support lease is no longer active');
      const updated = await tx.supportSession.updateMany({ where: { id: session.id, status: { in: ['ACTIVE', 'PENDING_HUB_REVOKE'] } }, data: { status: 'REVOKED', hubAcknowledgedAt: now, endedAt: now } });
      if (updated.count !== 1) throw new Stage1AuthError(403, 'support_lease_denied', 'The support lease is no longer active');
      await createPropertySupportNotifications(tx, { homeId: session.homeId, ticketId: session.ticketId, accessRequestId: session.accessRequestId, sessionId: session.id, eventType: 'REVOKED' });
    });
    return NextResponse.json({ ok: true, acknowledged: true, sessionId }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
