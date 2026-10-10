import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from './prisma';
import { headerToken, parsePublicKeys, sha256, verifyStage1Token } from './stage1Crypto';
import { validateMembership } from './contracts/dinodiaV1';
import { EMPLOYEE_SESSION_SECONDS, stage1NowMs } from './stage1SessionPolicy';
import { currentCustomerPolicy } from './customerPolicyConfig';

export class Stage1AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type EmployeePrincipal = {
  kind: 'employee';
  id: string;
  role: 'CXO' | 'SENIOR_OPERATIONS_MANAGER' | 'INSTALLER' | 'SENIOR_CUSTOMER_SUPPORT';
  sessionId: string;
  recentAuthenticatedAt: number;
  tokenHash: string;
  expiresAt: number;
};

export type CustomerPrincipal = {
  kind: 'customer';
  id: string;
  membershipId: string;
  trustedDeviceId: string;
  homeId: string;
  hubInstallationId: string;
  role: 'OWNER' | 'PROPERTY_MANAGER' | 'TENANT';
  areaIds: string[];
  scopes: string[];
  policyRevision: number;
  sessionId: string;
  tokenHash: string;
  trustedDevicePublicKey: string;
  credentialKind?: 'legacy_app' | 'account_access' | 'account_refresh';
  tokenExpiresAt?: number;
};

export type CustomerAccountSessionPrincipal = {
  kind: 'customer_account';
  id: string;
  sessionId: string;
  sessionFamilyId: string;
  trustedDeviceId: string;
  email: string;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
  usernameSelectionRequired: boolean;
  securityVersion: number;
  trustedDeviceSessionVersion: number;
  credentialKind: 'access'|'refresh';
  accessTokenHash: string|null;
  accessTokenExpiresAt: Date|null;
  refreshTokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

function keys(name: string): crypto.KeyObject[] {
  return parsePublicKeys(process.env[name]);
}

function fail(error: Stage1AuthError): never {
  throw error;
}

export async function requireEmployee(request: Request, allowedRoles: EmployeePrincipal['role'][] = []): Promise<EmployeePrincipal> {
  const token = headerToken(request, 'x-dinodia-employee-session') || cookieToken(request, 'dinodia_employee_session');
  return requireEmployeeToken(token, allowedRoles, false);
}

export async function requireEmployeeRecentAuth(request: Request, allowedRoles: EmployeePrincipal['role'][] = []): Promise<EmployeePrincipal> {
  const token = headerToken(request, 'x-dinodia-employee-session') || cookieToken(request, 'dinodia_employee_session');
  return requireEmployeeToken(token, allowedRoles, true);
}

export async function requireEmployeeToken(token: string, allowedRoles: EmployeePrincipal['role'][] = [], requireRecent = false): Promise<EmployeePrincipal> {
  const verified = verifyStage1Token(token, 'employee', keys('COMPANY_PORTAL_SESSION_PUBLIC_KEYS'), stage1NowMs(), EMPLOYEE_SESSION_SECONDS);
  if (!verified) fail(new Stage1AuthError(401, 'employee_session_invalid', 'A valid Company Portal session is required'));
  const lifetimeSeconds = verified.expiresAt - verified.issuedAt;
  if (lifetimeSeconds > EMPLOYEE_SESSION_SECONDS) fail(new Stage1AuthError(401, 'employee_session_invalid', 'The employee session exceeds the current absolute lifetime'));
  const employee = await prisma.companyEmployeeAccount.findUnique({ where: { id: verified.id }, select: { id: true, role: true, status: true } });
  if (!employee || employee.status !== 'ACTIVE') fail(new Stage1AuthError(401, 'employee_revoked', 'The employee session is no longer active'));
  if (allowedRoles.length > 0 && !allowedRoles.includes(employee.role)) fail(new Stage1AuthError(403, 'employee_role_denied', 'This employee role is not allowed for the operation'));
  const session = await prisma.employeeSession.findUnique({ where: { id: verified.sessionId }, select: { id: true, employeeId: true, tokenHash: true, status: true, createdAt: true, expiresAt: true, recentAuthenticatedAt: true } });
  const tokenDeadline = verified.expiresAt * 1000;
  const dbDeadline = session?.expiresAt.getTime() ?? 0;
  if (!session || session.employeeId !== employee.id || session.tokenHash !== sha256(verified.sessionId) || session.status !== 'ACTIVE' || dbDeadline <= stage1NowMs() || dbDeadline - session.createdAt.getTime() > EMPLOYEE_SESSION_SECONDS * 1000 || tokenDeadline > dbDeadline || dbDeadline - tokenDeadline >= 1000) fail(new Stage1AuthError(401, 'employee_session_revoked', 'The employee session is no longer active'));
  if (requireRecent && stage1NowMs() - session.recentAuthenticatedAt.getTime() >= 5 * 60 * 1000) fail(new Stage1AuthError(401, 'recent_authentication_required', 'Recent Company Portal authentication is required'));
  return { kind: 'employee', id: employee.id, role: employee.role, sessionId: verified.sessionId, recentAuthenticatedAt: session.recentAuthenticatedAt.getTime(), tokenHash: sha256(verified.sessionId), expiresAt: session.expiresAt.getTime() };
}

export async function requireCustomer(request: Request): Promise<CustomerPrincipal> {
  const token = headerToken(request, 'x-dinodia-app-token');
  const verified = verifyStage1Token(token, 'customer', keys('DINODIA_APP_PUBLIC_KEYS'));
  if (!verified?.membershipId || !verified.homeId || !verified.hubInstallationId || !verified.trustedDeviceId || !verified.role || verified.audience !== `dinodia-hub:${verified.hubInstallationId}`) fail(new Stage1AuthError(401, 'app_token_invalid', 'A valid Dinodia app session is required'));
  const membership = await prisma.homeMembership.findUnique({ where: { id: verified.membershipId }, select: { id: true, customerAccountId: true, homeId: true, role: true, status: true, accessRevision: true } });
  if (!membership || membership.customerAccountId !== verified.id || membership.homeId !== verified.homeId || membership.status !== 'ACTIVE' || membership.role !== verified.role) fail(new Stage1AuthError(401, 'membership_invalid', 'The selected home membership is no longer active'));
  const currentGrants = membership.role === 'TENANT'
    ? await prisma.tenantAreaGrant.findMany({ where: { membershipId: membership.id, homeId: membership.homeId, revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } })
    : [];
  const currentAreaIds = new Set(currentGrants.map((grant) => grant.areaId));
  if (membership.role === 'TENANT' && (verified.areaIds.some((areaId) => !currentAreaIds.has(areaId)) || new Set(verified.areaIds).size !== verified.areaIds.length || currentAreaIds.size !== verified.areaIds.length)) fail(new Stage1AuthError(401, 'area_policy_stale', 'The app session must refresh its current area permissions'));
  const currentMembershipAreas = membership.role === 'TENANT'
    ? [...currentAreaIds]
    : verified.areaIds;
  if (!validateMembership({ accountId: membership.customerAccountId, homeId: membership.homeId, homeMembershipId: membership.id, role: membership.role, status: 'active', areaIds: currentMembershipAreas, revision: membership.accessRevision })) fail(new Stage1AuthError(401, 'membership_invalid', 'The selected home membership does not satisfy the current Native V2 contract'));
  const hub = await prisma.hubInstallation.findUnique({ where: { id: verified.hubInstallationId }, select: { id: true, homeId: true, accessPolicyRevision: true } });
  const currentPolicyRevision = Math.max(membership.accessRevision, hub?.accessPolicyRevision ?? 0);
  if (!hub || hub.homeId !== verified.homeId || verified.policyRevision !== currentPolicyRevision) fail(new Stage1AuthError(401, 'policy_stale', 'The app session must refresh its home policy'));
  const trustedDevice = await prisma.trustedDevice.findUnique({ where: { id: verified.trustedDeviceId }, select: { id: true, customerAccountId: true, publicKey: true, revokedAt: true, sessionVersion: true } });
  const session = await prisma.customerSession.findUnique({ where: { id: verified.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true } });
  const account = await prisma.customerAccount.findUnique({ where: { id: verified.id }, select: { id: true, status: true, securityVersion: true } });
  const sessionNow = new Date();
  if (!account || account.status !== 'ACTIVE' || session?.securityVersion !== account.securityVersion || !trustedDevice || trustedDevice.customerAccountId !== verified.id || trustedDevice.revokedAt || !session || session.customerAccountId !== verified.id || session.trustedDeviceId !== trustedDevice.id || session.trustedDeviceSessionVersion !== trustedDevice.sessionVersion || session.revokedAt || session.expiresAt <= sessionNow || session.absoluteExpiresAt <= sessionNow) fail(new Stage1AuthError(401, 'customer_session_invalid', 'The app session is no longer active'));
  await prisma.customerSession.updateMany({
    where: { id: session.id, revokedAt: null, expiresAt: { gt: sessionNow }, absoluteExpiresAt: { gt: sessionNow } },
    data: { lastUsedAt: sessionNow, expiresAt: new Date(Math.min(sessionNow.getTime() + 30 * 24 * 60 * 60 * 1000, session.absoluteExpiresAt.getTime())) },
  });
  return { kind: 'customer', id: verified.id, membershipId: membership.id, trustedDeviceId: trustedDevice.id, trustedDevicePublicKey: trustedDevice.publicKey, homeId: membership.homeId, hubInstallationId: hub.id, role: membership.role, areaIds: verified.areaIds, scopes: verified.scopes, policyRevision: verified.policyRevision, sessionId: verified.sessionId, tokenHash: sha256(token), credentialKind: 'legacy_app', tokenExpiresAt: verified.expiresAt * 1000 };
}

/** Account-global cookie authority, deliberately independent of any Home or hub bearer. */
export async function requireCustomerAccountSession(request: Request, options: { allowPasswordChangeOnly?: boolean; allowPolicyGate?: boolean; allowMandatoryPasswordChange?: boolean; allowUsernameSetup?: boolean } = {}): Promise<CustomerAccountSessionPrincipal> {
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = /^Bearer (dno-customer-access-[A-Za-z0-9_-]{32,160})$/.exec(authorization)?.[1] ?? '';
  const cookie = cookieToken(request, 'dinodia_customer_session');
  if (bearer && cookie) fail(new Stage1AuthError(400, 'customer_credential_ambiguous', 'Use one customer session credential per request'));
  const token = bearer || cookie;
  if (!token) fail(new Stage1AuthError(401, 'customer_session_required', 'A customer account session is required'));
  const presentedHash = sha256(token);
  const now = new Date();
  const session = await prisma.customerSession.findFirst({ where: bearer
    ? { accessTokenHash: presentedHash }
    : { refreshTokenHash: presentedHash }, select: {
    id: true, customerAccountId: true, trustedDeviceId: true, sessionFamilyId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true,
    securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true,
    customerAccount: { select: { id: true, email: true, emailVerifiedAt: true, status: true, securityVersion: true, mustChangePassword: true, usernameSelectionRequired: true } },
    trustedDevice: { select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } },
  } });
  if (bearer && session && session.accessTokenHash === presentedHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt <= now) {
    fail(new Stage1AuthError(401, 'customer_access_token_expired', 'Refresh the customer app session before retrying'));
  }
  if (!session || (bearer && (session.accessTokenHash !== presentedHash || !session.accessTokenExpiresAt))
    || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
    || session.customerAccount.status !== 'ACTIVE' || session.customerAccount.id !== session.customerAccountId
    || session.customerAccount.securityVersion !== session.securityVersion
    || session.trustedDevice.id !== session.trustedDeviceId || session.trustedDevice.customerAccountId !== session.customerAccountId
    || session.trustedDevice.revokedAt || session.trustedDevice.sessionVersion !== session.trustedDeviceSessionVersion) {
    fail(new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active'));
  }
  const mandatoryPasswordGate = Boolean(session.customerAccount.mustChangePassword && options.allowPasswordChangeOnly && options.allowMandatoryPasswordChange);
  if (session.customerAccount.mustChangePassword && !options.allowPasswordChangeOnly) {
    fail(new Stage1AuthError(403, 'customer_password_change_required', 'Change your password before continuing'));
  }
  if (session.customerAccount.usernameSelectionRequired && !options.allowUsernameSetup && !mandatoryPasswordGate) {
    fail(new Stage1AuthError(403, 'customer_username_selection_required', 'Choose your username before continuing'));
  }
  if (!options.allowPolicyGate && !mandatoryPasswordGate) {
    const policy = currentCustomerPolicy();
    if (!policy) fail(new Stage1AuthError(503, 'customer_policy_unavailable', 'Customer access is unavailable until the current policy is configured'));
    const acceptance = await prisma.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
      customerAccountId: session.customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
    } }, select: { id: true } });
    if (!acceptance) fail(new Stage1AuthError(403, 'customer_policy_acceptance_required', 'Review and accept the current customer policy before continuing'));
  }
  const expiresAt = new Date(Math.min(now.getTime() + 30 * 24 * 60 * 60 * 1000, session.absoluteExpiresAt.getTime()));
  await prisma.customerSession.updateMany({ where: { id: session.id, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } }, data: { lastUsedAt: now, expiresAt } });
  await prisma.trustedDevice.update({ where: { id: session.trustedDeviceId }, data: { lastUsedAt: now } });
  return {
    kind: 'customer_account', id: session.customerAccountId, sessionId: session.id, sessionFamilyId: session.sessionFamilyId,
    trustedDeviceId: session.trustedDeviceId, email: session.customerAccount.email,
    emailVerifiedAt: session.customerAccount.emailVerifiedAt, mustChangePassword: session.customerAccount.mustChangePassword,
    usernameSelectionRequired: session.customerAccount.usernameSelectionRequired,
    securityVersion: session.securityVersion, trustedDeviceSessionVersion: session.trustedDeviceSessionVersion,
    credentialKind: bearer ? 'access' : 'refresh', accessTokenHash: session.accessTokenHash,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenHash: session.refreshTokenHash, expiresAt, absoluteExpiresAt: session.absoluteExpiresAt,
  };
}

export function cookieToken(request: Request, name: string): string {
  const value = request.headers.get('cookie') ?? '';
  const prefix = `${name}=`;
  const item = value.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}

export function assertCustomerCanCommand(principal: CustomerPrincipal): void {
  if (principal.role !== 'TENANT' || !principal.scopes.includes('tenant:device-command')) fail(new Stage1AuthError(403, 'device_command_denied', 'Only an authorised tenant can issue household device commands'));
}

export function assertEmployeeCanManageCredential(principal: EmployeePrincipal): void {
  if (principal.role !== 'CXO' && principal.role !== 'SENIOR_OPERATIONS_MANAGER') fail(new Stage1AuthError(403, 'credential_management_denied', 'Only CXO or Senior Operations Manager can manage hub credentials'));
}

export function authErrorResponse(error: unknown): NextResponse {
  if (error instanceof Stage1AuthError) return NextResponse.json({ ok: false, error: error.message, errorCode: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  // Do not emit request/error objects: they can contain request fields or
  // credential material. The client receives the bounded error code above;
  // operational detail belongs in the platform's redacted request logger.
  console.error('[stage1] request failed');
  return NextResponse.json({ ok: false, error: 'Request could not be completed', errorCode: 'internal_error' }, { status: 500, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}

/**
 * Record a failed authentication attempt without retaining the submitted
 * identifier or any credential material.  This is deliberately best-effort:
 * an audit-store outage must not turn a failed login into a successful one or
 * expose database details to the caller.
 */
export async function recordFailedAuthentication(action: string, identifier: string): Promise<void> {
  try {
    const now = new Date();
    await prisma.auditEvent.create({
      data: {
        actorType: 'SYSTEM',
        category: 'SECURITY',
        action,
        targetType: 'AuthenticationAttempt',
        metadata: { identifierHash: sha256(identifier.slice(0, 320)), outcome: 'denied' },
        occurredAt: now,
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      },
    });
  } catch {
    // Do not emit the identifier, credentials or database error to logs.
  }
}

export function auditMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...value };
  for (const key of Object.keys(redacted)) if (/token|secret|password|code|private|credential|cipher|signature/i.test(key)) redacted[key] = '[redacted]';
  return redacted;
}
