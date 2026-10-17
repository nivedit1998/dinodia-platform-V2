import { NextResponse } from 'next/server';
import { validateCustomerInvitationDecisionReceipt, validateCustomerInvitationDecisionRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { decideCustomerInvitation } from '@/lib/customerInvitation';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;

export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  const startedAt = Date.now();
  let phase = 'session_authentication';
  try {
    const customer = await requireCustomerAccountSession(request);
    phase = 'request_validation';
    const { invitationId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This invitation is no longer available');
    }
    const body = await request.json().catch(() => null);
    if (!validateCustomerInvitationDecisionRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The invitation decision request is invalid');
    phase = 'decision_transaction';
    const receipt = await decideCustomerInvitation({
      invitationId, decision: body.decision, expectedUpdatedAt: body.expectedUpdatedAt,
      accountId: customer.id, email: customer.email, sessionId: customer.sessionId,
      refreshTokenHash: customer.refreshTokenHash, securityVersion: customer.securityVersion,
      trustedDeviceId: customer.trustedDeviceId, trustedDeviceSessionVersion: customer.trustedDeviceSessionVersion,
      credentialKind: customer.credentialKind, accessTokenHash: customer.accessTokenHash, accessTokenExpiresAt: customer.accessTokenExpiresAt,
    }, (nextPhase) => { phase = nextPhase; });
    phase = 'receipt_contract_validation';
    if (!validateCustomerInvitationDecisionReceipt(receipt, invitationId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The invitation decision receipt failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error, { operation: 'customer_invitation_decision', phase, startedAt }); }
}
