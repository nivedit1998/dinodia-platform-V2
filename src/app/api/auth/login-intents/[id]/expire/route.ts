// Architecture: API boundary /auth/login-intents/[id]/expire; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextResponse } from 'next/server';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { revokeLoginIntent } from '@/lib/loginIntents';

function fail(status: number, errorCode: AuthErrorCode, error: string) {
  return NextResponse.json({ ok: false, errorCode, error }, { status });
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Login session id is required.');
    }
    await revokeLoginIntent(id);
    return NextResponse.json({ ok: true });
  } catch {
    return fail(500, AUTH_ERROR_CODES.INTERNAL_ERROR, 'Unable to expire login session right now.');
  }
}
