import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sha256 } from '@/lib/stage1Crypto';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { buildMobileSessionReceipt, MOBILE_ACCESS_LIFETIME_MS, MOBILE_IDLE_LIFETIME_MS, newMobileAccessToken, newMobileRefreshToken } from '@/lib/mobileCustomerSession';
import { validateMobileCustomerSessionReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

function sessionCookie(raw: string, absoluteExpiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000));
  return `dinodia_customer_session=${encodeURIComponent(raw)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${maxAge}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'challengeId,token'
      || typeof body.challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.challengeId)
      || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(body.token)) {
      throw new Stage1AuthError(400, 'customer_email_challenge_invalid', 'The email verification link is invalid');
    }
    const tokenHash = sha256(body.token);
    await enforcePersistentRateLimit(`customer-email-verify:${tokenHash}`, 5, 15 * 60 * 1000);

    // A one-use email-change link confirms possession of the destination, but
    // it is not a login credential. Require the same already-authenticated
    // account and installation before it can change active account identity.
    const preview = await prisma.authChallenge.findUnique({ where: { tokenHash }, select: { id: true, purpose: true } });
    if (!preview || preview.id !== body.challengeId) throw new Stage1AuthError(400, 'customer_email_challenge_invalid', 'This verification link is invalid. Request a new link.');
    const principal = preview.purpose === 'CUSTOMER_EMAIL_CHANGE' ? await requireCustomerAccountSession(request) : null;
    if (preview.purpose !== 'CUSTOMER_EMAIL_CHANGE' && preview.purpose !== 'CUSTOMER_EMAIL_VERIFY') {
      throw new Stage1AuthError(400, 'customer_email_challenge_invalid', 'This verification link is invalid. Request a new link.');
    }

    const nextRefreshToken = preview.purpose === 'CUSTOMER_EMAIL_CHANGE' ? newMobileRefreshToken() : null;
    const nextAccessToken = principal?.credentialKind === 'access' ? newMobileAccessToken() : null;
    let now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "AuthChallenge" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
      const challenge = await tx.authChallenge.findUnique({ where: { tokenHash }, select: {
        id: true, customerAccountId: true, purpose: true, targetEmail: true,
        expiresAt: true, consumedAt: true, revokedAt: true,
      } });
      if (!challenge || challenge.id !== body.challengeId || challenge.purpose !== preview.purpose) return { kind: 'invalid' as const };
      if (challenge.consumedAt) return { kind: 'used' as const };

      if (challenge.purpose === 'CUSTOMER_EMAIL_VERIFY') {
        if (!challenge.customerAccountId || !challenge.targetEmail) return { kind: 'invalid' as const };
        await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${challenge.customerAccountId}::uuid FOR UPDATE`;
        now = new Date();
        if (challenge.revokedAt || challenge.expiresAt <= now) {
          await tx.authChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
          return { kind: 'expired' as const };
        }
        const account = await tx.customerAccount.findUnique({ where: { id: challenge.customerAccountId }, select: { id: true, emailNormalized: true, pendingEmailNormalized: true, emailVerifiedAt: true, status: true } });
        // Registration challenges can verify only the original address. They
        // cannot consume a later pending-address challenge or switch identity.
        if (!account || account.status !== 'ACTIVE' || account.emailVerifiedAt || account.pendingEmailNormalized
          || account.emailNormalized !== challenge.targetEmail.toLowerCase()) return { kind: 'invalid' as const };
        await tx.customerAccount.update({ where: { id: account.id }, data: { emailVerifiedAt: now } });
        await tx.authChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
        await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_email_verified', targetType: 'CustomerAccount', targetId: account.id, metadata: { outcome: 'verified' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        return { kind: 'verified' as const };
      }

      if (!principal || !challenge.customerAccountId || !challenge.targetEmail || !nextRefreshToken) return { kind: 'invalid' as const };
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${principal.trustedDeviceId}::uuid FOR UPDATE`;
      now = new Date();
      if (challenge.revokedAt || challenge.expiresAt <= now) {
        await tx.authChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
        return { kind: 'expired' as const };
      }
      const [account, session, device] = await Promise.all([
        tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, emailNormalized: true, pendingEmailNormalized: true, emailVerifiedAt: true, status: true, securityVersion: true } }),
        tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, sessionFamilyId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
      ]);
      const credentialCurrent = principal.credentialKind === 'access'
        ? Boolean(principal.accessTokenHash && principal.accessTokenExpiresAt && principal.accessTokenExpiresAt > now
          && session?.accessTokenHash === principal.accessTokenHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
        : session?.refreshTokenHash === principal.refreshTokenHash;
      if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.id !== challenge.customerAccountId
        || account.securityVersion !== principal.securityVersion || account.pendingEmailNormalized !== challenge.targetEmail.toLowerCase()
        || !session || session.customerAccountId !== account.id || session.trustedDeviceId !== principal.trustedDeviceId
        || !credentialCurrent || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== principal.trustedDeviceSessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !device || device.customerAccountId !== account.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion) {
        return { kind: 'session-invalid' as const };
      }

      // Prisma cannot deserialize PostgreSQL's `void` return type. Keep the
      // lock expression in the FROM subquery and expose a stable scalar column.
      await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${challenge.targetEmail.toLowerCase()}))) AS address_lock`;
      const conflict = await tx.customerAccount.findFirst({ where: { id: { not: account.id }, OR: [
        { emailNormalized: challenge.targetEmail.toLowerCase() }, { pendingEmailNormalized: challenge.targetEmail.toLowerCase() },
      ] }, select: { id: true } });
      if (conflict) return { kind: 'address-conflict' as const };

      const updatedAccount = await tx.customerAccount.update({ where: { id: account.id }, data: {
        email: challenge.targetEmail, emailNormalized: challenge.targetEmail.toLowerCase(), emailVerifiedAt: now,
        pendingEmail: null, pendingEmailNormalized: null, securityVersion: { increment: 1 },
      }, select: { id: true, securityVersion: true } });
      await tx.trustedDevice.updateMany({ where: { customerAccountId: account.id, id: { not: device.id }, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null, apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED' } });
      await tx.customerSession.updateMany({ where: { customerAccountId: account.id, id: { not: session.id }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'email_changed', accessTokenHash: null, accessTokenExpiresAt: null } });
      await tx.customerSession.update({ where: { id: session.id }, data: { revokedAt: now, revokeReason: 'refresh_token_rotated', accessTokenHash: null, accessTokenExpiresAt: null, lastUsedAt: now } });
      const expiresAt = new Date(Math.min(now.getTime() + MOBILE_IDLE_LIFETIME_MS, session.absoluteExpiresAt.getTime()));
      const accessTokenExpiresAt = nextAccessToken ? new Date(Math.min(now.getTime() + MOBILE_ACCESS_LIFETIME_MS, expiresAt.getTime())) : null;
      const nextSession = await tx.customerSession.create({ data: {
        customerAccountId: account.id, trustedDeviceId: device.id, sessionFamilyId: session.sessionFamilyId,
        refreshTokenHash: sha256(nextRefreshToken), accessTokenHash: nextAccessToken ? sha256(nextAccessToken) : null,
        accessTokenExpiresAt, securityVersion: updatedAccount.securityVersion,
        trustedDeviceSessionVersion: device.sessionVersion, issuedAt: now, lastUsedAt: now,
        expiresAt, absoluteExpiresAt: session.absoluteExpiresAt,
      }, select: { id: true, expiresAt: true, absoluteExpiresAt: true } });
      const allDevices = await tx.trustedDevice.findMany({ where: { customerAccountId: account.id }, select: { id: true } });
      const offline = await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: allDevices.map((item) => item.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'email_changed' } });
      await tx.stepUpChallenge.updateMany({ where: { customerAccountId: account.id, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.stepUpAuthorization.updateMany({ where: { customerAccountId: account.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.authChallenge.updateMany({ where: { customerAccountId: account.id, purpose: 'CUSTOMER_EMAIL_CHANGE', id: { not: challenge.id }, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.authChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_email_changed', targetType: 'CustomerAccount', targetId: account.id,
        metadata: { outcome: 'completed', completingInstallationPreserved: true, otherInstallationsRevoked: true, offlineHubEnforcement: offline.count ? 'PENDING' : 'NOT_REQUIRED' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { kind: 'changed' as const, session: nextSession, accountId: account.id, trustedDeviceId: device.id, offlinePending: offline.count > 0, accessTokenExpiresAt };
    }, { isolationLevel: 'Serializable' });

    if (result.kind === 'expired') throw new Stage1AuthError(410, 'customer_email_challenge_expired', 'This email-change link has expired. Request a new one.');
    if (result.kind === 'used') throw new Stage1AuthError(409, 'customer_email_challenge_used', 'This email-change link has already been used. Sign in again if needed.');
    if (result.kind === 'session-invalid') throw new Stage1AuthError(401, 'customer_session_invalid', 'Sign in again on the phone that requested this email change.');
    if (result.kind === 'address-conflict') throw new Stage1AuthError(409, 'email_change_unavailable', 'This email address can no longer be used. Your current email remains active.');
    if (result.kind === 'invalid') throw new Stage1AuthError(400, 'customer_email_challenge_invalid', 'This verification link is invalid. Request a new link.');
    if (result.kind === 'changed') {
      let response: NextResponse;
      if (principal!.credentialKind === 'access') {
        const receipt = { ...(await buildMobileSessionReceipt({ accountId: result.accountId, sessionId: result.session.id, trustedDeviceId: result.trustedDeviceId,
          accessToken: nextAccessToken!, refreshToken: nextRefreshToken!, accessTokenExpiresAt: result.accessTokenExpiresAt!, refreshTokenExpiresAt: result.session.expiresAt })),
          offlineHubEnforcement: result.offlinePending ? 'PENDING' : 'NOT_REQUIRED' };
        if (!validateMobileCustomerSessionReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The rotated mobile session response failed contract validation');
        response = NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
      } else {
        response = NextResponse.json({ ok: true, state: 'COMPLETED', offlineHubEnforcement: result.offlinePending ? 'PENDING' : 'NOT_REQUIRED' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
      }
      if (principal!.credentialKind === 'refresh') response.headers.append('Set-Cookie', sessionCookie(nextRefreshToken!, result.session.absoluteExpiresAt, now));
      return response;
    }
    return NextResponse.json({ ok: true, state: 'VERIFIED' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
