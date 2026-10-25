import { NextResponse } from 'next/server';
import { POST as createCookieSession } from '../../auth/session/route';
import { validateMobileCustomerSessionReceipt } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { bindMobileAccessToken, buildMobileSessionReceipt, mobileTokenFormatIsValid, rotateMobileRefreshToken } from '@/lib/mobileCustomerSession';

export const dynamic = 'force-dynamic';

function refreshTokenFromCookie(header: string | null): string | null {
  const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith('dinodia_customer_session='))?.slice('dinodia_customer_session='.length);
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

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

    const response = await createCookieSession(request);
    if (!response.ok) return response;
    const metadata = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
    const refreshToken = refreshTokenFromCookie(response.headers.get('set-cookie'));
    if (!metadata || typeof metadata.accountId !== 'string' || typeof metadata.sessionId !== 'string'
      || typeof metadata.trustedDeviceId !== 'string' || !refreshToken) {
      throw new Stage1AuthError(500, 'mobile_session_unavailable', 'The mobile session could not be established');
    }
    const credentials = await bindMobileAccessToken(metadata.sessionId, refreshToken);
    const receipt = await buildMobileSessionReceipt({
      accountId: metadata.accountId, sessionId: metadata.sessionId, trustedDeviceId: metadata.trustedDeviceId,
      accessToken: credentials.accessToken, refreshToken: credentials.refreshToken,
      accessTokenExpiresAt: credentials.accessTokenExpiresAt, refreshTokenExpiresAt: credentials.refreshExpiresAt,
    });
    if (!validateMobileCustomerSessionReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The mobile session receipt failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
