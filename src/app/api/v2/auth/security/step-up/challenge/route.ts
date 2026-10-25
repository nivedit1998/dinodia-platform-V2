import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { validateStepUpChallengeReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const kind = body?.operationKind;
    const passwordChange = kind === 'customer_password_change';
    const profileChange = kind === 'customer_profile_change';
    const emailChange = kind === 'customer_email_change';
    const valueBoundChange = passwordChange || profileChange || emailChange;
    const expectedKeys = valueBoundChange ? 'operationKind,targetIds,value' : 'operationKind,targetIds';
    const targetIds = body?.targetIds;
    const validTargets = Array.isArray(targetIds) && targetIds.length === 1
      && typeof targetIds[0] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetIds[0]);
    const suppliedValue = body?.value && typeof body.value === 'object' && !Array.isArray(body.value) ? body.value as Record<string, unknown> : null;
    const validValue = passwordChange && suppliedValue
      && Object.keys(suppliedValue).join(',') === 'newPasswordDigest'
      && typeof suppliedValue.newPasswordDigest === 'string' && /^[0-9a-f]{64}$/.test(suppliedValue.newPasswordDigest)
      || profileChange && suppliedValue
      && Object.keys(suppliedValue).sort().join(',') === 'displayName,phoneNumber,profileRevision,usernameNormalized'
      && typeof suppliedValue.displayName === 'string' && suppliedValue.displayName.trim().length > 0 && suppliedValue.displayName.length <= 160
      && typeof suppliedValue.usernameNormalized === 'string' && suppliedValue.usernameNormalized === suppliedValue.usernameNormalized.trim().toLowerCase()
      && suppliedValue.usernameNormalized.length > 0 && Array.from(suppliedValue.usernameNormalized).length <= 80
      && typeof suppliedValue.profileRevision === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(suppliedValue.profileRevision)
      && (suppliedValue.phoneNumber === null || typeof suppliedValue.phoneNumber === 'string' && /^[+() .0-9-]{7,40}$/.test(suppliedValue.phoneNumber))
      || emailChange && suppliedValue
      && Object.keys(suppliedValue).sort().join(',') === 'emailNormalized,profileRevision'
      && typeof suppliedValue.emailNormalized === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(suppliedValue.emailNormalized)
      && suppliedValue.emailNormalized === suppliedValue.emailNormalized.trim().toLowerCase() && suppliedValue.emailNormalized.length <= 320
      && typeof suppliedValue.profileRevision === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(suppliedValue.profileRevision);
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== expectedKeys
      || (!valueBoundChange && kind !== 'trusted_device_remove') || !validTargets
      || (valueBoundChange && (!validValue || targetIds?.[0] !== customer.id))) {
      throw new Stage1AuthError(400, 'step_up_fields_invalid', 'The account security operation does not match the supported target and value');
    }
    const safeTargetIds = targetIds as string[];
    const value = valueBoundChange ? suppliedValue : null;
    const digest = operationDigest({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, operationKind: kind as string, targetIds: safeTargetIds, value });
    const nonce = crypto.randomBytes(32).toString('base64url');
    let now = new Date();
    const challenge = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${customer.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${customer.sessionId}::uuid FOR UPDATE`;
      const current = await tx.customerSession.findUnique({ where: { id: customer.sessionId }, select: { customerAccountId: true, trustedDeviceId: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, refreshTokenHash: true, trustedDevice: { select: { revokedAt: true, sessionVersion: true } }, customerAccount: { select: { securityVersion: true, status: true } } } });
      now = new Date();
      if (!current || current.customerAccountId !== customer.id || current.trustedDeviceId !== customer.trustedDeviceId
        || current.revokedAt || current.expiresAt <= now || current.absoluteExpiresAt <= now
        || current.customerAccount.status !== 'ACTIVE' || current.customerAccount.securityVersion !== customer.securityVersion
        || current.securityVersion !== customer.securityVersion || current.refreshTokenHash !== customer.refreshTokenHash || current.trustedDevice.revokedAt
        || current.trustedDevice.sessionVersion !== current.trustedDeviceSessionVersion) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
      if (!valueBoundChange) {
        const target = await tx.trustedDevice.findUnique({ where: { id: safeTargetIds[0] }, select: { id: true, customerAccountId: true, revokedAt: true } });
        if (!target || target.customerAccountId !== customer.id || target.revokedAt) throw new Stage1AuthError(404, 'trusted_device_not_found', 'The trusted device was not found');
      }
      return tx.stepUpChallenge.create({ data: {
        customerAccountId: customer.id,
        customerSessionId: customer.sessionId,
        trustedDeviceId: customer.trustedDeviceId,
        homeId: null,
        membershipId: null,
        hubInstallationId: null,
        operationKind: kind as string,
        targetDigest: targetDigest(safeTargetIds),
        normalizedValueDigest: digest,
        policyRevision: customer.securityVersion,
        nonceHash: crypto.createHash('sha256').update(nonce, 'utf8').digest('hex'),
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }, select: { id: true, expiresAt: true } });
    }, { isolationLevel: 'Serializable' });
    const receipt = { ok: true, challengeId: challenge.id, nonce, operationDigest: digest, expiresAt: challenge.expiresAt.toISOString() };
    if (!validateStepUpChallengeReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The account step-up challenge failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request, { allowPasswordChangeOnly: true, allowPolicyGate: true });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'challengeId'
      || typeof body.challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.challengeId)) {
      throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A valid account security challenge identifier is required');
    }
    const cancelled = await prisma.stepUpChallenge.updateMany({ where: {
      id: body.challengeId, customerAccountId: customer.id, customerSessionId: customer.sessionId,
      trustedDeviceId: customer.trustedDeviceId, homeId: null, membershipId: null, hubInstallationId: null,
      operationKind: { in: ['trusted_device_remove', 'customer_password_change', 'customer_profile_change', 'customer_email_change'] }, consumedAt: null, cancelledAt: null, expiresAt: { gt: new Date() },
    }, data: { cancelledAt: new Date() } });
    if (cancelled.count !== 1) throw new Stage1AuthError(409, 'step_up_challenge_unavailable', 'The account security challenge is already consumed, cancelled or unavailable');
    return NextResponse.json({ ok: true, cancelled: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
