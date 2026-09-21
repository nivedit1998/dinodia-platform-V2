// Architecture: API boundary /auth/challenges/[id]/resend; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { resendChallengeEmail } from '@/lib/authChallenges';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { AUTH_ERROR_CODES } from '@/lib/authErrorCodes';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`challenge-resend:${id}:${ip}`, {
    maxRequests: 3,
    windowMs: 120_000,
  });
  if (!allowed) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: AUTH_ERROR_CODES.RATE_LIMITED,
        error: 'Too many requests. Please wait before resending.',
      },
      { status: 429 }
    );
  }

  const result = await resendChallengeEmail(id);

  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') {
      return NextResponse.json(
        {
          ok: false,
          errorCode: AUTH_ERROR_CODES.VERIFICATION_FAILED,
          error: 'Verification request not found.',
        },
        { status: 404 }
      );
    }
    if (result.reason === 'TOO_SOON') {
      return NextResponse.json(
        {
          ok: false,
          errorCode: AUTH_ERROR_CODES.RATE_LIMITED,
          error: 'Please wait before resending.',
          retryAfterSeconds: result.retryAfterSeconds ?? null,
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        errorCode: AUTH_ERROR_CODES.VERIFICATION_FAILED,
        error: 'Unable to resend verification email.',
        reason: result.reason,
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    resentAt: result.resentAt,
    resendAvailableAt: result.resendAvailableAt,
    expiresAt: result.expiresAt,
  });
}
