// Stage 1: Dinodia OS is the only consumer of this one-use handoff. The
// opaque value is not a reusable credential and is never returned to Portal.
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { consumeDurableOperatorHandoffForHub } from '@/lib/operatorSessionHandoffStore';
import { checkRateLimit } from '@/lib/rateLimit';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { hashRequestBody, verifyHubRequestSignature } from '@/lib/hubSignedRequests';

function privateKey() {
  const value = String(process.env.DINODIA_OPERATOR_PRIVATE_KEY || '').trim();
  return value ? crypto.createPrivateKey(value) : null;
}

function createOperatorToken(employeeId: number, serial: string, workflow: string, now: number, key: crypto.KeyObject, support?: { scope: string; areaIds: string[]; targetUserId: number | null; includesTenantDevices: boolean }) {
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    iss: 'dinodia-platform',
    aud: `dinodia-os:${serial}`,
    sub: String(employeeId),
    sid: crypto.randomUUID(),
    jti: crypto.randomUUID(),
    hubId: serial,
    scope: support ? ['os:support'] : ['os:admin'],
    workflow,
    iat: issuedAt,
    exp: issuedAt + 15 * 60,
    recentAuthAt: now,
    ...(support ? { supportScope: support.scope, areaIds: support.areaIds, targetUserId: support.targetUserId, includesTenantDevices: support.includesTenantDevices } : {}),
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const input = `${encode({ alg: 'EdDSA', typ: 'DNO-OPS-1' })}.${encode(payload)}`;
  return { token: `dno1.${input}.${crypto.sign(null, Buffer.from(input), key).toString('base64url')}`, expiresAt: new Date((issuedAt + 15 * 60) * 1000) };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const handoff = typeof body.handoff === 'string' ? body.handoff.trim() : '';
  const serial = typeof body.serial === 'string' ? body.serial.trim() : '';
  if (!handoff || handoff.length > 512 || !serial) return apiBadRequest('A one-use handoff and hub serial are required.');
  if (!(await checkRateLimit(`os-access-consume-hub:${serial}`, { maxRequests: 10, windowMs: 15 * 60_000 }))) return apiFailFromStatus(429, 'Too many OS handoff attempts.');
  const identity = await prisma.hubManufacturingIdentity.findUnique({ where: { serial }, select: { id: true, signingPublicKey: true, status: true, revokedAt: true } });
  if (!identity || identity.status === 'REVOKED' || identity.revokedAt) return apiFailFromStatus(401, 'The Dinodia hub identity is not trusted.');
  const timestamp = Number(req.headers.get('x-dinodia-hub-timestamp') || 0);
  const nonce = String(req.headers.get('x-dinodia-hub-nonce') || '');
  const signature = String(req.headers.get('x-dinodia-hub-signature') || '');
  let publicKey: crypto.KeyObject;
  try { publicKey = crypto.createPublicKey(identity.signingPublicKey); } catch { return apiFailFromStatus(401, 'The Dinodia hub identity is invalid.'); }
  if (!verifyHubRequestSignature({ method: 'POST', path: '/api/hub-agent/operator-session/consume', timestamp, nonce, signature, bodyHash: hashRequestBody(body), publicKey })) return apiFailFromStatus(401, 'A valid hub signature is required.');
  try {
    await prisma.hubAgentNonce.create({ data: { serial, nonce, ts: BigInt(timestamp) } });
  } catch {
    return apiFailFromStatus(409, 'This hub request has already been used.');
  }
  const hub = await prisma.hubInstall.findUnique({ where: { serial }, select: { id: true, homeId: true, manufacturingIdentityId: true } });
  if (!hub || hub.homeId == null || hub.manufacturingIdentityId !== identity.id) return apiFailFromStatus(404, 'Unknown or unassigned hub.');
  const consumed = await consumeDurableOperatorHandoffForHub({ value: handoff, hubInstallId: hub.id });
  if (!consumed) return apiFailFromStatus(409, 'The handoff is expired, already consumed or not bound to this hub.');
  const key = privateKey();
  if (!key) return apiFailFromStatus(503, 'Dinodia OS operator signing is not configured.');
  let support: { scope: string; areaIds: string[]; targetUserId: number | null; includesTenantDevices: boolean } | undefined;
  if (consumed.workflow === 'SUPPORT') {
    const session = await prisma.supportAccessSession.findFirst({
      where: { OR: [{ id: consumed.workflowId }, { supportRequestId: consumed.workflowId }], homeId: consumed.homeId, assignedEmployeeId: consumed.employeeId },
      select: { status: true, scope: true, areaIds: true, targetUserId: true, includesTenantDevices: true, approvedAt: true, expiresAt: true, endedAt: true, hubRevokePending: true },
    });
    if (!session || session.status !== 'ACTIVE' || !session.approvedAt || !session.expiresAt || session.expiresAt <= new Date() || session.endedAt || session.hubRevokePending) return apiFailFromStatus(403, 'The approved support lease is not active.');
    support = { scope: session.scope, areaIds: Array.isArray(session.areaIds) ? session.areaIds.map(String) : [], targetUserId: session.targetUserId, includesTenantDevices: session.includesTenantDevices };
  }
  const signed = createOperatorToken(consumed.employeeId, serial, consumed.workflow, Date.now(), key, support);
  await prisma.auditEvent.create({ data: { homeId: consumed.homeId, actorUserId: consumed.employeeId, type: 'OS_OPERATOR_SESSION_LAUNCHED', metadata: { hubInstallId: hub.id, workflow: consumed.workflow, workflowId: consumed.workflowId, outcome: 'hub_consumed', expiresAt: signed.expiresAt.toISOString() } } });
  return NextResponse.json({ ok: true, token: signed.token, expiresAt: signed.expiresAt.toISOString(), serial, hubInstallId: hub.id, scope: support ? ['os:support'] : ['os:admin'] }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' } });
}
