import { NextResponse } from 'next/server';
import { validateCustomerHomeClaimCompleteReceipt, validateCustomerHomeClaimCompleteRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { completeClaimSetup } from '@/lib/stage1ClaimContract';
import { readCustomerClaimSetup } from '@/lib/customerHomeClaim';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!validateCustomerHomeClaimCompleteRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current setup revision and idempotency key are required');
    const { claimId } = await context.params;
    const before = await readCustomerClaimSetup(claimId, customer.id, customer);
    if (before.revision !== body.expectedRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and try again');
    const result = await completeClaimSetup(claimId, customer.id, customer, Number(body.expectedRevision));
    const status = result.ok ? result.state : 'PENDING_INSTALLATION';
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, claimId, state: status, idempotentReplay: Boolean((result as { idempotentReplay?: boolean }).idempotentReplay), postcode: before.postcode };
    if (!validateCustomerHomeClaimCompleteReceipt(receipt, claimId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Home completion receipt failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
