import type { Prisma } from '@prisma/client';
import { canonicalPublicId } from './nativeSchemaValidation';

export class NativeAreaAccessError extends Error {
  constructor(readonly code: 'MEMBERSHIP_FORBIDDEN' | 'AREA_FORBIDDEN' | 'REVISION_CONFLICT' | 'INVALID_GRANT_SET') { super(code); }
}

export async function replaceTenantAreaGrants(db: Prisma.TransactionClient, input: {
  actorAccountId: string; actorMembershipId: string; tenantMembershipId: string; homeId: string;
  areaIds: readonly string[]; expectedManagementRevision: number; expectedAccessRevision: number; now?: Date;
}) {
  const now = input.now ?? new Date();
  const areaIds = [...new Set(input.areaIds)].sort();
  if (!Number.isSafeInteger(input.expectedManagementRevision) || input.expectedManagementRevision < 0
    || !Number.isSafeInteger(input.expectedAccessRevision) || input.expectedAccessRevision < 0
    || areaIds.length !== input.areaIds.length || areaIds.length > 500 || !areaIds.every(canonicalPublicId)) throw new NativeAreaAccessError('INVALID_GRANT_SET');
  const [actor, tenant, home, areas] = await Promise.all([
    db.homeMembership.findFirst({ where: { id: input.actorMembershipId, customerAccountId: input.actorAccountId, homeId: input.homeId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, customerAccount: { status: 'ACTIVE' } }, select: { id: true } }),
    db.homeMembership.findFirst({ where: { id: input.tenantMembershipId, homeId: input.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { id: true, accessRevision: true } }),
    db.home.findFirst({ where: { id: input.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, managementRevision: true, activeHubInstallationId: true } }),
    areaIds.length ? db.area.findMany({ where: { id: { in: areaIds }, homeId: input.homeId, status: 'ACTIVE' }, select: { id: true } }) : Promise.resolve([]),
  ]);
  if (!actor || !tenant || !home) throw new NativeAreaAccessError('MEMBERSHIP_FORBIDDEN');
  if (areas.length !== areaIds.length) throw new NativeAreaAccessError('AREA_FORBIDDEN');
  if (home.managementRevision !== input.expectedManagementRevision || tenant.accessRevision !== input.expectedAccessRevision) throw new NativeAreaAccessError('REVISION_CONFLICT');
  const current = await db.tenantAreaGrant.findMany({ where: { membershipId: tenant.id, homeId: input.homeId, revokedAt: null }, select: { areaId: true } });
  const currentIds = current.map((grant) => grant.areaId).sort();
  if (currentIds.length === areaIds.length && currentIds.every((id, index) => id === areaIds[index])) return { changed: false, managementRevision: home.managementRevision, accessRevision: tenant.accessRevision };
  const removedAreaIds = currentIds.filter((id) => !areaIds.includes(id));
  // A tenant-authored automation that targets an Area losing its grant must
  // not survive with an action that can no longer be authorised. Delete only
  // that tenant's automations with an action in a removed canonical Area;
  // unrelated memberships and automations remain untouched.
  if (removedAreaIds.length) {
    await db.nativeAutomation.deleteMany({ where: {
      homeId: input.homeId,
      createdByMembershipId: tenant.id,
      actions: { some: { homeId: input.homeId, areaId: { in: removedAreaIds } } },
    } });
  }
  const affectedTenantDevices = removedAreaIds.length ? await db.nativeDevice.findMany({
    where: {
      homeId: input.homeId, ownerMembershipId: tenant.id, managementClass: 'TENANT_DEVICE', lifecycle: { notIn: ['RETIRED', 'REMOVED'] },
      assignments: { some: { validUntil: null, areaId: { in: removedAreaIds } } },
      NOT: { assignments: { some: { validUntil: null, areaId: { in: areaIds }, area: { status: 'ACTIVE' } } } },
    },
    select: { id: true, hubInstallationId: true },
  }) : [];
  const nextRevision = home.managementRevision + 1;
  const changedHome = await db.home.updateMany({ where: { id: home.id, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
  if (changedHome.count !== 1) throw new NativeAreaAccessError('REVISION_CONFLICT');
  await db.tenantAreaGrant.updateMany({ where: { membershipId: tenant.id, homeId: input.homeId, revokedAt: null, ...(areaIds.length ? { areaId: { notIn: areaIds } } : {}) }, data: { revokedAt: now, revokeReason: 'grant_set_replaced', policyRevision: nextRevision } });
  for (const areaId of areaIds) await db.tenantAreaGrant.upsert({
    where: { membershipId_areaId: { membershipId: tenant.id, areaId } },
    create: { membershipId: tenant.id, areaId, homeId: input.homeId, policyRevision: nextRevision, grantedAt: now },
    update: { homeId: input.homeId, policyRevision: nextRevision, grantedAt: now, revokedAt: null, revokeReason: null },
  });
  if (affectedTenantDevices.length) {
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    for (const device of affectedTenantDevices) {
      await db.nativeDomainOutbox.upsert({
        where: { idempotencyKey: `tenant-area-revocation:${nextRevision}:${device.id}` },
        create: {
          homeId: input.homeId, hubInstallationId: device.hubInstallationId, aggregateType: 'NativeDevice', aggregateId: device.id,
          eventType: 'TENANT_DEVICE_DECOMMISSION', idempotencyKey: `tenant-area-revocation:${nextRevision}:${device.id}`,
          payload: { operation: 'REMOVE_TENANT_DEVICE', deviceId: device.id, membershipId: tenant.id, policyRevision: nextRevision }, expiresAt,
        },
        update: {},
      });
    }
    const affectedHubIds = [...new Set(affectedTenantDevices.map((device) => device.hubInstallationId))];
    await db.hubInstallation.updateMany({
      where: { homeId: input.homeId, id: { in: affectedHubIds } },
      data: { cleanupState: 'WAITING_FOR_TENANT_DEVICE_CLEANUP', cleanupGeneration: { increment: 1 } },
    });
    // Cloud ownership, assignments, automation projections and device history are deleted
    // in the same transaction. The bounded outbox tombstone carries only the exact target ID.
    await db.nativeDevice.deleteMany({ where: { id: { in: affectedTenantDevices.map((device) => device.id) }, homeId: input.homeId, ownerMembershipId: tenant.id, managementClass: 'TENANT_DEVICE' } });
  }
  const membership = await db.homeMembership.update({ where: { id: tenant.id }, data: { accessRevision: { increment: 1 } }, select: { accessRevision: true } });
  await db.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.actorAccountId, category: 'ACCESS', action: 'tenant_area_grants_replaced', targetType: 'HomeMembership', targetId: tenant.id, metadata: { grantCount: areaIds.length, removedAreaCount: removedAreaIds.length, decommissionTombstoneCount: affectedTenantDevices.length, managementRevision: nextRevision }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  return { changed: true, managementRevision: nextRevision, accessRevision: membership.accessRevision, decommissionTombstoneCount: affectedTenantDevices.length };
}
