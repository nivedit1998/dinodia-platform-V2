import type { Prisma } from '@prisma/client';

type PolicyConfiguration = {
  revision: number;
  memberships?: unknown;
  devicePolicies?: unknown;
};

function record(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue> : null;
}

/**
 * Completes only tenant-removal tombstones proven by the current signed Hub
 * configuration acknowledgement. The Hub reports an applied revision only
 * after its local policy and any exact tenant-device removal have succeeded.
 */
export async function acknowledgeAppliedTenantPolicy(db: Prisma.TransactionClient, input: {
  homeId: string;
  hubInstallationId: string;
  homeManagementRevision: number;
  acknowledgedCloudRevision: number;
  configuration: PolicyConfiguration;
  streamId: string;
  fromSequence: number;
  toSequence: number;
  bodyHash: string;
  now: Date;
}) {
  const revision = Number(input.configuration.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0
    || revision !== input.acknowledgedCloudRevision
    || !Array.isArray(input.configuration.memberships)
    || !Array.isArray(input.configuration.devicePolicies)) return { delivered: 0 };

  const membershipRows = input.configuration.memberships
    .map((item) => record(item as Prisma.JsonValue))
    .filter((item): item is Record<string, Prisma.JsonValue> => Boolean(item))
    .filter((item) => typeof item.id === 'string' && Array.isArray(item.areaIds));
  const memberships = new Map(membershipRows.map((membership) => [
    String(membership.id), {
      id: String(membership.id),
      areaIds: (membership.areaIds as Prisma.JsonArray).filter((areaId): areaId is string => typeof areaId === 'string'),
      accessRevision: Number(membership.accessRevision),
    },
  ]));
  const devicePolicies = new Set(input.configuration.devicePolicies
    .map((item) => record(item as Prisma.JsonValue))
    .filter((item): item is Record<string, Prisma.JsonValue> => Boolean(item))
    .map((item) => item.osDeviceId).filter((osDeviceId): osDeviceId is string => typeof osDeviceId === 'string'));
  const pending = await db.nativeDomainOutbox.findMany({
    where: {
      homeId: input.homeId, hubInstallationId: input.hubInstallationId, state: 'PENDING',
      eventType: { in: ['TENANT_MEMBERSHIP_REVOKED', 'TENANT_DEVICE_DECOMMISSION'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200,
    select: { id: true, aggregateType: true, aggregateId: true, eventType: true, idempotencyKey: true, payload: true },
  });
  const membershipIds = [...new Set(pending.map((event) => record(event.payload)?.membershipId)
    .filter((membershipId): membershipId is string => typeof membershipId === 'string'))];
  const [membershipRowsCurrent, activeAreaGrants, activeOfflineAuthorisations] = membershipIds.length ? await Promise.all([
    db.homeMembership.findMany({ where: { id: { in: membershipIds }, homeId: input.homeId, role: 'TENANT' },
      select: { id: true, status: true, accessRevision: true } }),
    db.tenantAreaGrant.findMany({ where: { membershipId: { in: membershipIds }, homeId: input.homeId, revokedAt: null },
      select: { membershipId: true } }),
    db.offlineMembershipAuthorisation.findMany({ where: { membershipId: { in: membershipIds }, homeId: input.homeId, revokedAt: null },
      select: { membershipId: true } }),
  ]) : [[], [], []];
  const currentMemberships = new Map(membershipRowsCurrent.map((membership) => [membership.id, membership]));
  const membershipsWithActiveGrants = new Set(activeAreaGrants.map((grant) => grant.membershipId));
  const membershipsWithOfflineAuthority = new Set(activeOfflineAuthorisations.map((grant) => grant.membershipId));
  const noLiveMembershipAuthority = (membershipId: string) =>
    !membershipsWithActiveGrants.has(membershipId) && !membershipsWithOfflineAuthority.has(membershipId);

  let delivered = 0;
  for (const event of pending) {
    const payload = record(event.payload);
    const membershipId = typeof payload?.membershipId === 'string' ? payload.membershipId : '';
    const policyRevision = Number(payload?.policyRevision);
    if (!membershipId || !Number.isSafeInteger(policyRevision) || policyRevision < 1) continue;

    const membership = currentMemberships.get(membershipId);
    const configuredMembership = memberships.get(membershipId);

    if (event.eventType === 'TENANT_MEMBERSHIP_REVOKED') {
      const managementRevision = Number(payload?.managementRevision);
      const expectedKeys = [
        `tenant-membership-removal:${membershipId}:${policyRevision}`,
        `homeowner-tenant-removal:${membershipId}:${policyRevision}`,
      ];
      if (event.aggregateType !== 'HomeMembership' || event.aggregateId !== membershipId
        || payload?.operation !== 'REMOVE_TENANT_MEMBERSHIP'
        || !expectedKeys.includes(event.idempotencyKey)
        || (membership ? membership.status !== 'REMOVED' || membership.accessRevision < policyRevision : !noLiveMembershipAuthority(membershipId))
        || !Number.isSafeInteger(managementRevision)
        || managementRevision < 1 || input.homeManagementRevision < managementRevision
        || configuredMembership) continue;
    } else {
      const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : '';
      const osDeviceId = typeof payload?.osDeviceId === 'string' ? payload.osDeviceId : '';
      const managementRevision = Number(payload?.managementRevision);
      const areaIds = Array.isArray(payload?.areaIds)
        ? payload.areaIds.filter((areaId): areaId is string => typeof areaId === 'string') : [];
      const deviceStillExists = await db.nativeDevice.findFirst({ where: {
        id: event.aggregateId, homeId: input.homeId, hubInstallationId: input.hubInstallationId,
      }, select: { id: true } });
      const lostAreasStillGranted = configuredMembership && areaIds.some((areaId) => configuredMembership.areaIds.includes(areaId));
      const expectedKeys = [
        `tenant-membership-removal:${membershipId}:${policyRevision}:device:${event.aggregateId}`,
        `homeowner-tenant-removal:${membershipId}:${policyRevision}:device:${event.aggregateId}`,
        `tenant-area-revocation:${managementRevision}:${event.aggregateId}`,
      ];
      if (event.aggregateType !== 'NativeDevice' || !deviceId || deviceId !== event.aggregateId
        || !osDeviceId || devicePolicies.has(osDeviceId)
        || payload?.operation !== 'REMOVE_TENANT_DEVICE' || !expectedKeys.includes(event.idempotencyKey)
        || !Number.isSafeInteger(managementRevision)
        || managementRevision < 1 || input.homeManagementRevision < managementRevision
        || (membership?.status === 'ACTIVE'
          ? !configuredMembership || areaIds.length === 0 || lostAreasStillGranted
          : (membership && membership.status !== 'REMOVED') || configuredMembership !== undefined
            || !noLiveMembershipAuthority(membershipId))
        || deviceStillExists) continue;
    }

    const changed = await db.nativeDomainOutbox.updateMany({
      where: { id: event.id, homeId: input.homeId, hubInstallationId: input.hubInstallationId, state: 'PENDING' },
      data: { state: 'DELIVERED', attempts: { increment: 1 }, updatedAt: input.now },
    });
    if (changed.count !== 1) continue;
    delivered += 1;
    await db.auditEvent.create({ data: {
      homeId: input.homeId, actorType: 'HUB', actorId: input.hubInstallationId,
      category: 'ACCESS', action: 'hub_tenant_policy_enforced', targetType: event.aggregateType,
      targetId: event.aggregateId,
      metadata: {
        version: 1, outboxId: event.id, eventType: event.eventType, membershipId,
        policyRevision, configurationRevision: revision, streamId: input.streamId,
        fromSequence: input.fromSequence, toSequence: input.toSequence, bodyHash: input.bodyHash,
      },
      purgeAt: new Date(input.now.getTime() + 365 * 24 * 60 * 60 * 1000),
    } });
  }

  if (delivered > 0) {
    const [unfinishedOutbox, pendingSupportRevocations] = await Promise.all([
      db.nativeDomainOutbox.count({ where: {
        homeId: input.homeId, hubInstallationId: input.hubInstallationId,
        eventType: { in: ['TENANT_MEMBERSHIP_REVOKED', 'TENANT_DEVICE_DECOMMISSION'] },
        state: { notIn: ['DELIVERED', 'CANCELLED', 'EXPIRED'] },
      } }),
      db.supportSession.count({ where: { homeId: input.homeId, hubInstallationId: input.hubInstallationId, status: 'PENDING_HUB_REVOKE' } }),
    ]);
    if (unfinishedOutbox === 0 && pendingSupportRevocations === 0) {
      await db.hubInstallation.updateMany({ where: {
        id: input.hubInstallationId, homeId: input.homeId, cleanupState: 'WAITING_FOR_TENANT_DEVICE_CLEANUP',
      }, data: { cleanupState: 'ACKNOWLEDGED' } });
    }
  }
  return { delivered };
}
