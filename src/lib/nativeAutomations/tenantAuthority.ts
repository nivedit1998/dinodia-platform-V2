import type { Prisma } from '@prisma/client';
import type { CustomerPrincipal } from '@/lib/stage1Auth';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';

/**
 * Revalidate the selected tenant credential after the Home automation lock.
 * Locking the mutable authority rows makes a concurrent revocation serialize
 * before or after this operation; under SERIALIZABLE, a row changed since the
 * transaction snapshot forces the caller's bounded retry to use a fresh one.
 */
export async function lockAndValidateTenantAutomationAuthority(
  tx: Prisma.TransactionClient,
  actor: CustomerPrincipal,
): Promise<void> {
  if (actor.credentialKind !== 'account_access' && actor.credentialKind !== 'account_refresh') {
    throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is not valid for automation changes');
  }

  // Match the Home-scoped property-management ordering first, then the common
  // account/session/trusted-device sequence used by Stage 6 security owners.
  await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${actor.homeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${actor.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${actor.sessionId}::uuid AND "customerAccountId" = ${actor.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${actor.trustedDeviceId}::uuid AND "customerAccountId" = ${actor.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${actor.membershipId}::uuid AND "customerAccountId" = ${actor.id}::uuid AND "homeId" = ${actor.homeId}::uuid FOR UPDATE`;
  // Area grants are independently mutable rows. Lock the complete bounded set
  // in stable order so a concurrent revoke cannot remain visible only in this
  // SERIALIZABLE transaction's pre-wait snapshot.
  await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${actor.membershipId}::uuid AND "homeId" = ${actor.homeId}::uuid ORDER BY "areaId" FOR UPDATE`;

  const [account, session, trusted, membership, home, policy] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: actor.id }, select: { status: true, securityVersion: true } }),
    tx.customerSession.findUnique({ where: { id: actor.sessionId }, select: {
      customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true,
      accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true,
      revokedAt: true, expiresAt: true, absoluteExpiresAt: true,
    } }),
    tx.trustedDevice.findUnique({ where: { id: actor.trustedDeviceId }, select: {
      customerAccountId: true, publicKey: true, revokedAt: true, sessionVersion: true,
    } }),
    tx.homeMembership.findFirst({ where: {
      id: actor.membershipId, customerAccountId: actor.id, homeId: actor.homeId,
      role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' },
    }, select: { id: true, accessRevision: true, tenantAreaGrants: {
      where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true },
    } } }),
    tx.home.findFirst({ where: { id: actor.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: {
      id: true, activeHubInstallationId: true, managementRevision: true,
    } }),
    Promise.resolve(currentCustomerPolicy()),
  ]);

  const currentCredentialHash = actor.credentialKind === 'account_access'
    ? session?.accessTokenHash
    : session?.refreshTokenHash;
  const credentialDeadline = actor.credentialKind === 'account_access'
    ? session?.accessTokenExpiresAt
    : session?.expiresAt;
  const selectedAreas = new Set(actor.areaIds);
  const currentAreas = new Set(membership?.tenantAreaGrants.map((grant) => grant.areaId) ?? []);
  const policyAccepted = policy ? await tx.policyAcceptance.findUnique({ where: {
    customerAccountId_policyKind_policyVersion: {
      customerAccountId: actor.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
    },
  }, select: { id: true } }) : null;
  if (home?.activeHubInstallationId) {
    await tx.$queryRaw`SELECT "id" FROM "HubInstallation" WHERE "id" = ${home.activeHubInstallationId}::uuid AND "homeId" = ${actor.homeId}::uuid FOR UPDATE`;
  }
  const hub = home?.activeHubInstallationId === actor.hubInstallationId ? await tx.hubInstallation.findFirst({ where: {
    id: actor.hubInstallationId, homeId: actor.homeId, lifecycleStatus: 'ACTIVE',
  }, select: { accessPolicyRevision: true } }) : null;
  // Deadline evaluation deliberately follows the final Hub lock and authority
  // reads. A wait there must not inherit a pre-wait timestamp.
  const now = new Date();
  const currentPolicyRevision = membership && hub ? Math.max(membership.accessRevision, hub.accessPolicyRevision) : -1;

  if (!account || account.status !== 'ACTIVE' || !session
    || session.customerAccountId !== actor.id || session.trustedDeviceId !== actor.trustedDeviceId
    || session.revokedAt || session.securityVersion !== account.securityVersion
    || session.trustedDeviceSessionVersion !== trusted?.sessionVersion
    || session.expiresAt <= now || session.absoluteExpiresAt <= now
    || !credentialDeadline || credentialDeadline <= now || currentCredentialHash !== actor.tokenHash
    || (actor.credentialKind === 'account_access' && (!actor.tokenExpiresAt || actor.tokenExpiresAt <= now.getTime()))
    || !trusted || trusted.customerAccountId !== actor.id || trusted.revokedAt
    || trusted.publicKey !== actor.trustedDevicePublicKey
    || !membership || home?.activeHubInstallationId !== actor.hubInstallationId || !hub || !policy || !policyAccepted
    || currentPolicyRevision !== actor.policyRevision
    || selectedAreas.size !== currentAreas.size || [...selectedAreas].some((areaId) => !currentAreas.has(areaId))) {
    throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer session or selected Home authority is no longer current');
  }
}
