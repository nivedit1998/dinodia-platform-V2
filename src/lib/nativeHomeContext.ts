import type { Prisma } from '@prisma/client';

export class NativeAccessDenied extends Error {
  constructor(readonly code: 'MEMBERSHIP_REQUIRED' | 'HOME_UNAVAILABLE' | 'HUB_UNAVAILABLE') { super(code); }
}

export async function resolveNativeHomeContext(
  db: Prisma.TransactionClient,
  principal: { customerAccountId: string; homeId: string; membershipId?: string },
) {
  const account = await db.customerAccount.findFirst({ where: { id: principal.customerAccountId, status: 'ACTIVE' }, select: { id: true } });
  if (!account) throw new NativeAccessDenied('MEMBERSHIP_REQUIRED');
  const membership = await db.homeMembership.findFirst({
    where: {
      ...(principal.membershipId ? { id: principal.membershipId } : {}),
      customerAccountId: principal.customerAccountId,
      homeId: principal.homeId,
      status: 'ACTIVE',
    },
    select: {
      id: true, homeId: true, customerAccountId: true, role: true, status: true, accessRevision: true,
      home: { select: { id: true, lifecycle: true, installationStatus: true, authorityGeneration: true, managementRevision: true, activeHubInstallationId: true } },
      tenantAreaGrants: { where: { revokedAt: null }, select: { areaId: true, policyRevision: true } },
    },
  });
  if (!membership) throw new NativeAccessDenied('MEMBERSHIP_REQUIRED');
  if (membership.home.lifecycle !== 'ACTIVE' || membership.home.installationStatus !== 'COMPLETE' || membership.status !== 'ACTIVE') throw new NativeAccessDenied('HOME_UNAVAILABLE');
  const activeHub = membership.home.activeHubInstallationId
    ? await db.hubInstallation.findFirst({
      where: { id: membership.home.activeHubInstallationId, homeId: membership.homeId, lifecycleStatus: 'ACTIVE', state: { in: ['PROVISIONED', 'ACTIVE', 'MAINTENANCE', 'PAIRING'] } },
      select: { id: true, state: true, accessPolicyRevision: true, installationGeneration: true, cloudUrl: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, reservedHostname: true },
    })
    : null;
  if (!activeHub) throw new NativeAccessDenied('HUB_UNAVAILABLE');
  return Object.freeze({
    homeId: membership.homeId,
    customerAccountId: membership.customerAccountId,
    membershipId: membership.id,
    role: membership.role,
    accessRevision: membership.accessRevision,
    authorityGeneration: membership.home.authorityGeneration,
    managementRevision: membership.home.managementRevision,
    activeHubInstallationId: activeHub.id,
    hubAccessPolicyRevision: activeHub.accessPolicyRevision,
    installationGeneration: activeHub.installationGeneration,
    cloudUrl: activeHub.cloudUrl,
    cloudUrlVerifiedAt: activeHub.cloudUrlVerifiedAt,
    remoteVerificationAt: activeHub.remoteVerificationAt,
    reservedHostname: activeHub.reservedHostname,
    grantedAreaIds: Object.freeze(membership.role === 'TENANT' ? membership.tenantAreaGrants.map((grant) => grant.areaId) : []),
  });
}
