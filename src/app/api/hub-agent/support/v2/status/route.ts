import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { authenticateProvisioningHubRequest } from '@/lib/provisioningHubAuth';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  const lease = typeof body?.lease === 'string' ? body.lease.trim() : '';
  if (!sessionId || !lease) return apiBadRequest('A support session and lease are required.');
  const authenticated = await authenticateProvisioningHubRequest(body || {}, req, '/api/hub-agent/support/v2/status');
  if ('error' in authenticated) return authenticated.error;
  const hub = await prisma.hubInstall.findUnique({ where: { serial: authenticated.serial }, select: { homeId: true } });
  if (!hub?.homeId) return apiFailFromStatus(404, 'This hub is not assigned to a home.');
  const session = await prisma.supportAccessSession.findFirst({ where: { id: sessionId, homeId: hub.homeId, hubLeaseTokenHash: digest(lease) }, select: { status: true, scope: true, areaIds: true, targetUserId: true, includesTenantDevices: true, expiresAt: true, endedAt: true, hubRevokePending: true } });
  if (!session) return apiFailFromStatus(404, 'Support access lease not found.');
  const active = session.status === 'ACTIVE' && !session.endedAt && !session.hubRevokePending && Boolean(session.expiresAt && session.expiresAt > new Date());
  return NextResponse.json({ ok: true, active, scope: session.scope, areaIds: Array.isArray(session.areaIds) ? session.areaIds.map(String) : [], targetUserId: session.targetUserId, includesTenantDevices: session.includesTenantDevices, expiresAt: session.expiresAt?.toISOString() || null }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
