import { NextResponse } from 'next/server';
import { validateCustomerHomeClaimAddress } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { readClaimAddressContract } from '@/lib/stage1ClaimContract';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { claimId } = await context.params;
    const address = await readClaimAddressContract(claimId, customer.id, customer);
    const response = { schemaVersion: 'dinodia.v1', ok: true, claimId, ...address };
    if (!validateCustomerHomeClaimAddress(response, claimId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Home claim address failed validation');
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
