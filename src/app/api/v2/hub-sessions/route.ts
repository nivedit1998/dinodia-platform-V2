import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { signStage1Token } from '@/lib/stage1Crypto';
import { Stage1AuthError, authErrorResponse, cookieToken } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const rawSession = request.headers.get('x-dinodia-session') || cookieToken(request, 'dinodia_customer_session');
    if (!rawSession) throw new Stage1AuthError(401, 'customer_session_required', 'A customer session is required');
    let body: unknown;
    try { body = await request.json(); } catch { throw new Stage1AuthError(400, 'selected_home_request_invalid', 'A selected home is required'); }
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (!bodyRecord || Object.keys(bodyRecord).length !== 1 || !Object.hasOwn(bodyRecord, 'homeId') || typeof bodyRecord.homeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bodyRecord.homeId.trim())) {
      throw new Stage1AuthError(400, 'selected_home_request_invalid', 'A selected home is required');
    }
    const homeId = bodyRecord.homeId.trim();
    const sessionHash = crypto.createHash('sha256').update(rawSession).digest('hex');
    const session = await prisma.customerSession.findUnique({ where: { refreshTokenHash: sessionHash }, select: { id: true, customerAccountId: true, trustedDeviceId: true, trustedDeviceSessionVersion: true, securityVersion: true, revokedAt: true, expiresAt: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is invalid');
    const account = await prisma.customerAccount.findUnique({ where: { id: session.customerAccountId }, select: { id: true, status: true, securityVersion: true } });
    const trusted = await prisma.trustedDevice.findUnique({ where: { id: session.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } });
    if (!account || account.status !== 'ACTIVE' || session.securityVersion !== account.securityVersion || !trusted || trusted.customerAccountId !== account.id || trusted.revokedAt || session.trustedDeviceSessionVersion !== trusted.sessionVersion) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active');
    const membership = await prisma.homeMembership.findFirst({ where: { customerAccountId: session.customerAccountId, homeId, status: 'ACTIVE' }, select: { id: true, role: true, homeId: true, accessRevision: true } });
    if (!membership) throw new Stage1AuthError(403, 'home_membership_forbidden', 'The current account is not authorised for that home');
    const hub = await prisma.hubInstallation.findFirst({ where: { homeId, state: { in: ['PAIRING', 'ACTIVE', 'MAINTENANCE'] } }, select: { id: true, homeId: true, accessPolicyRevision: true } });
    if (!hub) throw new Stage1AuthError(503, 'home_hub_unavailable', 'The selected home hub is not available');
    const grants = membership.role === 'TENANT' ? await prisma.tenantAreaGrant.findMany({ where: { membershipId: membership.id, revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } }) : [];
    const now = Math.floor(Date.now() / 1000);
    const privatePem = String(process.env.DINODIA_APP_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
    if (!privatePem) throw new Stage1AuthError(503, 'app_auth_unconfigured', 'App session authentication is not configured');
    const token = signStage1Token('customer', { id: account.id, sessionId: session.id, homeId: hub.homeId, membershipId: membership.id, trustedDeviceId: trusted.id, hubInstallationId: hub.id, role: membership.role, areaIds: grants.map((grant) => grant.areaId), scopes: membership.role === 'TENANT' ? ['tenant:device-command'] : ['property:read'], policyRevision: Math.max(membership.accessRevision, hub.accessPolicyRevision), issuedAt: now, expiresAt: now + 5 * 60 }, crypto.createPrivateKey(privatePem));
    return NextResponse.json({ ok: true, token, expiresAt: new Date((now + 5 * 60) * 1000).toISOString(), homeId: hub.homeId, membershipId: membership.id }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
