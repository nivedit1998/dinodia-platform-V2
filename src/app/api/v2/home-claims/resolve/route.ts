import { NextResponse } from 'next/server';
import { validateCustomerHomeClaimResolveReceipt, validateCustomerHomeClaimResolveRequest } from '@/lib/contracts/dinodiaV1';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { hashClaimReference, redeemClaimContract } from '@/lib/stage1ClaimContract';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const key = String(request.headers.get('idempotency-key') ?? '').trim();
    if (!validateCustomerHomeClaimResolveRequest(body) || !/^[A-Za-z0-9._:-]{16,160}$/.test(key)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid Home QR and idempotency key are required');
    }
    // The key and reference are never logged. Rate-limit by the keyed digest,
    // not by the raw QR payload.
    await enforcePersistentRateLimit(`customer-home-claim:${customer.id}:${hashClaimReference(body.reference)}`, 12, 15 * 60 * 1000);
    const result = await redeemClaimContract({ reference: body.reference, customerAccountId: customer.id, emailVerified: Boolean(customer.emailVerifiedAt), principal: customer });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, claimId: result.reservationId, generation: result.generation, state: 'SETUP', expiresAt: result.expiresAt.toISOString() };
    if (!validateCustomerHomeClaimResolveReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Home claim receipt failed validation');
    return NextResponse.json(receipt, { status: 200, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
