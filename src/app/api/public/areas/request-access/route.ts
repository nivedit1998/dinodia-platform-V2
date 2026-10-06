import { NextResponse } from 'next/server';
import { validateCustomerRoomAccessRequestReceipt, validateCustomerRoomAccessRequestRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { sha256 } from '@/lib/stage1Crypto';
import { requestCustomerRoomAccess } from '@/lib/customerRoomAccess';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null);
    if (!validateCustomerRoomAccessRequestRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The Room access request is invalid. Scan the current QR and try again.');
    await enforcePersistentRateLimit(`room-access-request:${customer.id}:${sha256(body.reference)}`, 8, 60 * 60 * 1000);
    const receipt = await requestCustomerRoomAccess({ ...body, customer });
    if (!validateCustomerRoomAccessRequestReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Room access response failed contract validation');
    // A first request creates a resource (201); a coalesced or exact replay
    // reconciles the existing resource and must not look like another create.
    return NextResponse.json(receipt, { status: receipt.coalesced || receipt.idempotentReplay ? 200 : 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
