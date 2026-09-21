import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticateProvisioningHubRequest } from '@/lib/provisioningHubAuth';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const ticketId = typeof body?.ticketId === 'string' ? body.ticketId.trim() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const employeeProof = typeof body?.employeeProof === 'string' ? body.employeeProof.trim() : '';
  if (!ticketId || !code || !employeeProof) return apiBadRequest('A support ticket, one-use code and assigned employee proof are required.');
  const authenticated = await authenticateProvisioningHubRequest(body || {}, req, '/api/hub-agent/support/v2/redeem');
  if ('error' in authenticated) return authenticated.error;
  const hub = await prisma.hubInstall.findUnique({ where: { serial: authenticated.serial }, select: { id: true, homeId: true } });
  if (!hub?.homeId) return apiFailFromStatus(404, 'This hub is not assigned to a home.');
  const session = await prisma.supportAccessSession.findFirst({ where: { supportRequestId: ticketId, homeId: hub.homeId } });
  if (!session) return apiFailFromStatus(404, 'Support access request not found.');
  const now = new Date();
  if (session.status !== 'APPROVED' || !session.codeHash || !session.employeeProofHash || !session.codeExpiresAt || !session.employeeProofExpiresAt || !session.expiresAt || session.redeemedAt || session.endedAt || now >= session.codeExpiresAt || now >= session.employeeProofExpiresAt || now >= session.expiresAt || session.codeAttemptCount >= 5) return apiFailFromStatus(409, 'The support access code is invalid, expired or already used.');
  const attempt = await prisma.supportAccessSession.updateMany({ where: { id: session.id, status: 'APPROVED', redeemedAt: null, endedAt: null, expiresAt: { gt: now }, codeExpiresAt: { gt: now }, employeeProofExpiresAt: { gt: now }, codeAttemptCount: { lt: 5 } }, data: { codeAttemptCount: { increment: 1 } } });
  if (attempt.count !== 1) return apiFailFromStatus(409, 'The support access code is invalid, expired or already used.');
  const lease = `dno_lease_${crypto.randomBytes(32).toString('base64url')}`;
  const redeemed = await prisma.supportAccessSession.updateMany({ where: { id: session.id, status: 'APPROVED', codeHash: digest(code), employeeProofHash: digest(employeeProof), redeemedAt: null, endedAt: null, expiresAt: { gt: now }, codeExpiresAt: { gt: now }, employeeProofExpiresAt: { gt: now }, codeAttemptCount: { lte: 5 } }, data: { status: 'ACTIVE', redeemedAt: now, employeeProofHash: null, employeeProofExpiresAt: null, hubLeaseTokenHash: digest(lease), hubLeaseExpiresAt: session.expiresAt } });
  if (redeemed.count !== 1) return apiFailFromStatus(409, 'The support access code is invalid, expired or already used.');
  await prisma.auditEvent.create({ data: { homeId: hub.homeId, actorUserId: null, type: 'SUPPORT_V2_ACCESS_REDEEMED', metadata: { sessionId: session.id, ticketId, supportScope: session.scope, targetUserId: session.targetUserId, outcome: 'hub_redeemed' } } });
  return NextResponse.json({ ok: true, sessionId: session.id, lease, scope: session.scope, areaIds: Array.isArray(session.areaIds) ? session.areaIds.map(String) : [], targetUserId: session.targetUserId, includesTenantDevices: session.includesTenantDevices, expiresAt: session.expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
