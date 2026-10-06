import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword, verifyPassword } from '@/lib/passwords';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

function sessionCookie(raw: string, absoluteExpiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000));
  return `dinodia_customer_session=${encodeURIComponent(raw)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${maxAge}`;
}

export async function POST(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request, { allowPasswordChangeOnly: true, allowMandatoryPasswordChange: true });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const mandatoryReplacement = principal.mustChangePassword;
    const expectedKeys = mandatoryReplacement ? 'currentPassword,newPassword' : 'currentPassword,newPassword,proof';
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== expectedKeys
      || typeof body.currentPassword !== 'string' || body.currentPassword.length > 1024
      || typeof body.newPassword !== 'string' || body.newPassword.length < 12 || Array.from(body.newPassword).length > 1024
      || (!mandatoryReplacement && (typeof body.proof !== 'string' || body.proof.length < 40 || body.proof.length > 8192))) {
      throw new Stage1AuthError(400, 'customer_password_change_invalid', 'Enter your current password and a new password of at least 12 characters');
    }
    await enforcePersistentRateLimit(`customer-password-change:${principal.id}`, 8, 60 * 60 * 1000);
    const account = await prisma.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, passwordHash: true, securityVersion: true, status: true } });
    if (!account || account.status !== 'ACTIVE' || account.securityVersion !== principal.securityVersion
      || !(await verifyPassword(body.currentPassword, account.passwordHash))) {
      throw new Stage1AuthError(401, 'customer_password_change_invalid', 'The current password could not be verified');
    }
    const nextPasswordHash = hashPassword(body.newPassword);
    let now = new Date();
    const nextRaw = `dno-customer-session-${randomSecret(32)}`;
    const targetIds = [principal.id];
    const proofValue = { newPasswordDigest: sha256(body.newPassword) };
    const proofDigest = operationDigest({ customerAccountId: principal.id, customerSessionId: principal.sessionId, trustedDeviceId: principal.trustedDeviceId, operationKind: 'customer_password_change', targetIds, value: proofValue });
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
      const [currentAccount, currentSession, currentDevice] = await Promise.all([
        tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, status: true, securityVersion: true, passwordHash: true } }),
        tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, sessionFamilyId: true, securityVersion: true, trustedDeviceSessionVersion: true, refreshTokenHash: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
      ]);
      now = new Date();
      if (!currentAccount || currentAccount.status !== 'ACTIVE' || currentAccount.securityVersion !== principal.securityVersion
        || !currentSession || currentSession.customerAccountId !== principal.id || currentSession.trustedDeviceId !== principal.trustedDeviceId
        || currentSession.refreshTokenHash !== principal.refreshTokenHash || currentSession.revokedAt || currentSession.expiresAt <= now || currentSession.absoluteExpiresAt <= now
        || !currentDevice || currentDevice.customerAccountId !== principal.id || currentDevice.revokedAt
        || currentDevice.sessionVersion !== principal.trustedDeviceSessionVersion
        || !(await verifyPassword(body.currentPassword as string, currentAccount.passwordHash))) return null;

      if (!mandatoryReplacement) {
        const proofUse = await tx.stepUpAuthorization.updateMany({ where: {
          nonceHash: sha256(body.proof as string), customerAccountId: principal.id, customerSessionId: principal.sessionId,
          trustedDeviceId: principal.trustedDeviceId, homeId: null, membershipId: null,
          operationKind: 'customer_password_change', targetDigest: targetDigest(targetIds), normalizedValueDigest: proofDigest,
          policyRevision: principal.securityVersion, consumedAt: null, revokedAt: null, expiresAt: { gt: now },
        }, data: { consumedAt: now } });
        if (proofUse.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'A fresh confirmation for this exact password change is required');
      }

      const updatedAccount = await tx.customerAccount.update({ where: { id: principal.id }, data: { passwordHash: nextPasswordHash, mustChangePassword: false, passwordChangedAt: now, securityVersion: { increment: 1 } }, select: { securityVersion: true } });
      await tx.trustedDevice.updateMany({ where: { customerAccountId: principal.id, id: { not: principal.trustedDeviceId }, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null, apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED' } });
      await tx.customerSession.updateMany({ where: { customerAccountId: principal.id, id: { not: principal.sessionId }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'password_changed', accessTokenHash: null, accessTokenExpiresAt: null } });
      await tx.customerSession.update({ where: { id: principal.sessionId }, data: { revokedAt: now, revokeReason: 'refresh_token_rotated', lastUsedAt: now, accessTokenHash: null, accessTokenExpiresAt: null } });
      const device = await tx.trustedDevice.findUniqueOrThrow({ where: { id: principal.trustedDeviceId }, select: { id: true, sessionVersion: true } });
      const absoluteExpiresAt = currentSession.absoluteExpiresAt;
      const expiresAt = new Date(Math.min(now.getTime() + 30 * 24 * 60 * 60 * 1000, absoluteExpiresAt.getTime()));
      const next = await tx.customerSession.create({ data: {
        customerAccountId: principal.id, trustedDeviceId: device.id, sessionFamilyId: currentSession.sessionFamilyId,
        refreshTokenHash: sha256(nextRaw), securityVersion: updatedAccount.securityVersion,
        trustedDeviceSessionVersion: device.sessionVersion, issuedAt: now, lastUsedAt: now, expiresAt, absoluteExpiresAt,
      }, select: { id: true, expiresAt: true, absoluteExpiresAt: true } });
      const accountDevices = await tx.trustedDevice.findMany({ where: { customerAccountId: principal.id }, select: { id: true } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: accountDevices.map((item) => item.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'password_changed' } });
      await tx.stepUpChallenge.updateMany({ where: { customerAccountId: principal.id, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.stepUpAuthorization.updateMany({ where: { customerAccountId: principal.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: principal.id, category: 'SECURITY', action: 'customer_password_changed', targetType: 'CustomerAccount', targetId: principal.id, metadata: { outcome: 'completed', completingSessionPreserved: true, otherInstallationsRevoked: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { id: next.id, expiresAt: next.expiresAt, absoluteExpiresAt: next.absoluteExpiresAt };
    }, { isolationLevel: 'Serializable' });
    if (!result) throw new Stage1AuthError(409, 'customer_session_invalid', 'This session changed while the password was being updated. Sign in again.');
    const response = NextResponse.json({ ok: true, nextAction: 'CONTINUE', sessionId: result.id, expiresAt: result.expiresAt.toISOString(), offlineHubEnforcement: 'PENDING' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    response.headers.append('Set-Cookie', sessionCookie(nextRaw, result.absoluteExpiresAt, now));
    return response;
  } catch (error) { return nativeV1ErrorResponse(error); }
}
