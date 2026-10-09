import type { Prisma } from '@prisma/client';
import type { CustomerAccountSessionPrincipal } from '@/lib/stage1Auth';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';

/**
 * Re-check account-global customer authority after acquiring the same
 * account -> session -> trusted-device locks used by Stage 6 security owners.
 * Call inside a bounded SERIALIZABLE transaction before creating or changing
 * Alexa link authority. The caller's earlier HTTP authentication is only an
 * identity hint; this locked check is the mutation authorization.
 */
export async function lockAndValidateAlexaAccountAuthority(
  tx: Prisma.TransactionClient,
  actor: CustomerAccountSessionPrincipal,
  selectedHomeId?: string,
): Promise<void> {
  // Home-scoped authority changes use the existing property-management lock
  // order: Home -> account -> session -> trusted device.
  if (selectedHomeId) await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${selectedHomeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${actor.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${actor.sessionId}::uuid AND "customerAccountId" = ${actor.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${actor.trustedDeviceId}::uuid AND "customerAccountId" = ${actor.id}::uuid FOR UPDATE`;

  const [account, session, trusted] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: actor.id }, select: {
      status: true, emailVerifiedAt: true, securityVersion: true,
      mustChangePassword: true, usernameSelectionRequired: true,
    } }),
    tx.customerSession.findUnique({ where: { id: actor.sessionId }, select: {
      customerAccountId: true, trustedDeviceId: true, sessionFamilyId: true,
      refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true,
      securityVersion: true, trustedDeviceSessionVersion: true,
      revokedAt: true, expiresAt: true, absoluteExpiresAt: true,
    } }),
    tx.trustedDevice.findUnique({ where: { id: actor.trustedDeviceId }, select: {
      customerAccountId: true, revokedAt: true, sessionVersion: true,
    } }),
  ]);
  // Deliberately evaluate deadlines after all lock waits and authority reads.
  const now = new Date();
  const accessCredential = actor.credentialKind === 'access';
  const suppliedHash = accessCredential ? actor.accessTokenHash : actor.refreshTokenHash;
  const storedHash = accessCredential ? session?.accessTokenHash : session?.refreshTokenHash;
  const credentialDeadline = accessCredential ? session?.accessTokenExpiresAt : session?.expiresAt;
  if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt
    || account.securityVersion !== actor.securityVersion
    || account.mustChangePassword || account.usernameSelectionRequired
    || !session || session.customerAccountId !== actor.id || session.trustedDeviceId !== actor.trustedDeviceId
    || session.revokedAt || session.securityVersion !== account.securityVersion
    || session.trustedDeviceSessionVersion !== actor.trustedDeviceSessionVersion
    || session.expiresAt <= now || session.absoluteExpiresAt <= now
    || !suppliedHash || storedHash !== suppliedHash || !credentialDeadline || credentialDeadline <= now
    || (accessCredential && (!actor.accessTokenExpiresAt || actor.accessTokenExpiresAt <= now))) {
    throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active');
  }
  if (!trusted || trusted.customerAccountId !== actor.id || trusted.revokedAt
    || trusted.sessionVersion !== session.trustedDeviceSessionVersion) {
    throw new Stage1AuthError(401, 'trusted_device_revoked', 'The trusted installation is no longer active');
  }
  const policy = currentCustomerPolicy();
  if (!policy) throw new Stage1AuthError(503, 'customer_policy_unavailable', 'Customer access is unavailable until the current policy is configured');
  const accepted = await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
    customerAccountId: actor.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
  } }, select: { id: true } });
  if (!accepted) throw new Stage1AuthError(403, 'customer_policy_acceptance_required', 'Review and accept the current customer policy before continuing');

  const nextExpiry = new Date(Math.min(now.getTime() + 30 * 24 * 60 * 60 * 1000, session.absoluteExpiresAt.getTime()));
  const updatedSession = await tx.customerSession.updateMany({ where: {
    id: actor.sessionId,
    customerAccountId: actor.id, revokedAt: null, refreshTokenHash: session.refreshTokenHash,
    expiresAt: { gt: now }, absoluteExpiresAt: { gt: now },
  }, data: { lastUsedAt: now, expiresAt: nextExpiry } });
  if (updatedSession.count !== 1) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active');
  const updatedDevice = await tx.trustedDevice.updateMany({ where: {
    id: actor.trustedDeviceId, customerAccountId: actor.id, revokedAt: null,
    sessionVersion: actor.trustedDeviceSessionVersion,
  }, data: { lastUsedAt: now } });
  if (updatedDevice.count !== 1) throw new Stage1AuthError(401, 'trusted_device_revoked', 'The trusted installation is no longer active');
}
