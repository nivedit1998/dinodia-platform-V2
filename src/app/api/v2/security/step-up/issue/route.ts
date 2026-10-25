import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { issueStepUp } from '@/lib/sensitiveOperationStepUp';
import { validateStepUpIssueRequest, validateStepUpProofReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const normalized = body && typeof body === 'object' && !Array.isArray(body) ? {
      challengeId: body.challengeId,
      nonce: body.nonce ?? request.headers.get('x-dinodia-step-up-nonce'),
      deviceSignature: body.deviceSignature ?? request.headers.get('x-dinodia-device-signature'),
    } : body;
    if (!normalized || !validateStepUpIssueRequest(normalized)) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A valid server-issued challenge, nonce and device assertion are required');
    const checked = normalized as { challengeId: string; nonce: string; deviceSignature: string };
    const challengeId = checked.challengeId;
    const assertionSignature = checked.deviceSignature;
    const assertionNonce = checked.nonce;
    const result = await issueStepUp({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, trustedDevicePublicKey: customer.trustedDevicePublicKey, assertionSignature, assertionNonce, challengeId });
    const receipt = { ok: true, ...result, expiresAt: result.expiresAt.toISOString() };
    if (!validateStepUpProofReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The step-up proof response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
