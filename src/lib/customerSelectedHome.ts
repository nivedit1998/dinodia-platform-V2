import { prisma } from './prisma';
import { cookieToken, requireCustomer, requireCustomerAccountSession, Stage1AuthError } from './stage1Auth';
import { NativeAccessDenied, resolveNativeHomeContext } from './nativeHomeContext';

/**
 * Resolve an app-selected Home from current server-owned membership data.
 * X-Dinodia-Home-Id is only a selector; it never supplies role, membership,
 * area grants, hub identity or command scope.
 */
export async function requireCustomerSelectedHome(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  const hasMobileAccess = /^Bearer dno-customer-access-[A-Za-z0-9_-]{32,160}$/.test(authorization);
  const hasAccountCookie = Boolean(cookieToken(request, 'dinodia_customer_session'));
  const appToken = request.headers.get('x-dinodia-app-token');
  if (appToken) {
    if (hasMobileAccess || hasAccountCookie) throw new Stage1AuthError(400, 'customer_credential_ambiguous', 'Use one customer session credential per request');
    return requireCustomer(request);
  }

  const account = await requireCustomerAccountSession(request);
  const homeId = request.headers.get('x-dinodia-home-id')?.trim() ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(homeId)) {
    throw new Stage1AuthError(400, 'selected_home_required', 'Select an active Home before continuing');
  }
  let selected: Awaited<ReturnType<typeof resolveNativeHomeContext>>;
  try {
    selected = await resolveNativeHomeContext(prisma, { customerAccountId: account.id, homeId });
  } catch (error) {
    if (!(error instanceof NativeAccessDenied)) throw error;
    const status = error.code === 'HUB_UNAVAILABLE' ? 503 : error.code === 'HOME_UNAVAILABLE' ? 409 : 404;
    throw new Stage1AuthError(status, error.code.toLowerCase(), 'This Home is not available to the selected account');
  }
  const device = await prisma.trustedDevice.findUnique({ where: { id: account.trustedDeviceId }, select: { id: true, customerAccountId: true, publicKey: true, revokedAt: true, sessionVersion: true } });
  if (!device || device.customerAccountId !== account.id || device.revokedAt || device.sessionVersion !== account.trustedDeviceSessionVersion) {
    throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer phone is no longer trusted');
  }
  return {
    kind: 'customer' as const,
    id: account.id,
    membershipId: selected.membershipId,
    trustedDeviceId: account.trustedDeviceId,
    homeId: selected.homeId,
    hubInstallationId: selected.activeHubInstallationId,
    role: selected.role,
    areaIds: [...selected.grantedAreaIds],
    scopes: selected.role === 'TENANT' ? ['tenant:device-command'] : ['property:read'],
    policyRevision: Math.max(selected.accessRevision, selected.hubAccessPolicyRevision),
    sessionId: account.sessionId,
    tokenHash: account.credentialKind === 'access' ? account.accessTokenHash ?? '' : account.refreshTokenHash,
    credentialKind: account.credentialKind === 'access' ? 'account_access' as const : 'account_refresh' as const,
    tokenExpiresAt: account.credentialKind === 'access' ? account.accessTokenExpiresAt?.getTime() : account.expiresAt.getTime(),
    trustedDevicePublicKey: device.publicKey,
  };
}
