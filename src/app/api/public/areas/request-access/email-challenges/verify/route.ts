import { NextResponse } from 'next/server';
import { validatePublicRoomAccessEmailVerificationReceipt, validatePublicRoomAccessEmailVerificationRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { verifyProspectiveRoomAccess } from '@/lib/customerRoomAccess';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!validatePublicRoomAccessEmailVerificationRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Enter the request, challenge and six-digit code');
    const receipt = await verifyProspectiveRoomAccess(body);
    if (!validatePublicRoomAccessEmailVerificationReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The verified Room request failed contract validation');
    return NextResponse.json(receipt, { status: receipt.idempotentReplay ? 200 : 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
