import { NextResponse } from 'next/server';
import { validateCustomerHomeClaimSetupStatus } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { readCustomerClaimSetup } from '@/lib/customerHomeClaim';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).sort().join(',') !== 'expectedRevision,idempotencyKey'
      || !Number.isSafeInteger(body.expectedRevision) || typeof body.idempotencyKey !== 'string'
      || !/^[A-Za-z0-9._:-]{16,160}$/.test(body.idempotencyKey)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current setup revision and idempotency key are required');
    const { claimId } = await context.params;
    const status = await readCustomerClaimSetup(claimId, customer.id, customer);
    if (status.revision !== body.expectedRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and try again');
    if (!validateCustomerHomeClaimSetupStatus(status)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Home claim status failed validation');
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
