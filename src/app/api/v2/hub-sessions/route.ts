import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { signStage1Token } from '@/lib/stage1Crypto';
import { Stage1AuthError, authErrorResponse, cookieToken } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const rawSession = request.headers.get('x-dinodia-session') || cookieToken(request, 'dinodia_customer_session');
    const homeId = String((await request.clone().json().catch(() => ({})) as Record<string, unknown>).homeId ?? '').trim();
    const sessionHash = crypto.createHash('sha256').update(rawSession).digest('hex');
    if (!rawSession || !homeId) throw new Stage1AuthError(401, 'customer_session_required', 'A customer session and selected home are required');
    const session = await prisma.customerSession.findUnique({ where: { refreshTokenHash: sessionHash }, select: { id: true, customerAccountId: true, trustedDeviceId: true, securityVersion: true, revokedAt: true, expiresAt: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is invalid');
    const account = await prisma.customerAccount.findUnique({ where: { id: session.customerAccountId }, select: { id: true, status: true, securityVersion: true } });
    const trusted = await prisma.trustedDevice.findUnique({ where: { id: session.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true } });
    const membership = await prisma.homeMembership.findFirst({ where: { customerAccountId: session.customerAccountId, homeId, status: 'ACTIVE' }, select: { id: true, role: true, homeId: true, accessRevision: true } });
    const hub = await prisma.hubInstallation.findFirst({ where: { homeId, state: { in: ['PAIRING', 'ACTIVE', 'MAINTENANCE'] } }, select: { id: true, homeId: true, accessPolicyRevision: true } });
    if (!account || account.status !== 'ACTIVE' || session.securityVersion !== account.securityVersion || !trusted || trusted.customerAccountId !== account.id || trusted.revokedAt || !membership || !hub) throw new Stage1AuthError(401, 'customer_session_invalid', 'The selected home session is invalid');
    const grants = membership.role === 'TENANT' ? await prisma.tenantAreaGrant.findMany({ where: { membershipId: membership.id, revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } }) : [];
    const now = Math.floor(Date.now() / 1000);
    const privatePem = String(process.env.DINODIA_APP_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
    if (!privatePem) throw new Stage1AuthError(503, 'app_auth_unconfigured', 'App session authentication is not configured');
    const token = signStage1Token('customer', { id: account.id, sessionId: session.id, homeId: hub.homeId, membershipId: membership.id, trustedDeviceId: trusted.id, hubInstallationId: hub.id, role: membership.role, areaIds: grants.map((grant) => grant.areaId), scopes: membership.role === 'TENANT' ? ['tenant:device-command'] : ['property:read'], policyRevision: Math.max(membership.accessRevision, hub.accessPolicyRevision), issuedAt: now, expiresAt: now + 5 * 60 }, crypto.createPrivateKey(privatePem));
    return NextResponse.json({ ok: true, token, expiresAt: new Date((now + 5 * 60) * 1000).toISOString(), homeId: hub.homeId, membershipId: membership.id }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
