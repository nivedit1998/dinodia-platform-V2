import { NextResponse } from 'next/server';
import { validateCustomerHomeClaimSetupStatus } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { readCustomerClaimSetup } from '@/lib/customerHomeClaim';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { claimId } = await context.params;
    const status = await readCustomerClaimSetup(claimId, customer.id, customer);
    if (!validateCustomerHomeClaimSetupStatus(status)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Home claim status failed validation');
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
