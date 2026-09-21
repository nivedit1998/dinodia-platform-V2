import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticateProvisioningHubRequest } from '@/lib/provisioningHubAuth';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import crypto from 'node:crypto';

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  const lease = typeof body?.lease === 'string' ? body.lease.trim() : '';
  if (!sessionId || !lease) return apiBadRequest('A support session and lease are required.');
  const authenticated = await authenticateProvisioningHubRequest(body || {}, req, '/api/hub-agent/support/v2/revocation');
  if ('error' in authenticated) return authenticated.error;
  const hub = await prisma.hubInstall.findUnique({ where: { serial: authenticated.serial }, select: { homeId: true } });
  if (!hub?.homeId) return apiFailFromStatus(404, 'This hub is not assigned to a home.');
  const acknowledged = await prisma.supportAccessSession.updateMany({ where: { id: sessionId, homeId: hub.homeId, hubLeaseTokenHash: digest(lease), hubRevokePending: true }, data: { hubRevokePending: false, hubRevocationAcknowledgedAt: new Date(), hubRevokedAt: new Date(), hubLeaseTokenHash: null, hubLeaseExpiresAt: null } });
  if (acknowledged.count !== 1) return apiFailFromStatus(409, 'This support revocation is not pending or the lease is invalid.');
  await prisma.auditEvent.create({ data: { homeId: hub.homeId, actorUserId: null, type: 'SUPPORT_V2_REVOCATION_ACKNOWLEDGED', metadata: { sessionId, outcome: 'hub_acknowledged' } } });
  return NextResponse.json({ ok: true, sessionId, acknowledged: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}
