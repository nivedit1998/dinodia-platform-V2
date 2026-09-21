// Architecture: API boundary /auth/challenges/[id]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { getChallengeStatusDetail } from '@/lib/authChallenges';
import { AUTH_ERROR_CODES } from '@/lib/authErrorCodes';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const detail = await getChallengeStatusDetail(id);
  if (detail.status === 'NOT_FOUND') {
    return NextResponse.json(
      {
        ok: false,
        status: detail.status,
        errorCode: AUTH_ERROR_CODES.VERIFICATION_FAILED,
        error: 'Verification request not found.',
        serverNow: detail.serverNow,
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: detail.status,
    expiresAt: detail.expiresAt,
    approvedAt: detail.approvedAt,
    consumedAt: detail.consumedAt,
    serverNow: detail.serverNow,
  });
}
