import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const sessionId = String(hub.body.sessionId ?? '').trim();
    const lease = String(hub.body.lease ?? '').trim();
    if (!sessionId || !lease) throw new Stage1AuthError(400, 'support_status_invalid', 'A support session and lease are required');
    const session = await prisma.supportSession.findUnique({ where: { id: sessionId }, select: { id: true, status: true, expiresAt: true, desiredRevokedAt: true, scope: true, areaIds: true, targetMembershipId: true, targetUserId: true, hubInstallationId: true, leaseHash: true } });
    const active = Boolean(session && session.hubInstallationId === hub.installation.id && session.leaseHash === sha256(lease) && session.status === 'ACTIVE' && !session.desiredRevokedAt && session.expiresAt > new Date());
    return NextResponse.json({ ok: true, active, ...(active && session ? { expiresAt: session.expiresAt, scope: session.scope, areaIds: session.areaIds, targetMembershipId: session.targetMembershipId, targetUserId: session.targetUserId } : {}) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
