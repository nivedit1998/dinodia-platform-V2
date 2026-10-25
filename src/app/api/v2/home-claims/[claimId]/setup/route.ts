import { NextResponse } from 'next/server';
import { validateCustomerHomeClaimSetupReceipt, validateCustomerHomeClaimSetupRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { recordQualifyingClaimMutation } from '@/lib/stage1ClaimContract';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicy';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const key = String(request.headers.get('idempotency-key') ?? '').trim();
    if (!validateCustomerHomeClaimSetupRequest(body) || !/^[A-Za-z0-9._:-]{16,160}$/.test(key)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid setup step and idempotency key are required');
    }
    if (body.step === 'POLICY') {
      const policy = currentCustomerPolicy();
      if (!policy) throw new Stage1AuthError(503, 'policy_unavailable', 'The approved customer policy is not configured');
      if (body.mutation.policyVersion !== policy.version || body.mutation.contentSha256 !== policy.contentSha256 || body.mutation.accepted !== true) {
        throw new Stage1AuthError(409, 'policy_stale', 'Review and accept the current customer policy before continuing');
      }
    }
    const { claimId } = await context.params;
    const result = await recordQualifyingClaimMutation(claimId, customer.id, body.step, body.mutation, customer, Number(body.expectedRevision));
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, claimId, step: body.step, expiresAt: result.expiresAt.toISOString(), revision: result.setupRevision };
    if (!validateCustomerHomeClaimSetupReceipt(receipt, claimId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Home setup receipt failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
