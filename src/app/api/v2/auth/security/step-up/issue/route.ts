import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { issueStepUp } from '@/lib/sensitiveOperationStepUp';
import { validateStepUpIssueRequest, validateStepUpProofReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const normalized = body && typeof body === 'object' && !Array.isArray(body) ? {
      challengeId: body.challengeId,
      nonce: body.nonce ?? request.headers.get('x-dinodia-step-up-nonce'),
      deviceSignature: body.deviceSignature ?? request.headers.get('x-dinodia-device-signature'),
    } : body;
    if (!normalized || !validateStepUpIssueRequest(normalized)) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A valid account security challenge, nonce and device assertion are required');
    const checked = normalized as { challengeId: string; nonce: string; deviceSignature: string };
    const challenge = await prisma.stepUpChallenge.findUnique({ where: { id: checked.challengeId }, select: { customerAccountId: true, customerSessionId: true, trustedDeviceId: true, homeId: true, membershipId: true, hubInstallationId: true, operationKind: true, policyRevision: true, consumedAt: true, cancelledAt: true, expiresAt: true } });
    if (!challenge || challenge.customerAccountId !== customer.id || challenge.customerSessionId !== customer.sessionId
      || challenge.trustedDeviceId !== customer.trustedDeviceId || challenge.homeId !== null || challenge.membershipId !== null
      || challenge.hubInstallationId !== null || !['trusted_device_remove', 'customer_password_change', 'customer_profile_change', 'customer_email_change'].includes(challenge.operationKind)
      || challenge.policyRevision !== customer.securityVersion || challenge.consumedAt || challenge.cancelledAt || challenge.expiresAt <= new Date()) {
      throw new Stage1AuthError(409, 'step_up_challenge_unavailable', 'The account security challenge is unavailable or no longer current');
    }
    const device = await prisma.trustedDevice.findUnique({ where: { id: customer.trustedDeviceId }, select: { customerAccountId: true, publicKey: true, revokedAt: true, sessionVersion: true } });
    if (!device || device.customerAccountId !== customer.id || device.revokedAt || device.sessionVersion !== customer.trustedDeviceSessionVersion) throw new Stage1AuthError(401, 'customer_session_invalid', 'The signing phone is no longer trusted');
    const result = await issueStepUp({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, trustedDevicePublicKey: device.publicKey, expectedSecurityVersion: customer.securityVersion, expectedDeviceSessionVersion: customer.trustedDeviceSessionVersion, expectedRefreshTokenHash: customer.refreshTokenHash, assertionSignature: checked.deviceSignature, assertionNonce: checked.nonce, challengeId: checked.challengeId });
    const receipt = { ok: true, ...result, expiresAt: result.expiresAt.toISOString() };
    if (!validateStepUpProofReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The account security proof response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
