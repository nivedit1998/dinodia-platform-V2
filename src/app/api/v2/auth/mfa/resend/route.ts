import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { resendMfaChallenge } from '@/lib/accountMfa';

export const dynamic = 'force-dynamic';

/** A fresh code for the same challenge. Needs the challenge and the secret only the signing-in app holds. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'challengeId,clientSecret') {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A challenge is required');
    }
    const result = await resendMfaChallenge({ challengeId: body.challengeId, clientSecret: body.clientSecret });
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, maskedEmail: result.maskedEmail, expiresAt: result.expiresAt.toISOString(), resendAvailableAt: result.resendAvailableAt.toISOString() },
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
