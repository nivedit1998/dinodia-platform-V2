import { NextResponse } from 'next/server';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { bindMobileAccessToken, buildMobileSessionReceipt } from './mobileCustomerSession';
import { validateMobileCustomerSessionReceipt } from './contracts/dinodiaV1';

function refreshTokenFromCookie(header: string | null): string | null {
  const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith('dinodia_customer_session='))?.slice('dinodia_customer_session='.length);
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

/** Adapt a successful cookie-session rotation for the explicit native mobile client. */
export async function mobileSessionMutationResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  const refreshToken = refreshTokenFromCookie(response.headers.get('set-cookie'));
  if (!body || typeof body.sessionId !== 'string' || !refreshToken) return response;
  const session = await prisma.customerSession.findUnique({ where: { id: body.sessionId }, select: { customerAccountId: true, trustedDeviceId: true } });
  if (!session) throw new Stage1AuthError(500, 'mobile_session_unavailable', 'The rotated mobile session could not be verified');
  const credentials = await bindMobileAccessToken(body.sessionId, refreshToken);
  const receipt = await buildMobileSessionReceipt({
    accountId: session.customerAccountId, sessionId: body.sessionId, trustedDeviceId: session.trustedDeviceId,
    accessToken: credentials.accessToken, refreshToken: credentials.refreshToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt, refreshTokenExpiresAt: credentials.refreshExpiresAt,
  });
  const extras = typeof body.offlineHubEnforcement === 'string' ? { offlineHubEnforcement: body.offlineHubEnforcement } : {};
  const result = { ...receipt, ...extras };
  if (!validateMobileCustomerSessionReceipt(result)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The mobile session receipt failed contract validation');
  return NextResponse.json(result, { status: response.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}
