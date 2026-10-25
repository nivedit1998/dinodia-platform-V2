import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/passwords';
import { sha256 } from '@/lib/stage1Crypto';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { randomSecret } from '@/lib/stage1Crypto';
import crypto from 'node:crypto';
import { validateCustomerSessionReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 180 * 24 * 60 * 60 * 1000;

function sessionCookie(raw: string, absoluteExpiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000));
  return `dinodia_customer_session=${encodeURIComponent(raw)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${maxAge}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const baseKeys = ['challengeId', 'password', 'token'];
    const deviceKeys = ['deviceInstallationId', 'deviceName', 'model', 'osFamily', 'osVersion', 'publicKey'];
    const keys = body && !Array.isArray(body) ? Object.keys(body).sort() : [];
    const withDevice = deviceKeys.every((key) => keys.includes(key)) && keys.length === baseKeys.length + deviceKeys.length
      && [...baseKeys, ...deviceKeys].sort().every((key, index) => keys[index] === key);
    const webCompletion = keys.join(',') === baseKeys.join(',');
    if (!body || Array.isArray(body) || (!withDevice && !webCompletion)
      || typeof body.challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.challengeId)
      || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(body.token)
      || typeof body.password !== 'string' || body.password.length < 12 || Array.from(body.password).length > 1024) {
      throw new Stage1AuthError(400, 'customer_password_reset_invalid', 'The link or password is invalid. Use a password of at least 12 characters.');
    }
    let currentDevice: { installationId: string; publicKey: string; thumbprint: string; deviceName: string; model: string | null; osFamily: string | null; osVersion: string | null } | null = null;
    if (withDevice) {
      if (typeof body.deviceInstallationId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(body.deviceInstallationId)
        || typeof body.publicKey !== 'string' || body.publicKey.length > 4096
        || typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.length > 160
        || typeof body.model !== 'string' || body.model.length > 160
        || typeof body.osFamily !== 'string' || body.osFamily.length > 80
        || typeof body.osVersion !== 'string' || body.osVersion.length > 80) {
        throw new Stage1AuthError(400, 'customer_password_reset_invalid', 'The link or password is invalid.');
      }
      let publicKey: crypto.KeyObject;
      try { publicKey = crypto.createPublicKey(body.publicKey); }
      catch { throw new Stage1AuthError(400, 'customer_password_reset_invalid', 'The link or password is invalid.'); }
      currentDevice = {
        installationId: body.deviceInstallationId,
        publicKey: body.publicKey,
        thumbprint: crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
        deviceName: body.deviceName.trim(),
        model: body.model.trim() || null,
        osFamily: body.osFamily.trim() || null,
        osVersion: body.osVersion.trim() || null,
      };
    }
    const tokenHash = sha256(body.token);
    await enforcePersistentRateLimit(`customer-password-reset-complete:${tokenHash}`, 5, 15 * 60 * 1000);
    const passwordHash = hashPassword(body.password);
    let now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "AuthChallenge" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
      const challenge = await tx.authChallenge.findUnique({ where: { tokenHash }, select: { id: true, customerAccountId: true, purpose: true, targetEmail: true, expiresAt: true, consumedAt: true, revokedAt: true } });
      if (!challenge || challenge.id !== body.challengeId || challenge.purpose !== 'CUSTOMER_PASSWORD_RESET' || !challenge.customerAccountId) return 'invalid' as const;
      if (challenge.consumedAt) return 'used' as const;
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${challenge.customerAccountId}::uuid FOR UPDATE`;
      // Time captured before row-lock waits is not authorization. Re-evaluate
      // the one-use challenge after all serialization locks are acquired.
      now = new Date();
      if (challenge.revokedAt || challenge.expiresAt <= now) {
        await tx.authChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
        return 'expired' as const;
      }
      const account = await tx.customerAccount.findUnique({ where: { id: challenge.customerAccountId }, select: { id: true, emailNormalized: true, status: true, emailVerifiedAt: true, securityVersion: true } });
      if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.emailNormalized !== challenge.targetEmail?.toLowerCase()) return 'invalid' as const;
      let completingDevice: { id: string; sessionVersion: number } | null = null;
      if (currentDevice) {
        const existing = await tx.trustedDevice.findUnique({ where: { customerAccountId_deviceInstallationId: { customerAccountId: account.id, deviceInstallationId: currentDevice.installationId } }, select: { id: true, publicKeyThumbprint: true, revokedAt: true, sessionVersion: true } });
        if (existing?.revokedAt || (existing && existing.publicKeyThumbprint !== currentDevice.thumbprint)) return 'device-invalid' as const;
        completingDevice = existing
          ? { id: existing.id, sessionVersion: existing.sessionVersion }
          : await tx.trustedDevice.create({ data: {
            customerAccountId: account.id,
            deviceInstallationId: currentDevice.installationId,
            publicKey: currentDevice.publicKey,
            publicKeyThumbprint: currentDevice.thumbprint,
            deviceName: currentDevice.deviceName,
            model: currentDevice.model,
            osFamily: currentDevice.osFamily,
            osVersion: currentDevice.osVersion,
            lastUsedAt: now,
          }, select: { id: true, sessionVersion: true } });
        await tx.trustedDevice.updateMany({ where: { customerAccountId: account.id, id: { not: completingDevice.id }, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null, apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED' } });
      }
      const updatedAccount = await tx.customerAccount.update({ where: { id: account.id }, data: { passwordHash, mustChangePassword: false, passwordChangedAt: now, securityVersion: { increment: 1 } }, select: { securityVersion: true } });
      if (!currentDevice) {
        await tx.trustedDevice.updateMany({ where: { customerAccountId: account.id, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null, apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED' } });
      }
      await tx.customerSession.updateMany({ where: { customerAccountId: account.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'password_reset', accessTokenHash: null, accessTokenExpiresAt: null } });
      let session: { id: string; expiresAt: Date; absoluteExpiresAt: Date; raw: string; accountId: string; trustedDeviceId: string } | null = null;
      if (completingDevice) {
        const raw = `dno-customer-session-${randomSecret(32)}`;
        const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
        const created = await tx.customerSession.create({ data: {
          customerAccountId: account.id,
          trustedDeviceId: completingDevice.id,
          sessionFamilyId: crypto.randomUUID(),
          refreshTokenHash: sha256(raw),
          securityVersion: updatedAccount.securityVersion,
          trustedDeviceSessionVersion: completingDevice.sessionVersion,
          issuedAt: now,
          lastUsedAt: now,
          expiresAt: new Date(Math.min(now.getTime() + SESSION_IDLE_MS, absoluteExpiresAt.getTime())),
          absoluteExpiresAt,
        }, select: { id: true, expiresAt: true, absoluteExpiresAt: true } });
        session = { ...created, raw, accountId: account.id, trustedDeviceId: completingDevice.id };
      }
      const trusted = await tx.trustedDevice.findMany({ where: { customerAccountId: account.id }, select: { id: true } });
      const offlineRevocations = await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: trusted.map((item) => item.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'password_reset' } });
      await tx.stepUpChallenge.updateMany({ where: { customerAccountId: account.id, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.stepUpAuthorization.updateMany({ where: { customerAccountId: account.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.authChallenge.updateMany({ where: { customerAccountId: account.id, id: { not: challenge.id }, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.authChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_password_reset', targetType: 'CustomerAccount', targetId: account.id, metadata: { outcome: 'completed', completingInstallationPreserved: Boolean(session), otherInstallationsRevoked: Boolean(currentDevice), offlineAuthorisationsRevoked: offlineRevocations.count }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { state: 'completed' as const, offlineRevocations: offlineRevocations.count, session };
    }, { isolationLevel: 'Serializable' });
    if (result === 'device-invalid') throw new Stage1AuthError(409, 'customer_trusted_device_identity_invalid', 'This installation identity cannot be used. Sign in again on an enrolled phone.');
    if (result === 'expired') throw new Stage1AuthError(410, 'customer_password_reset_expired', 'This password-reset link has expired. Request a new one.');
    if (result === 'used') throw new Stage1AuthError(409, 'customer_password_reset_used', 'This password-reset link has already been used. Request a new one.');
    if (result === 'invalid') throw new Stage1AuthError(400, 'customer_password_reset_invalid', 'This password-reset link is invalid. Request a new one.');
    if (result.session) {
      const receipt = { ok: true, accountId: result.session.accountId, sessionId: result.session.id, trustedDeviceId: result.session.trustedDeviceId, expiresAt: result.session.expiresAt.toISOString() };
      if (!validateCustomerSessionReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The password reset session receipt failed contract validation');
      const response = NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
      response.headers.append('Set-Cookie', sessionCookie(result.session.raw, result.session.absoluteExpiresAt, now));
      return response;
    }
    return NextResponse.json({ ok: true, state: 'COMPLETED', nextAction: 'SIGN_IN', otherSessionsRevoked: true, offlineHubEnforcement: result.offlineRevocations > 0 ? 'PENDING' : 'NOT_REQUIRED' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
