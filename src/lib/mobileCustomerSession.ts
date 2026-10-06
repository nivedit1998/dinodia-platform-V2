import crypto from 'node:crypto';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { randomSecret, sha256 } from './stage1Crypto';
import { currentCustomerPolicy } from './customerPolicy';

export const MOBILE_ACCESS_LIFETIME_MS = 15 * 60 * 1000;
export const MOBILE_IDLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const MOBILE_ABSOLUTE_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

export function newMobileAccessToken(): string {
  return `dno-customer-access-${randomSecret(32)}`;
}

export function newMobileRefreshToken(): string {
  return `dno-customer-session-${randomSecret(32)}`;
}

/** Bind a random, short-lived app bearer to an existing account session row. */
export async function bindMobileAccessToken(sessionId: string, refreshToken: string, accessToken = newMobileAccessToken()) {
  const accessTokenHash = sha256(accessToken);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
    const now = new Date();
    const session = await tx.customerSession.findUnique({ where: { id: sessionId }, select: { id: true, refreshTokenHash: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } });
    if (!session || session.refreshTokenHash !== sha256(refreshToken) || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now) {
      throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active');
    }
    const accessTokenExpiresAt = new Date(Math.min(now.getTime() + MOBILE_ACCESS_LIFETIME_MS, session.expiresAt.getTime(), session.absoluteExpiresAt.getTime()));
    const updated = await tx.customerSession.updateMany({ where: { id: session.id, refreshTokenHash: sha256(refreshToken), revokedAt: null }, data: { accessTokenHash, accessTokenExpiresAt } });
    if (updated.count !== 1) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active');
    return { accessTokenExpiresAt, refreshExpiresAt: session.expiresAt, absoluteExpiresAt: session.absoluteExpiresAt };
  }, { isolationLevel: 'Serializable' });
  return { accessToken, refreshToken, ...result };
}

export async function mobileAccountSummary(accountId: string) {
  const [account, memberships] = await Promise.all([
    prisma.customerAccount.findUnique({ where: { id: accountId }, select: { id: true, displayName: true, username: true, email: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true, status: true } }),
    prisma.homeMembership.findMany({
      where: { customerAccountId: accountId, status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, homeId: true, role: true, accessRevision: true, home: { select: { postcode: true } }, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true, homeId: true } } },
    }),
  ]);
  if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account is no longer active');
  const policy = currentCustomerPolicy();
  const policyAcceptance = policy ? await prisma.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: accountId, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } }, select: { id: true } }) : null;
  const homes = new Set<string>(); const membershipIds = new Set<string>();
  const activeMemberships = memberships.map((membership) => {
    if (homes.has(membership.homeId) || membershipIds.has(membership.id)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'Account memberships are inconsistent');
    homes.add(membership.homeId); membershipIds.add(membership.id);
    return { accountId, homeId: membership.homeId, homeMembershipId: membership.id, role: membership.role, status: 'active' as const,
      areaIds: membership.role === 'TENANT' ? membership.tenantAreaGrants.filter((grant) => grant.homeId === membership.homeId).map((grant) => grant.areaId) : [],
      revision: membership.accessRevision, postcode: membership.home.postcode };
  });
  return {
    user: { accountId: account.id, displayName: account.displayName, username: account.username, email: account.email, emailVerifiedAt: account.emailVerifiedAt!.toISOString() },
    memberships: activeMemberships,
    nextAction: account.mustChangePassword ? 'CHANGE_PASSWORD' : account.usernameSelectionRequired ? 'CHOOSE_USERNAME' : !policy ? 'POLICY_UNAVAILABLE' : !policyAcceptance ? 'ACCEPT_POLICY' : activeMemberships.length === 0 ? 'PENDING_RELATIONSHIPS' : 'SELECT_HOME',
  };
}

export async function buildMobileSessionReceipt(input: {
  accountId: string; sessionId: string; trustedDeviceId: string; accessToken: string; refreshToken: string;
  accessTokenExpiresAt: Date; refreshTokenExpiresAt: Date;
}) {
  const summary = await mobileAccountSummary(input.accountId);
  return {
    schemaVersion: 'dinodia.v1', ok: true as const,
    accountId: input.accountId, sessionId: input.sessionId, trustedDeviceId: input.trustedDeviceId,
    accessToken: input.accessToken, refreshToken: input.refreshToken,
    accessTokenExpiresAt: input.accessTokenExpiresAt.toISOString(), refreshTokenExpiresAt: input.refreshTokenExpiresAt.toISOString(),
    user: summary.user, memberships: summary.memberships, nextAction: summary.nextAction,
  };
}

export async function rotateMobileRefreshToken(rawRefreshToken: string) {
  const tokenHash = sha256(rawRefreshToken);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "refreshTokenHash" = ${tokenHash} FOR UPDATE`;
    const prior = await tx.customerSession.findUnique({ where: { refreshTokenHash: tokenHash }, select: {
      id: true, customerAccountId: true, trustedDeviceId: true, sessionFamilyId: true, refreshTokenHash: true,
      securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, revokeReason: true, expiresAt: true, absoluteExpiresAt: true,
    } });
    const now = new Date();
    if (!prior) return { error: 'invalid' as const };
    if (prior.revokedAt) {
      if (prior.revokeReason === 'refresh_token_rotated') {
        await tx.customerSession.updateMany({ where: { sessionFamilyId: prior.sessionFamilyId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'refresh_token_reuse', accessTokenHash: null, accessTokenExpiresAt: null } });
        return { error: 'reused' as const };
      }
      return { error: 'invalid' as const };
    }
    if (prior.expiresAt <= now || prior.absoluteExpiresAt <= now) return { error: 'expired' as const };
    const [account, device] = await Promise.all([
      tx.customerAccount.findUnique({ where: { id: prior.customerAccountId }, select: { id: true, status: true, securityVersion: true, mustChangePassword: true } }),
      tx.trustedDevice.findUnique({ where: { id: prior.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
    ]);
    if (!account || account.status !== 'ACTIVE' || account.securityVersion !== prior.securityVersion || !device || device.customerAccountId !== account.id || device.revokedAt || device.sessionVersion !== prior.trustedDeviceSessionVersion) return { error: 'invalid' as const };
    const refreshToken = newMobileRefreshToken();
    const accessToken = newMobileAccessToken();
    const expiresAt = new Date(Math.min(now.getTime() + MOBILE_IDLE_LIFETIME_MS, prior.absoluteExpiresAt.getTime()));
    const accessTokenExpiresAt = new Date(Math.min(now.getTime() + MOBILE_ACCESS_LIFETIME_MS, expiresAt.getTime()));
    await tx.customerSession.update({ where: { id: prior.id }, data: { revokedAt: now, revokeReason: 'refresh_token_rotated', lastUsedAt: now, accessTokenHash: null, accessTokenExpiresAt: null } });
    const next = await tx.customerSession.create({ data: {
      customerAccountId: account.id, trustedDeviceId: device.id, sessionFamilyId: prior.sessionFamilyId,
      refreshTokenHash: sha256(refreshToken), accessTokenHash: sha256(accessToken), accessTokenExpiresAt,
      securityVersion: account.securityVersion, trustedDeviceSessionVersion: device.sessionVersion,
      issuedAt: now, lastUsedAt: now, expiresAt, absoluteExpiresAt: prior.absoluteExpiresAt,
    }, select: { id: true, expiresAt: true, absoluteExpiresAt: true } });
    await tx.trustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: now } });
    return { accountId: account.id, sessionId: next.id, trustedDeviceId: device.id, expiresAt: next.expiresAt, absoluteExpiresAt: next.absoluteExpiresAt, accessToken, refreshToken, accessTokenExpiresAt, mustChangePassword: account.mustChangePassword };
  }, { isolationLevel: 'Serializable' });
  return result;
}

export function mobileTokenFormatIsValid(token: unknown): token is string {
  return typeof token === 'string' && /^dno-customer-session-[A-Za-z0-9_-]{32,160}$/.test(token);
}

export function mobileAccessTokenFormatIsValid(token: unknown): token is string {
  return typeof token === 'string' && /^dno-customer-access-[A-Za-z0-9_-]{32,160}$/.test(token);
}

export function mobileAccessHash(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }
