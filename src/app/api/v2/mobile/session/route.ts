import { NextResponse } from 'next/server';
import { POST as createCookieSession } from '../../auth/session/route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { buildMobileSessionReceipt, mobileTokenFormatIsValid, rotateMobileRefreshToken } from '@/lib/mobileCustomerSession';
import { validateMobileCustomerSessionReceipt } from '@/lib/contracts/dinodiaV1';
import { mobileResponseFromSignIn } from '@/lib/mobileSignInReceipt';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (body && !Array.isArray(body) && Object.keys(body).sort().join(',') === 'refreshToken') {
      if (!mobileTokenFormatIsValid(body.refreshToken)) throw new Stage1AuthError(400, 'customer_refresh_invalid', 'The mobile refresh request is invalid');
      const rotated = await rotateMobileRefreshToken(body.refreshToken);
      if ('error' in rotated) {
        const code = rotated.error === 'expired' ? 'customer_session_expired' : 'customer_session_invalid';
        throw new Stage1AuthError(401, code, 'The customer session is no longer active');
      }
      const receipt = await buildMobileSessionReceipt({
        accountId: rotated.accountId, sessionId: rotated.sessionId, trustedDeviceId: rotated.trustedDeviceId,
        accessToken: rotated.accessToken, refreshToken: rotated.refreshToken,
        accessTokenExpiresAt: rotated.accessTokenExpiresAt, refreshTokenExpiresAt: rotated.expiresAt,
      });
      if (!validateMobileCustomerSessionReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The mobile session receipt failed contract validation');
      return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    }

    return await mobileResponseFromSignIn(await createCookieSession(request));
  } catch (error) { return nativeV1ErrorResponse(error); }
}
