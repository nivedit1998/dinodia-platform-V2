import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { boundedContractText, validateAccountSessionContext, validateCustomerSessionLoginRequest, validateCustomerSessionLogoutReceipt } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { recordFailedAuthentication, Stage1AuthError, cookieToken } from '@/lib/stage1Auth';
import { verifyPassword } from '@/lib/passwords';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { consumeInvitedTenantCredentialForLogin } from '@/lib/customerInvitationRegistration';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { deviceThumbprint, finishCustomerSignIn, SESSION_INACTIVITY_MS, sessionCookie } from '@/lib/customerSignIn';
import { accountMfaRequirement, deviceBinding, issueMfaChallenge, mfaEnforced, MFA_PURPOSE } from '@/lib/accountMfa';

export const dynamic = 'force-dynamic';

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
    const tokenHash = sha256(rawSession);
    const refreshCandidate = await prisma.customerSession.findUnique({ where: { refreshTokenHash: tokenHash }, select: {
      id: true, customerAccountId: true, trustedDeviceId: true, sessionFamilyId: true,
    } });
    if (!refreshCandidate) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is invalid');
    await enforcePersistentRateLimit(`customer-session-refresh:${refreshCandidate.sessionFamilyId}`, 120, 60 * 60 * 1000);
    const rotated = await serializableTransaction(async (tx) => {
      // Match the account -> session -> trusted-device lock order used by
      // password changes and trusted-device removal. The initial lookup only
      // selects stable foreign-key IDs; every authority decision is repeated
      // from the locked rows below.
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${refreshCandidate.customerAccountId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${refreshCandidate.id}::uuid AND "customerAccountId" = ${refreshCandidate.customerAccountId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${refreshCandidate.trustedDeviceId}::uuid FOR UPDATE`;
      const now = new Date();
      const previous = await tx.customerSession.findUnique({ where: { id: refreshCandidate.id }, select: {
        id: true, customerAccountId: true, trustedDeviceId: true, trustedDeviceSessionVersion: true,
        securityVersion: true, revokedAt: true, revokeReason: true, expiresAt: true, absoluteExpiresAt: true,
        sessionFamilyId: true, refreshTokenHash: true,
      } });
      if (!previous || previous.refreshTokenHash !== tokenHash
        || previous.customerAccountId !== refreshCandidate.customerAccountId
        || previous.trustedDeviceId !== refreshCandidate.trustedDeviceId) return { error: 'invalid' as const };
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
      return { session: next, raw: nextRaw, refreshedAt: now, accountId: account.id, trustedDeviceId: trusted.id, requiresPasswordChange: account.mustChangePassword };
    }, 2);
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
    response.headers.append('Set-Cookie', sessionCookie(rotated.raw, session.absoluteExpiresAt, rotated.refreshedAt));
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
    // Signing in with the emailed one-time credential already proves the mailbox, so no second emailed code is asked for (the same
    // factor would add nothing).
    let mailboxProvenByCredential = false;
    if (!account) {
      // A new tenant's email-delivered one-time credential proves possession
      // of the invited address. It creates only a gated account, never a Home
      // membership; password replacement, username choice and invitation
      // acceptance remain separate server-enforced steps.
      const invitedAccountId = await consumeInvitedTenantCredentialForLogin({ email, password });
      if (invitedAccountId) mailboxProvenByCredential = true;
      if (invitedAccountId) account = await prisma.customerAccount.findUnique({ where: { id: invitedAccountId }, select: { id: true, status: true, emailVerifiedAt: true, passwordHash: true, securityVersion: true } });
    }
    if (!account || account.status !== 'ACTIVE' || !(await verifyPassword(password, account.passwordHash))) {
      await recordFailedAuthentication('customer_login_failed', email);
      throw new Stage1AuthError(401, 'customer_credentials_invalid', 'The customer credentials are invalid');
    }
    // Only someone who knows the password is told the email is unverified, so this reveals nothing to a stranger
    // and a new person is not left thinking they typed it wrong.
    if (!account.emailVerifiedAt) {
      throw new Stage1AuthError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email address before signing in');
    }
    // Two-step verification: required for homeowners and property managers, optional for tenants who turned it on. The password is
    // right at this point, so telling this person a code is needed reveals nothing to a stranger.
    if (mfaEnforced() && !mailboxProvenByCredential) {
      const mfa = await accountMfaRequirement(prisma, account.id);
      if (mfa.requirement !== 'NONE') {
        if (request.headers.get('x-dinodia-mfa') !== '1') {
          throw new Stage1AuthError(403, 'MFA_APP_UPDATE_REQUIRED', 'Please update the Dinodia app to sign in. Your account uses two-step verification.');
        }
        const issued = await issueMfaChallenge({ accountId: account.id, email, purpose: MFA_PURPOSE.SIGN_IN, bindingHash: deviceBinding(deviceInstallationId, deviceThumbprint(publicKey)) });
        return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, mfaRequired: true, challengeId: issued.challengeId, clientSecret: issued.clientSecret,
          maskedEmail: issued.maskedEmail, expiresAt: issued.expiresAt.toISOString(), resendAvailableAt: issued.resendAvailableAt.toISOString(), codeLength: 6 },
        { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
      }
    }
    return await finishCustomerSignIn(account, { deviceInstallationId, publicKey, deviceName, model: input.model, osFamily: input.osFamily, osVersion: input.osVersion });
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
