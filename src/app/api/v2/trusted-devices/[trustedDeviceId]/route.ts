import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { cookieToken, requireCustomer, requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { consumeStepUp, operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { sha256 } from '@/lib/stage1Crypto';
import { validateTrustedDeviceRemovalReceipt, validateTrustedDeviceRemovalRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ trustedDeviceId: string }> }) {
  try {
    const accountCookie = cookieToken(request, 'dinodia_customer_session');
    const mobileBearer = /^Bearer dno-customer-access-[A-Za-z0-9_-]{32,160}$/.test(request.headers.get('authorization') ?? '');
    const account = accountCookie || mobileBearer ? await requireCustomerAccountSession(request) : null;
    const customer = account ? null : await requireCustomer(request);
    const { trustedDeviceId } = await context.params;
    if (!trustedDeviceId) throw new Stage1AuthError(400, 'trusted_device_target_invalid', 'A trusted phone must be selected');
    const rawBody = await request.text();
    let body: unknown = {};
    if (rawBody.trim()) {
      try { body = JSON.parse(rawBody) as unknown; }
      catch { throw new Stage1AuthError(400, 'trusted_device_request_invalid', 'The trusted-device removal request must be valid JSON'); }
    }
    if (!validateTrustedDeviceRemovalRequest(body)) throw new Stage1AuthError(400, 'trusted_device_request_invalid', 'The trusted-device removal request does not match the supported contract');
    const requestBody = body as { proof?: string };
    const proof = String(requestBody.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? '');
    if (account) {
      const targetIds = [trustedDeviceId];
      const digest = operationDigest({ customerAccountId: account.id, customerSessionId: account.sessionId, trustedDeviceId: account.trustedDeviceId, operationKind: 'trusted_device_remove', targetIds, value: null });
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${account.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${account.sessionId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${trustedDeviceId}::uuid FOR UPDATE`;
        const now = new Date();
        const [currentAccount, currentSession, target] = await Promise.all([
          tx.customerAccount.findUnique({ where: { id: account.id }, select: { status: true, securityVersion: true } }),
          tx.customerSession.findUnique({ where: { id: account.sessionId }, select: { customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true, trustedDevice: { select: { customerAccountId: true, sessionVersion: true, revokedAt: true } } } }),
          tx.trustedDevice.findUnique({ where: { id: trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true } }),
        ]);
        if (!currentAccount || currentAccount.status !== 'ACTIVE' || currentAccount.securityVersion !== account.securityVersion
          || !currentSession || currentSession.customerAccountId !== account.id || currentSession.trustedDeviceId !== account.trustedDeviceId
          || currentSession.refreshTokenHash !== account.refreshTokenHash || currentSession.securityVersion !== account.securityVersion
          || currentSession.revokedAt || currentSession.expiresAt <= now || currentSession.absoluteExpiresAt <= now
          || currentSession.trustedDevice.customerAccountId !== account.id || currentSession.trustedDevice.revokedAt
          || currentSession.trustedDevice.sessionVersion !== currentSession.trustedDeviceSessionVersion) {
          throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
        }
        if (!target || target.customerAccountId !== account.id || target.revokedAt) throw new Stage1AuthError(404, 'trusted_device_not_found', 'The trusted device was not found');
        const proofUse = await tx.stepUpAuthorization.updateMany({ where: {
          nonceHash: sha256(proof), customerAccountId: account.id, customerSessionId: account.sessionId,
          trustedDeviceId: account.trustedDeviceId, homeId: null, membershipId: null,
          operationKind: 'trusted_device_remove', targetDigest: targetDigest(targetIds), normalizedValueDigest: digest,
          policyRevision: account.securityVersion, consumedAt: null, revokedAt: null, expiresAt: { gt: now },
        }, data: { consumedAt: now } });
        if (proofUse.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'The operation confirmation is invalid, expired, replayed or does not match this phone');
        await tx.trustedDevice.update({ where: { id: trustedDeviceId }, data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null, apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED' } });
        await tx.customerSession.updateMany({ where: { trustedDeviceId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'trusted_device_removed', accessTokenHash: null, accessTokenExpiresAt: null } });
        await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'trusted_device_removed' } });
        await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'trusted_device_removed', targetType: 'TrustedDevice', targetId: trustedDeviceId, metadata: { accountWide: true, otherInstallationsRevoked: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      }, { isolationLevel: 'Serializable' });
    } else if (customer) {
      await consumeStepUp({ proof, customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind: 'trusted_device_remove', targetIds: [trustedDeviceId], value: null, policyRevision: customer.policyRevision });
      const device = await prisma.trustedDevice.findUnique({ where: { id: trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true } });
      if (!device || device.customerAccountId !== customer.id || device.revokedAt) throw new Stage1AuthError(404, 'trusted_device_not_found', 'The trusted device was not found');
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.trustedDevice.update({ where: { id: trustedDeviceId }, data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null, apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'DISABLED' } });
        await tx.customerSession.updateMany({ where: { trustedDeviceId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'trusted_device_removed', accessTokenHash: null, accessTokenExpiresAt: null } });
        await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'trusted_device_removed' } });
      });
    }
    const receipt = { ok: true, trustedDeviceId, accountWide: true };
    if (!validateTrustedDeviceRemovalReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The trusted-device removal response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
