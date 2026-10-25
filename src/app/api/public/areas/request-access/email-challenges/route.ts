import { NextResponse } from 'next/server';
import { validatePublicRoomAccessEmailChallengeReceipt, validatePublicRoomAccessEmailChallengeRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { beginProspectiveRoomAccess } from '@/lib/customerRoomAccess';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!validatePublicRoomAccessEmailChallengeRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Enter an email address and scan a current Dinodia Room QR');
    const receipt = await beginProspectiveRoomAccess(body);
    if (!validatePublicRoomAccessEmailChallengeReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Room email challenge failed contract validation');
    return NextResponse.json(receipt, { status: receipt.state === 'PENDING' ? 200 : 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
