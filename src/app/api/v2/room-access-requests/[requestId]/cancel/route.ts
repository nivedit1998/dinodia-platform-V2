import { NextResponse } from 'next/server';
import { validateCustomerRoomAccessCancelRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { cancelCustomerRoomAccessRequest } from '@/lib/customerRoomAccess';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { requestId } = await context.params;
    const body = await request.json().catch(() => null);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) || !validateCustomerRoomAccessCancelRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Refresh the Room request before cancelling it');
    const receipt = await cancelCustomerRoomAccessRequest({ requestId, customer, ...body });
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
