import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request, { allowPolicyGate: true });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${customer.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${customer.sessionId}::uuid FOR UPDATE`;
      const now = new Date();
      const [account, session, device] = await Promise.all([
        tx.customerAccount.findUnique({ where: { id: customer.id }, select: { status: true, securityVersion: true } }),
        tx.customerSession.findUnique({ where: { id: customer.sessionId }, select: { customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: customer.trustedDeviceId }, select: { customerAccountId: true, sessionVersion: true, revokedAt: true } }),
      ]);
      if (!account || account.status !== 'ACTIVE' || account.securityVersion !== customer.securityVersion
        || !session || session.customerAccountId !== customer.id || session.trustedDeviceId !== customer.trustedDeviceId
        || session.refreshTokenHash !== customer.refreshTokenHash || session.securityVersion !== customer.securityVersion
        || session.trustedDeviceSessionVersion !== customer.trustedDeviceSessionVersion || session.revokedAt
        || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !device || device.customerAccountId !== customer.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion) {
        throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
      }
      await tx.customerSession.updateMany({ where: { trustedDeviceId: customer.trustedDeviceId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'customer_logout', accessTokenHash: null, accessTokenExpiresAt: null } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: customer.trustedDeviceId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'customer_logout' } });
      await tx.trustedDevice.updateMany({ where: { id: customer.trustedDeviceId, customerAccountId: customer.id, revokedAt: null }, data: {
        apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null,
        apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED',
      } });
    }, { isolationLevel: 'Serializable' });
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
