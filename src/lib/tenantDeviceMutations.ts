import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { readTenantDeviceDashboard } from './tenantDeviceDashboard';

export type TenantDevicePresentationMutation =
  | { action: 'rename'; overrideName: string | null }
  | { action: 'relabel'; customerLabel: string | null }
  | { action: 'move'; areaId: string };

export class TenantDeviceMutationError extends Error {
  constructor(readonly code: 'NOT_OWNER' | 'REVISION_CONFLICT' | 'INVALID_AREA' | 'IDEMPOTENCY_CONFLICT') { super(code); }
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Membership-scoped tenant presentation changes. Live device state, control
 * descriptors, technical labels and OS identity are intentionally untouched.
 */
export async function mutateTenantDevicePresentation(db: Prisma.TransactionClient, input: {
  accountId: string;
  sessionId: string;
  trustedDeviceId: string;
  tokenHash: string;
  credentialKind: 'account_access' | 'account_refresh';
  homeId: string;
  membershipId: string;
  hubInstallationId: string;
  deviceId: string;
  expectedInventoryRevision: number;
  idempotencyKey: string;
  mutation: TenantDevicePresentationMutation;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const body = { deviceId: input.deviceId, expectedInventoryRevision: input.expectedInventoryRevision, ...input.mutation };
  const requestHash = digest(body);
  const keyHash = digest(`${input.accountId}\n${input.idempotencyKey}`);
  const namespace = 'tenant-device-presentation:v1';

  const context = await readTenantDeviceDashboard(db, {
    accountId: input.accountId,
    sessionId: input.sessionId,
    trustedDeviceId: input.trustedDeviceId,
    tokenHash: input.tokenHash,
    credentialKind: input.credentialKind,
    homeId: input.homeId,
    membershipId: input.membershipId,
    hubInstallationId: input.hubInstallationId,
  });

  const previous = await db.idempotencyRecord.findUnique({
    where: { namespace_keyHash: { namespace, keyHash } },
    select: { actorId: true, homeId: true, hubInstallationId: true, requestHash: true, responseBody: true, expiresAt: true },
  });
  if (previous) {
    if (previous.actorId !== input.accountId || previous.homeId !== input.homeId
      || previous.hubInstallationId !== input.hubInstallationId || previous.requestHash !== requestHash
      || previous.expiresAt <= now || !previous.responseBody || typeof previous.responseBody !== 'object') {
      throw new TenantDeviceMutationError('IDEMPOTENCY_CONFLICT');
    }
    return previous.responseBody as Record<string, unknown>;
  }

  const device = await db.nativeDevice.findFirst({
    where: {
      id: input.deviceId,
      homeId: input.homeId,
      hubInstallationId: input.hubInstallationId,
      managementClass: 'TENANT_DEVICE',
      ownerMembershipId: input.membershipId,
      lifecycle: 'INSTALLED',
      assignments: { some: { validUntil: null, areaId: { in: context.areaAccess.map((area) => area.areaId) }, area: { status: 'ACTIVE' } } },
    },
    select: { id: true, inventoryRevision: true, originalName: true, assignments: { where: { validUntil: null }, select: { areaId: true } } },
  });
  if (!device) throw new TenantDeviceMutationError('NOT_OWNER');
  if (device.inventoryRevision !== input.expectedInventoryRevision) throw new TenantDeviceMutationError('REVISION_CONFLICT');

  if (input.mutation.action === 'move') {
    const grant = await db.tenantAreaGrant.findFirst({ where: {
      membershipId: input.membershipId, homeId: input.homeId, areaId: input.mutation.areaId,
      revokedAt: null, area: { status: 'ACTIVE' },
    }, select: { areaId: true } });
    if (!grant) throw new TenantDeviceMutationError('INVALID_AREA');
    if (device.assignments.length !== 1 || device.assignments[0].areaId !== grant.areaId) {
      await db.deviceAreaAssignment.updateMany({ where: { deviceId: device.id, homeId: input.homeId, validUntil: null }, data: { validUntil: now } });
      await db.deviceAreaAssignment.create({ data: {
        deviceId: device.id, homeId: input.homeId, areaId: grant.areaId,
        source: 'TENANT_DEVICE_OWNER', actorType: 'CUSTOMER', actorId: input.accountId, validFrom: now,
      } });
    }
  }
  const data = input.mutation.action === 'rename'
    ? { overrideName: input.mutation.overrideName }
    : input.mutation.action === 'relabel' ? { customerLabel: input.mutation.customerLabel } : {};
  const updated = await db.nativeDevice.updateMany({
    where: { id: device.id, homeId: input.homeId, hubInstallationId: input.hubInstallationId,
      managementClass: 'TENANT_DEVICE', ownerMembershipId: input.membershipId,
      lifecycle: 'INSTALLED', inventoryRevision: input.expectedInventoryRevision },
    data: { ...data, inventoryRevision: { increment: 1 } },
  });
  if (updated.count !== 1) throw new TenantDeviceMutationError('REVISION_CONFLICT');

  const home = await db.home.updateMany({ where: { id: input.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', managementRevision: context.revision.sequence }, data: { managementRevision: { increment: 1 } } });
  if (home.count !== 1) throw new TenantDeviceMutationError('NOT_OWNER');
  const response = { schemaVersion: 'dinodia.v1', ok: true, homeId: input.homeId, deviceId: device.id,
    action: input.mutation.action, inventoryRevision: input.expectedInventoryRevision + 1,
    ...(input.mutation.action === 'move' ? { areaId: input.mutation.areaId, hubEnforcement: 'PENDING' } : {}) };
  await db.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.accountId,
    category: 'MANAGEMENT', action: `tenant_device_${input.mutation.action}_changed`, targetType: 'NativeDevice', targetId: device.id,
    metadata: { managementClass: 'TENANT_DEVICE', revision: input.expectedInventoryRevision + 1,
      restoredOriginal: input.mutation.action === 'rename' && input.mutation.overrideName === null },
    purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  await db.idempotencyRecord.create({ data: { namespace, keyHash, actorId: input.accountId, homeId: input.homeId,
    hubInstallationId: input.hubInstallationId, requestHash, responseStatus: 200,
    responseBody: response as Prisma.InputJsonValue, responseDigest: digest(response),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
  return response;
}
