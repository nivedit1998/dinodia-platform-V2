import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { readCustomerRoomAccessRequest } from '@/lib/customerRoomAccess';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { requestId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Room access request is not available');
    const receipt = await readCustomerRoomAccessRequest(requestId, customer.id);
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
