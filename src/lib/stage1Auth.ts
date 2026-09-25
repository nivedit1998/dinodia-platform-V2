import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from './prisma';
import { headerToken, parsePublicKeys, sha256, verifyStage1Token } from './stage1Crypto';

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
  const verified = verifyStage1Token(token, 'employee', keys('COMPANY_PORTAL_SESSION_PUBLIC_KEYS'));
  if (!verified) fail(new Stage1AuthError(401, 'employee_session_invalid', 'A valid Company Portal session is required'));
  const employee = await prisma.companyEmployeeAccount.findUnique({ where: { id: verified.id }, select: { id: true, role: true, status: true } });
  if (!employee || employee.status !== 'ACTIVE') fail(new Stage1AuthError(401, 'employee_revoked', 'The employee session is no longer active'));
  if (allowedRoles.length > 0 && !allowedRoles.includes(employee.role)) fail(new Stage1AuthError(403, 'employee_role_denied', 'This employee role is not allowed for the operation'));
  const session = await prisma.employeeSession.findUnique({ where: { id: verified.sessionId }, select: { id: true, employeeId: true, tokenHash: true, status: true, expiresAt: true, recentAuthenticatedAt: true } });
  if (!session || session.employeeId !== employee.id || session.tokenHash !== sha256(verified.sessionId) || session.status !== 'ACTIVE' || session.expiresAt <= new Date()) fail(new Stage1AuthError(401, 'employee_session_revoked', 'The employee session is no longer active'));
  if (requireRecent && Date.now() - session.recentAuthenticatedAt.getTime() > 5 * 60 * 1000) fail(new Stage1AuthError(401, 'recent_authentication_required', 'Recent Company Portal authentication is required'));
  return { kind: 'employee', id: employee.id, role: employee.role, sessionId: verified.sessionId, recentAuthenticatedAt: session.recentAuthenticatedAt.getTime(), tokenHash: sha256(verified.sessionId) };
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
  if (membership.role === 'TENANT' && verified.areaIds.some((areaId) => !currentAreaIds.has(areaId))) fail(new Stage1AuthError(401, 'area_policy_stale', 'The app session must refresh its current area permissions'));
  const hub = await prisma.hubInstallation.findUnique({ where: { id: verified.hubInstallationId }, select: { id: true, homeId: true, accessPolicyRevision: true } });
  const currentPolicyRevision = Math.max(membership.accessRevision, hub?.accessPolicyRevision ?? 0);
  if (!hub || hub.homeId !== verified.homeId || verified.policyRevision !== currentPolicyRevision) fail(new Stage1AuthError(401, 'policy_stale', 'The app session must refresh its home policy'));
  const trustedDevice = await prisma.trustedDevice.findUnique({ where: { id: verified.trustedDeviceId }, select: { id: true, customerAccountId: true, publicKey: true, revokedAt: true, sessionVersion: true } });
  const session = await prisma.customerSession.findUnique({ where: { id: verified.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, revokedAt: true, expiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true } });
  const account = await prisma.customerAccount.findUnique({ where: { id: verified.id }, select: { id: true, status: true, securityVersion: true } });
  if (!account || account.status !== 'ACTIVE' || session?.securityVersion !== account.securityVersion || !trustedDevice || trustedDevice.customerAccountId !== verified.id || trustedDevice.revokedAt || !session || session.customerAccountId !== verified.id || session.trustedDeviceId !== trustedDevice.id || session.trustedDeviceSessionVersion !== trustedDevice.sessionVersion || session.revokedAt || session.expiresAt <= new Date()) fail(new Stage1AuthError(401, 'customer_session_invalid', 'The app session is no longer active'));
  return { kind: 'customer', id: verified.id, membershipId: membership.id, trustedDeviceId: trustedDevice.id, trustedDevicePublicKey: trustedDevice.publicKey, homeId: membership.homeId, hubInstallationId: hub.id, role: membership.role, areaIds: verified.areaIds, scopes: verified.scopes, policyRevision: verified.policyRevision, sessionId: verified.sessionId, tokenHash: sha256(token) };
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
