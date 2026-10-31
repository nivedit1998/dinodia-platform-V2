import { NextResponse } from 'next/server';
import { validateMobileCustomerSessionReceipt } from '@/lib/contracts/dinodiaV1';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { bindMobileAccessToken, buildMobileSessionReceipt } from '@/lib/mobileCustomerSession';

function refreshTokenFromCookie(header: string | null): string | null {
  const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith('dinodia_customer_session='))?.slice('dinodia_customer_session='.length);
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

/**
 * Turns the cookie-flavoured sign-in result into what the phone app receives: its access and refresh tokens. A result that
 * says a code is still needed passes straight through (it carries no session); a failure passes through untouched.
 */
export async function mobileResponseFromSignIn(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const metadata = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (metadata?.mfaRequired === true) return NextResponse.json(metadata, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
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
}
