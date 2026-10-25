import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { signStage1Token } from '@/lib/stage1Crypto';
import { validateCustomerHubSession } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError, cookieToken, requireCustomerAccountSession } from '@/lib/stage1Auth';
import { NativeAccessDenied, resolveNativeHomeContext } from '@/lib/nativeHomeContext';
import { verifiedCustomerLanEndpoint } from '@/lib/lanEndpoint';

export const dynamic = 'force-dynamic';

function verifiedHubEndpoint(hub: { cloudUrl: string | null; cloudUrlVerifiedAt: Date | null; remoteVerificationAt: Date | null; reservedHostname: string | null }, now: Date) {
  if (!hub.cloudUrl || !hub.cloudUrlVerifiedAt || !hub.remoteVerificationAt || !hub.reservedHostname || hub.cloudUrlVerifiedAt > now || hub.remoteVerificationAt > now) return { state: 'unavailable' as const };
  try {
    const url = new URL(hub.cloudUrl);
    const hostname = hub.reservedHostname.toLowerCase();
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== hostname || url.username || url.password || url.port || url.pathname !== '/' && url.pathname !== '' || url.search || url.hash || !/^dinodia-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.dinodiasmartliving\.com$/.test(hostname)) return { state: 'unavailable' as const };
    return { state: 'verified_cloud' as const, origin: url.origin };
  } catch {
    return { state: 'unavailable' as const };
  }
}

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get('authorization') ?? '';
    const mobileAccess = /^Bearer dno-customer-access-[A-Za-z0-9_-]{32,160}$/.test(authorization);
    const accountSession = mobileAccess ? await requireCustomerAccountSession(request) : null;
    if (accountSession && request.headers.has('x-dinodia-session')) throw new Stage1AuthError(400, 'customer_credential_ambiguous', 'Use one customer session credential per request');
    const rawSession = request.headers.get('x-dinodia-session') || cookieToken(request, 'dinodia_customer_session');
    if (!accountSession && !rawSession) throw new Stage1AuthError(401, 'customer_session_required', 'A customer session is required');
    let body: unknown;
    try { body = await request.json(); } catch { throw new Stage1AuthError(400, 'selected_home_request_invalid', 'A selected home is required'); }
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (!bodyRecord || Object.keys(bodyRecord).length !== 1 || !Object.hasOwn(bodyRecord, 'homeId') || typeof bodyRecord.homeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bodyRecord.homeId.trim())) {
      throw new Stage1AuthError(400, 'selected_home_request_invalid', 'A selected home is required');
    }
    const homeId = bodyRecord.homeId.trim();
    const sessionHash = rawSession ? crypto.createHash('sha256').update(rawSession).digest('hex') : null;
    const session = accountSession
      ? await prisma.customerSession.findFirst({ where: { id: accountSession.sessionId, customerAccountId: accountSession.id, refreshTokenHash: accountSession.refreshTokenHash }, select: { id: true, customerAccountId: true, trustedDeviceId: true, trustedDeviceSessionVersion: true, securityVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } })
      : await prisma.customerSession.findUnique({ where: { refreshTokenHash: sessionHash! }, select: { id: true, customerAccountId: true, trustedDeviceId: true, trustedDeviceSessionVersion: true, securityVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.absoluteExpiresAt <= new Date()) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is invalid');
    const account = await prisma.customerAccount.findUnique({ where: { id: session.customerAccountId }, select: { id: true, status: true, securityVersion: true, mustChangePassword: true } });
    const trusted = await prisma.trustedDevice.findUnique({ where: { id: session.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } });
    if (!account || account.status !== 'ACTIVE' || session.securityVersion !== account.securityVersion || !trusted || trusted.customerAccountId !== account.id || trusted.revokedAt || session.trustedDeviceSessionVersion !== trusted.sessionVersion) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active');
    if (account.mustChangePassword) throw new Stage1AuthError(403, 'customer_password_change_required', 'Change your password before selecting a property');
    let membership;
    try {
      membership = await resolveNativeHomeContext(prisma, { customerAccountId: session.customerAccountId, homeId });
    } catch (error) {
      const status = error instanceof NativeAccessDenied && error.code === 'HUB_UNAVAILABLE' ? 503 : error instanceof NativeAccessDenied && error.code === 'HOME_UNAVAILABLE' ? 409 : 403;
      const code = error instanceof NativeAccessDenied ? error.code.toLowerCase() : 'home_membership_forbidden';
      throw new Stage1AuthError(status, code, 'The selected home is not available to this account');
    }
    // Native OS bearer sessions are a tenant live-control capability, not a
    // read-only homeowner/manager shortcut. Those roles use the bounded
    // Platform projection and never receive a direct hub endpoint or token.
    if (membership.role !== 'TENANT') {
      throw new Stage1AuthError(403, 'hub_session_tenant_required', 'Direct Dinodia OS sessions are available only to an active tenant membership');
    }
    const now = Math.floor(Date.now() / 1000);
    const evaluatedAt = new Date(now * 1000);
    const cloudEndpoint = verifiedHubEndpoint({ cloudUrl: membership.cloudUrl, cloudUrlVerifiedAt: membership.cloudUrlVerifiedAt, remoteVerificationAt: membership.remoteVerificationAt, reservedHostname: membership.reservedHostname }, evaluatedAt);
    const lanEndpoint = verifiedCustomerLanEndpoint(membership, evaluatedAt);
    const hubEndpoint = { ...cloudEndpoint, ...(lanEndpoint ? { lan: lanEndpoint } : {}) };
    const privatePem = String(process.env.DINODIA_APP_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
    if (!privatePem) throw new Stage1AuthError(503, 'app_auth_unconfigured', 'App session authentication is not configured');
    const token = signStage1Token('customer', { id: account.id, sessionId: session.id, homeId: membership.homeId, membershipId: membership.membershipId, trustedDeviceId: trusted.id, hubInstallationId: membership.activeHubInstallationId, role: membership.role, areaIds: [...membership.grantedAreaIds], scopes: membership.role === 'TENANT' ? ['tenant:device-command'] : ['property:read'], policyRevision: Math.max(membership.accessRevision, membership.hubAccessPolicyRevision), issuedAt: now, expiresAt: now + 5 * 60 }, crypto.createPrivateKey(privatePem));
    const response = { ok: true, token, expiresAt: new Date((now + 5 * 60) * 1000).toISOString(), homeId: membership.homeId, membershipId: membership.membershipId, hubEndpoint };
    if (!validateCustomerHubSession(response, { homeId: membership.homeId, membershipId: membership.membershipId })) {
      throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The selected-home session response failed contract validation');
    }
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
