import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validatePublicSupportEmailChallengeReceipt, validatePublicSupportEmailChallengeRequest } from '@/lib/contracts/dinodiaV1';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { beginPublicSupportVerification } from '@/lib/publicSupport';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!validatePublicSupportEmailChallengeRequest(body)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A reply email, approved category and support description are required');
    }
    const result = await beginPublicSupportVerification(body);
    const receipt = {
      schemaVersion: 'dinodia.v1', ok: true, state: 'PENDING', challengeId: result.challengeId,
      expiresAt: result.expiresAt.toISOString(), emailSubmission: result.emailSubmission,
    };
    if (!validatePublicSupportEmailChallengeReceipt(receipt)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The support verification receipt failed validation');
    return NextResponse.json(receipt, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return nativeV1ErrorResponse(error);
  }
}
