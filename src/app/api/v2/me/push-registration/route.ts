import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { encryptPlatformEnvelope } from '@/lib/hubOperatorCredentials';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateApnsRegistrationReceipt, validateApnsRegistrationRequest } from '@/lib/contracts/dinodiaV1';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

function tokenDigest(token: string): string {
  const configured = String(process.env.PLATFORM_DATA_ENCRYPTION_KEY ?? '');
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new Stage1AuthError(503, 'PUSH_REGISTRATION_UNAVAILABLE', 'Secure notification registration is unavailable');
  return crypto.createHmac('sha256', key).update('dinodia-v2-apns-token-v1\0').update(token).digest('hex');
}

export async function PUT(request: Request) {
  try {
    const account = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!validateApnsRegistrationRequest(body)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A V2 device token and supported APNs environment are required');
    }
    const token = body.deviceToken.toLowerCase();
    const digest = tokenDigest(token);
    const encrypted = JSON.stringify(encryptPlatformEnvelope(token));
    const environment = body.environment as 'DEVELOPMENT' | 'PRODUCTION';
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${account.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${account.trustedDeviceId}::uuid FOR UPDATE`;
      const now = new Date();
      const [session, device] = await Promise.all([
        tx.customerSession.findUnique({ where: { id: account.sessionId }, select: {
          customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true,
          accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true,
          revokedAt: true, expiresAt: true, absoluteExpiresAt: true,
        } }),
        tx.trustedDevice.findUnique({ where: { id: account.trustedDeviceId }, select: {
          customerAccountId: true, sessionVersion: true, revokedAt: true, apnsTokenDigest: true,
          apnsEnvironment: true, apnsTokenRevision: true,
        } }),
      ]);
      const credentialCurrent = account.credentialKind === 'access'
        ? session?.accessTokenHash === account.accessTokenHash && Boolean(session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
        : session?.refreshTokenHash === account.refreshTokenHash;
      if (!session || session.customerAccountId !== account.id || session.trustedDeviceId !== account.trustedDeviceId
        || !credentialCurrent || session.securityVersion !== account.securityVersion
        || session.trustedDeviceSessionVersion !== account.trustedDeviceSessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !device || device.customerAccountId !== account.id || device.revokedAt
        || device.sessionVersion !== account.trustedDeviceSessionVersion) {
        throw new Stage1AuthError(401, 'customer_session_invalid', 'The trusted installation is no longer active');
      }
      if (device.apnsTokenDigest === digest && device.apnsEnvironment === environment) {
        return { revision: device.apnsTokenRevision, state: 'ENABLED' as const, idempotentReplay: true };
      }
      const updated = await tx.trustedDevice.updateMany({
        where: { id: account.trustedDeviceId, customerAccountId: account.id, revokedAt: null, sessionVersion: account.trustedDeviceSessionVersion },
        data: {
          apnsTokenCiphertext: encrypted, apnsTokenDigest: digest, apnsEnvironment: environment,
          apnsKeyVersion: 1, apnsTokenRevision: { increment: 1 }, pushEnabledAt: now, pushRevokedAt: null,
          lastDeliveryHealth: 'REGISTERED',
        },
      });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'PUSH_REGISTRATION_STALE', 'Refresh this installation and try again');
      const current = await tx.trustedDevice.findUniqueOrThrow({ where: { id: account.trustedDeviceId }, select: { apnsTokenRevision: true } });
      return { revision: current.apnsTokenRevision, state: 'ENABLED' as const, idempotentReplay: false };
    }, { isolationLevel: 'Serializable' });
    const receipt = { schemaVersion: 'dinodia.v1' as const, ok: true as const, trustedDeviceId: account.trustedDeviceId, ...result };
    if (!validateApnsRegistrationReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The push registration receipt failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const account = await requireCustomerAccountSession(request);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${account.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${account.trustedDeviceId}::uuid FOR UPDATE`;
      const now = new Date();
      const [session, device] = await Promise.all([
        tx.customerSession.findUnique({ where: { id: account.sessionId }, select: {
          customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true,
          accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true,
          revokedAt: true, expiresAt: true, absoluteExpiresAt: true,
        } }),
        tx.trustedDevice.findUnique({ where: { id: account.trustedDeviceId }, select: {
          customerAccountId: true, sessionVersion: true, revokedAt: true, apnsTokenRevision: true,
          apnsTokenDigest: true,
        } }),
      ]);
      const credentialCurrent = account.credentialKind === 'access'
        ? session?.accessTokenHash === account.accessTokenHash && Boolean(session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
        : session?.refreshTokenHash === account.refreshTokenHash;
      if (!session || session.customerAccountId !== account.id || session.trustedDeviceId !== account.trustedDeviceId
        || !credentialCurrent || session.securityVersion !== account.securityVersion
        || session.trustedDeviceSessionVersion !== account.trustedDeviceSessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !device || device.customerAccountId !== account.id || device.revokedAt
        || device.sessionVersion !== account.trustedDeviceSessionVersion) {
        throw new Stage1AuthError(401, 'customer_session_invalid', 'The trusted installation is no longer active');
      }
      if (!device.apnsTokenDigest) return { revision: device.apnsTokenRevision, state: 'DISABLED' as const, idempotentReplay: true };
      const updated = await tx.trustedDevice.updateMany({
        where: { id: account.trustedDeviceId, customerAccountId: account.id, revokedAt: null, sessionVersion: account.trustedDeviceSessionVersion },
        data: { apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null,
          apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED' },
      });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'PUSH_REGISTRATION_STALE', 'Refresh this installation and try again');
      const current = await tx.trustedDevice.findUniqueOrThrow({ where: { id: account.trustedDeviceId }, select: { apnsTokenRevision: true } });
      return { revision: current.apnsTokenRevision, state: 'DISABLED' as const, idempotentReplay: false };
    }, { isolationLevel: 'Serializable' });
    const receipt = { schemaVersion: 'dinodia.v1' as const, ok: true as const, trustedDeviceId: account.trustedDeviceId, ...result };
    if (!validateApnsRegistrationReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The push registration receipt failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
