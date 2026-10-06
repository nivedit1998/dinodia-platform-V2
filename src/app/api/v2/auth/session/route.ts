import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { boundedContractText, validateAccountSessionContext, validateCustomerSessionLoginRequest, validateCustomerSessionLogoutReceipt, validateCustomerSessionReceipt } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { recordFailedAuthentication, Stage1AuthError, cookieToken } from '@/lib/stage1Auth';
import { verifyPassword } from '@/lib/passwords';
import { constantTimeEqual, randomSecret, sha256 } from '@/lib/stage1Crypto';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { consumeInvitedTenantCredentialForLogin } from '@/lib/customerInvitationRegistration';

export const dynamic = 'force-dynamic';

const SESSION_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 180 * 24 * 60 * 60 * 1000;

function sessionCookie(raw: string, absoluteExpiresAt: Date, now: Date): string {
  // The browser cookie may live through the absolute ceiling so successful
  // account activity can move the server-side 30-day idle deadline. The
  // server rejects an idle-expired token even while the cookie remains stored.
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000));
  return `dinodia_customer_session=${encodeURIComponent(raw)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${maxAge}`;
}

/**
 * Restore the account-global Native V1 context. This endpoint deliberately
 * returns memberships, not an implicitly selected home or a hub bearer. The
 * app must explicitly select (or revalidate its remembered selection) before
 * calling POST /api/v2/hub-sessions.
 */
export async function GET(request: Request) {
  try {
    const rawSession = cookieToken(request, 'dinodia_customer_session');
    if (!rawSession) throw new Stage1AuthError(401, 'customer_session_required', 'A customer session is required');
    const now = new Date();
    const tokenHash = sha256(rawSession);
    const refreshCandidate = await prisma.customerSession.findUnique({ where: { refreshTokenHash: tokenHash }, select: { sessionFamilyId: true } });
    if (!refreshCandidate) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is invalid');
    await enforcePersistentRateLimit(`customer-session-refresh:${refreshCandidate.sessionFamilyId}`, 120, 60 * 60 * 1000);
    const rotated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "refreshTokenHash" = ${tokenHash} FOR UPDATE`;
      const previous = await tx.customerSession.findUnique({ where: { refreshTokenHash: tokenHash }, select: {
        id: true, customerAccountId: true, trustedDeviceId: true, trustedDeviceSessionVersion: true,
        securityVersion: true, revokedAt: true, revokeReason: true, expiresAt: true, absoluteExpiresAt: true,
        sessionFamilyId: true,
      } });
      if (!previous) return { error: 'invalid' as const };
      if (previous.revokedAt) {
        if (previous.revokeReason === 'refresh_token_rotated') {
          await tx.customerSession.updateMany({
            where: { sessionFamilyId: previous.sessionFamilyId, revokedAt: null },
            data: { revokedAt: now, revokeReason: 'refresh_token_reuse', accessTokenHash: null, accessTokenExpiresAt: null },
          });
          return { error: 'reused' as const };
        }
        return { error: 'invalid' as const };
      }
      if (previous.expiresAt <= now || previous.absoluteExpiresAt <= now) return { error: 'expired' as const };
      const [account, trusted] = await Promise.all([
        tx.customerAccount.findUnique({ where: { id: previous.customerAccountId }, select: { id: true, status: true, securityVersion: true, mustChangePassword: true } }),
        tx.trustedDevice.findUnique({ where: { id: previous.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
      ]);
      if (!account || account.status !== 'ACTIVE' || account.securityVersion !== previous.securityVersion
        || !trusted || trusted.customerAccountId !== account.id || trusted.revokedAt
        || trusted.sessionVersion !== previous.trustedDeviceSessionVersion) return { error: 'invalid' as const };
      const expiresAt = new Date(Math.min(now.getTime() + SESSION_INACTIVITY_MS, previous.absoluteExpiresAt.getTime()));
      const nextRaw = `dno-customer-session-${randomSecret(32)}`;
      await tx.customerSession.update({ where: { id: previous.id }, data: { revokedAt: now, revokeReason: 'refresh_token_rotated', lastUsedAt: now, accessTokenHash: null, accessTokenExpiresAt: null } });
      const next = await tx.customerSession.create({ data: {
        customerAccountId: previous.customerAccountId,
        trustedDeviceId: previous.trustedDeviceId,
        sessionFamilyId: previous.sessionFamilyId,
        refreshTokenHash: sha256(nextRaw),
        securityVersion: previous.securityVersion,
        trustedDeviceSessionVersion: previous.trustedDeviceSessionVersion,
        issuedAt: now,
        expiresAt,
        absoluteExpiresAt: previous.absoluteExpiresAt,
        lastUsedAt: now,
      }, select: { id: true, expiresAt: true, absoluteExpiresAt: true } });
      await tx.trustedDevice.update({ where: { id: trusted.id }, data: { lastUsedAt: now } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_session_refreshed', targetType: 'CustomerSession', targetId: next.id, metadata: { outcome: 'rotated', previousSessionId: previous.id }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { session: next, raw: nextRaw, accountId: account.id, trustedDeviceId: trusted.id, requiresPasswordChange: account.mustChangePassword };
    }, { isolationLevel: 'Serializable' });
    if ('error' in rotated) {
      if (rotated.error === 'expired') throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session has expired');
      if (rotated.error === 'reused') throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active');
      throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is invalid');
    }
    const session = { id: rotated.session.id, customerAccountId: rotated.accountId, trustedDeviceId: rotated.trustedDeviceId, expiresAt: rotated.session.expiresAt, absoluteExpiresAt: rotated.session.absoluteExpiresAt };
    const memberships = rotated.requiresPasswordChange ? [] : await prisma.homeMembership.findMany({
      where: { customerAccountId: session.customerAccountId, status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        homeId: true,
        role: true,
        accessRevision: true,
        tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true, homeId: true } },
      },
    });
    const accountContext = {
      schemaVersion: 'dinodia.v1',
      accountId: session.customerAccountId,
      // These opaque identifiers let the app bind per-action step-up proofs
      // after cookie-backed session restoration. Neither value authenticates
      // a request; the HttpOnly session cookie remains the authority.
      sessionId: session.id,
      trustedDeviceId: session.trustedDeviceId,
      memberships: memberships.map((membership) => ({
        accountId: session.customerAccountId,
        homeId: membership.homeId,
        homeMembershipId: membership.id,
        role: membership.role,
        status: 'active',
        areaIds: membership.role === 'TENANT' ? membership.tenantAreaGrants.filter((grant) => grant.homeId === membership.homeId).map((grant) => grant.areaId) : [],
        revision: membership.accessRevision,
      })),
      expiresAt: session.expiresAt.toISOString(),
    };
    if (!validateAccountSessionContext(accountContext)) {
      throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The account session response failed contract validation');
    }
    const response = NextResponse.json(accountContext, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    response.headers.append('Set-Cookie', sessionCookie(rotated.raw, session.absoluteExpiresAt, now));
    return response;
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as unknown;
    if (!validateCustomerSessionLoginRequest(body)) {
      const attemptedEmail = body && typeof body === 'object' && !Array.isArray(body)
        ? boundedContractText((body as Record<string, unknown>).email, 320).toLowerCase()
        : '';
      await recordFailedAuthentication('customer_login_failed', attemptedEmail || 'missing-email');
      throw new Stage1AuthError(400, 'customer_login_fields_invalid', 'Email, password and trusted-device details are required');
    }
    const input = body;
    const email = input.email.trim().toLowerCase();
    const password = input.password;
    const deviceInstallationId = input.deviceInstallationId.trim();
    const publicKey = input.publicKey;
    const deviceName = input.deviceName.trim();
    await enforcePersistentRateLimit(`customer-login:${sha256(email)}`, 8, 15 * 60 * 1000);
    try { crypto.createPublicKey(publicKey); } catch { throw new Stage1AuthError(400, 'trusted_device_key_invalid', 'The trusted-device public key is invalid'); }
    let account = await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true, status: true, emailVerifiedAt: true, passwordHash: true, securityVersion: true } });
    if (!account) {
      // A new tenant's email-delivered one-time credential proves possession
      // of the invited address. It creates only a gated account, never a Home
      // membership; password replacement, username choice and invitation
      // acceptance remain separate server-enforced steps.
      const invitedAccountId = await consumeInvitedTenantCredentialForLogin({ email, password });
      if (invitedAccountId) account = await prisma.customerAccount.findUnique({ where: { id: invitedAccountId }, select: { id: true, status: true, emailVerifiedAt: true, passwordHash: true, securityVersion: true } });
    }
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || !(await verifyPassword(password, account.passwordHash))) {
      await recordFailedAuthentication('customer_login_failed', email);
      throw new Stage1AuthError(401, 'customer_credentials_invalid', 'The customer credentials are invalid');
    }
    const thumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
    const rawSession = `dno-customer-session-${randomSecret(32)}`;
    const session = await prisma.$transaction(async (tx) => {
      const existing = await tx.trustedDevice.findUnique({ where: { customerAccountId_deviceInstallationId: { customerAccountId: account.id, deviceInstallationId } }, select: { id: true, sessionVersion: true, revokedAt: true, publicKeyThumbprint: true } });
      if (existing?.revokedAt) throw new Stage1AuthError(403, 'trusted_device_revoked', 'This trusted device was removed; use the approved re-enrolment process');
      if (existing && !constantTimeEqual(existing.publicKeyThumbprint, thumbprint)) throw new Stage1AuthError(409, 'trusted_device_identity_changed', 'This installation ID is already bound to another signing key');
      const trusted = existing
        ? await tx.trustedDevice.update({
          where: { id: existing.id },
          // Ordinary sign-in refreshes this device's use time only. It does not
          // rotate its revocation generation or silently invalidate its other
          // account sessions. Re-enrolment/key changes have a separate flow.
          data: { deviceName, model: boundedContractText(input.model, 160) || null, osFamily: boundedContractText(input.osFamily, 80) || null, osVersion: boundedContractText(input.osVersion, 80) || null, lastUsedAt: new Date() },
          select: { id: true, sessionVersion: true, revokedAt: true, publicKeyThumbprint: true },
        })
        : await tx.trustedDevice.create({
          data: { customerAccountId: account.id, deviceInstallationId, publicKey, publicKeyThumbprint: thumbprint, deviceName, model: boundedContractText(input.model, 160) || null, osFamily: boundedContractText(input.osFamily, 80) || null, osVersion: boundedContractText(input.osVersion, 80) || null },
          select: { id: true, sessionVersion: true, revokedAt: true, publicKeyThumbprint: true },
        });
      if (trusted.revokedAt) throw new Stage1AuthError(403, 'trusted_device_revoked', 'This trusted device was removed; use the approved re-enrolment process');
      if (!constantTimeEqual(trusted.publicKeyThumbprint, thumbprint)) throw new Stage1AuthError(409, 'trusted_device_identity_changed', 'This installation ID is already bound to another signing key');
      const issuedAt = new Date();
      const absoluteExpiresAt = new Date(issuedAt.getTime() + SESSION_ABSOLUTE_MS);
      const expiresAt = new Date(Math.min(issuedAt.getTime() + SESSION_INACTIVITY_MS, absoluteExpiresAt.getTime()));
      const created = await tx.customerSession.create({ data: { customerAccountId: account.id, trustedDeviceId: trusted.id, sessionFamilyId: crypto.randomUUID(), refreshTokenHash: sha256(rawSession), securityVersion: account.securityVersion, trustedDeviceSessionVersion: trusted.sessionVersion, issuedAt, expiresAt, absoluteExpiresAt }, select: { id: true, expiresAt: true, absoluteExpiresAt: true } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_login_succeeded', targetType: 'CustomerSession', targetId: created.id, metadata: { trustedDeviceId: trusted.id, outcome: 'succeeded' }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
      return { ...created, trustedDeviceId: trusted.id };
    });
    const receipt = { ok: true, accountId: account.id, sessionId: session.id, trustedDeviceId: session.trustedDeviceId, expiresAt: session.expiresAt.toISOString() };
    if (!validateCustomerSessionReceipt(receipt)) {
      throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The customer session receipt failed contract validation');
    }
    const response = NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    response.headers.append('Set-Cookie', sessionCookie(rawSession, session.absoluteExpiresAt, new Date()));
    return response;
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const rawSession = request.headers.get('x-dinodia-session') || cookieToken(request, 'dinodia_customer_session');
    if (!rawSession) throw new Stage1AuthError(401, 'customer_session_required', 'A customer session is required');
    await prisma.$transaction(async (tx) => {
      const session = await tx.customerSession.findUnique({ where: { refreshTokenHash: sha256(rawSession) }, select: { id: true, trustedDeviceId: true } });
      if (!session) return;
      const now = new Date();
      await tx.customerSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'customer_logout', accessTokenHash: null, accessTokenExpiresAt: null } });
      await tx.trustedDevice.updateMany({ where: { id: session.trustedDeviceId, apnsTokenDigest: { not: null } }, data: {
        apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null,
        apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED',
      } });
    });
    const receipt = { ok: true as const };
    if (!validateCustomerSessionLogoutReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The customer logout receipt failed contract validation');
    const response = NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store' } });
    response.headers.append('Set-Cookie', 'dinodia_customer_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0');
    return response;
  } catch (error) { return nativeV1ErrorResponse(error); }
}
