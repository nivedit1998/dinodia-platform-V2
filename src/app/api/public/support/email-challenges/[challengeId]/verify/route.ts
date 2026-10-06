import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validatePublicSupportEmailVerificationRequest, validatePublicSupportTicketReceipt } from '@/lib/contracts/dinodiaV1';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { verifyAndCreatePublicSupportTicket } from '@/lib/publicSupport';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ challengeId: string }> }) {
  try {
    const { challengeId } = await context.params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !validatePublicSupportEmailVerificationRequest({ ...body, challengeId })) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid verification code and support request are required');
    }
    const receipt = await verifyAndCreatePublicSupportTicket({ ...body, challengeId });
    if (!validatePublicSupportTicketReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The support submission receipt failed validation');
    return NextResponse.json(receipt, { status: receipt.idempotentReplay ? 200 : 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return nativeV1ErrorResponse(error);
  }
}
