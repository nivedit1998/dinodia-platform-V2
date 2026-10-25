import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { listCustomerPendingRelationships } from '@/lib/customerPendingRelationships';
import { validateCustomerPendingRelationshipsProjection } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const projection = await listCustomerPendingRelationships(customer.id);
    if (!validateCustomerPendingRelationshipsProjection(projection)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The pending relationship projection failed contract validation');
    return NextResponse.json(projection, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
