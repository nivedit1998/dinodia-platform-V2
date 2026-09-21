// Architecture: Shared platform helper src/lib/tenantOwnership.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { Prisma, Role, TenantDeviceCleanupStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type SessionSnapshot = {
  beforeDeviceIds: Prisma.JsonValue | null;
  afterDeviceIds: Prisma.JsonValue | null;
  beforeEntityIds: Prisma.JsonValue | null;
  afterEntityIds: Prisma.JsonValue | null;
};

export type TenantOwnedTargets = {
  deviceIds: string[];
  entityIds: string[];
  skippedDeviceIds: number;
  skippedEntityIds: number;
};

export type TenantOwnershipIndex = {
  ownDeviceIds: Set<string>;
  ownEntityIds: Set<string>;
  allTenantDeviceIds: Map<string, number>;
  allTenantEntityIds: Map<string, number>;
  pendingDeviceIds: Set<string>;
  pendingEntityIds: Set<string>;
};

function normalizeAutomationId(raw: string) {
  return raw.trim().replace(/^automation\./i, '');
}

function dedupeIds(ids: string[]) {
  return Array.from(
    new Set(
      ids
        .map((id) => normalizeAutomationId(id))
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
}

export function toStringSet(value: Prisma.JsonValue | null | undefined) {
  const result = new Set<string>();
  if (!value || !Array.isArray(value)) return result;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    result.add(trimmed);
  }
  return result;
}

function isCoreOrNativeDeviceId(id: string) {
  const normalized = id.trim().toLowerCase();
  return (
    normalized.startsWith('core_') ||
    normalized.startsWith('core.') ||
    normalized.startsWith('native_') ||
    normalized.startsWith('native.')
  );
}

function capIds(ids: string[], max: number | undefined) {
  if (!max || max <= 0) return { ids, skipped: 0 };
  if (ids.length <= max) return { ids, skipped: 0 };
  return { ids: ids.slice(0, max), skipped: ids.length - max };
}

export function collectTenantOwnedTargetsFromSessions(
  sessions: SessionSnapshot[],
  opts: { maxRegistryRemovals?: number } = {}
): TenantOwnedTargets {
  const deviceIds = new Set<string>();
  const entityIds = new Set<string>();

  for (const session of sessions) {
    const beforeDevices = toStringSet(session.beforeDeviceIds);
    const afterDevices = toStringSet(session.afterDeviceIds);
    const beforeEntities = toStringSet(session.beforeEntityIds);
    const afterEntities = toStringSet(session.afterEntityIds);

    afterDevices.forEach((id) => {
      if (!beforeDevices.has(id) && !isCoreOrNativeDeviceId(id)) {
        deviceIds.add(id);
      }
    });
    afterEntities.forEach((id) => {
      if (!beforeEntities.has(id)) {
        entityIds.add(id);
      }
    });
  }

  const sanitizedDevices = Array.from(deviceIds)
    .map((id) => id.trim())
    .filter(Boolean);
  const sanitizedEntities = Array.from(entityIds)
    .map((id) => id.trim())
    .filter(Boolean);

  const cappedDevices = capIds(sanitizedDevices, opts.maxRegistryRemovals);
  const cappedEntities = capIds(sanitizedEntities, opts.maxRegistryRemovals);

  return {
    deviceIds: cappedDevices.ids,
    entityIds: cappedEntities.ids,
    skippedDeviceIds: cappedDevices.skipped,
    skippedEntityIds: cappedEntities.skipped,
  };
}

export async function getTenantOwnedTargetsForUser(userId: number, haConnectionId: number) {
  const sessions = await prisma.newDeviceCommissioningSession.findMany({
    where: {
      userId,
      haConnectionId,
      user: { role: Role.TENANT },
    },
    select: {
      beforeDeviceIds: true,
      afterDeviceIds: true,
      beforeEntityIds: true,
      afterEntityIds: true,
    },
  });
  return collectTenantOwnedTargetsFromSessions(sessions);
}

export async function getTenantOwnedTargetsForHome(homeId: number, haConnectionId: number, opts: { maxRegistryRemovals?: number } = {}) {
  const sessions = await prisma.newDeviceCommissioningSession.findMany({
    where: {
      haConnectionId,
      user: { homeId, role: Role.TENANT },
    },
    select: {
      beforeDeviceIds: true,
      afterDeviceIds: true,
      beforeEntityIds: true,
      afterEntityIds: true,
    },
  });
  return collectTenantOwnedTargetsFromSessions(sessions, opts);
}

export function inferTenantOwnerFromTechnicalName(haName: string | null | undefined): number | null {
  const normalized = typeof haName === 'string' ? haName.trim() : '';
  const match = normalized.match(/^(\d+)_/);
  if (!match) return null;
  const userId = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

export async function getTenantOwnershipIndexForHome(args: {
  homeId: number;
  haConnectionId: number;
  currentTenantUserId?: number;
}): Promise<TenantOwnershipIndex> {
  const index: TenantOwnershipIndex = {
    ownDeviceIds: new Set(),
    ownEntityIds: new Set(),
    allTenantDeviceIds: new Map(),
    allTenantEntityIds: new Map(),
    pendingDeviceIds: new Set(),
    pendingEntityIds: new Set(),
  };

  const [overrides, sessions] = await Promise.all([
    prisma.tenantDeviceDisplayOverride.findMany({
      where: {
        haConnectionId: args.haConnectionId,
        tenantUser: { homeId: args.homeId, role: Role.TENANT },
      },
      select: {
        tenantUserId: true,
        haDeviceId: true,
        entityId: true,
        cleanupStatus: true,
      },
    }),
    prisma.newDeviceCommissioningSession.findMany({
      where: {
        haConnectionId: args.haConnectionId,
        user: { homeId: args.homeId, role: Role.TENANT },
      },
      select: {
        userId: true,
        beforeDeviceIds: true,
        afterDeviceIds: true,
        beforeEntityIds: true,
        afterEntityIds: true,
      },
    }),
  ]);

  for (const row of overrides) {
    const isPending = row.cleanupStatus === TenantDeviceCleanupStatus.PENDING_DEVICE_CLEANUP;
    if (row.haDeviceId) {
      index.allTenantDeviceIds.set(row.haDeviceId, row.tenantUserId);
      if (row.tenantUserId === args.currentTenantUserId) index.ownDeviceIds.add(row.haDeviceId);
      if (isPending) index.pendingDeviceIds.add(row.haDeviceId);
    }
    if (row.entityId) {
      index.allTenantEntityIds.set(row.entityId, row.tenantUserId);
      if (row.tenantUserId === args.currentTenantUserId) index.ownEntityIds.add(row.entityId);
      if (isPending) index.pendingEntityIds.add(row.entityId);
    }
  }

  for (const session of sessions) {
    const targets = collectTenantOwnedTargetsFromSessions([session]);
    for (const deviceId of targets.deviceIds) {
      if (!index.allTenantDeviceIds.has(deviceId)) index.allTenantDeviceIds.set(deviceId, session.userId);
      if (session.userId === args.currentTenantUserId) index.ownDeviceIds.add(deviceId);
    }
    for (const entityId of targets.entityIds) {
      if (!index.allTenantEntityIds.has(entityId)) index.allTenantEntityIds.set(entityId, session.userId);
      if (session.userId === args.currentTenantUserId) index.ownEntityIds.add(entityId);
    }
  }

  return index;
}

export function isOwnedByTenantDeviceFirst(
  device: { deviceId?: string | null; entityId: string },
  index: TenantOwnershipIndex,
  tenantUserId: number
): boolean {
  const deviceOwner = device.deviceId ? index.allTenantDeviceIds.get(device.deviceId) : undefined;
  if (deviceOwner != null) return deviceOwner === tenantUserId;
  const entityOwner = index.allTenantEntityIds.get(device.entityId);
  return entityOwner === tenantUserId;
}

export function isOwnedByAnotherTenantDeviceFirst(
  device: { deviceId?: string | null; entityId: string },
  index: TenantOwnershipIndex,
  tenantUserId: number
): boolean {
  const deviceOwner = device.deviceId ? index.allTenantDeviceIds.get(device.deviceId) : undefined;
  if (deviceOwner != null) return deviceOwner !== tenantUserId;
  const entityOwner = index.allTenantEntityIds.get(device.entityId);
  return entityOwner != null && entityOwner !== tenantUserId;
}

export async function getTenantAutomationIdsForHome(homeId: number) {
  const [createdByTenantRows, ownershipRows] = await Promise.all([
    prisma.homeAutomation.findMany({
      where: {
        homeId,
        createdByUser: { role: Role.TENANT },
      },
      select: { automationId: true },
    }),
    prisma.automationOwnership.findMany({
      where: {
        homeId,
        user: { role: Role.TENANT },
      },
      select: { automationId: true },
    }),
  ]);

  return dedupeIds([
    ...createdByTenantRows.map((row) => row.automationId),
    ...ownershipRows.map((row) => row.automationId),
  ]);
}

export async function getNonInstallerOwnedTargetsForHome(
  homeId: number,
  haConnectionId: number,
  opts: { maxRegistryRemovals?: number } = {}
) {
  const sessions = await prisma.newDeviceCommissioningSession.findMany({
    where: {
      haConnectionId,
      user: { homeId, role: { in: [Role.TENANT, Role.ADMIN] } },
    },
    select: {
      beforeDeviceIds: true,
      afterDeviceIds: true,
      beforeEntityIds: true,
      afterEntityIds: true,
    },
  });
  return collectTenantOwnedTargetsFromSessions(sessions, opts);
}

export async function getNonInstallerAutomationIdsForHome(homeId: number) {
  const [createdRows, ownershipRows] = await Promise.all([
    prisma.homeAutomation.findMany({
      where: {
        homeId,
        createdByUser: { role: { in: [Role.TENANT, Role.ADMIN] } },
      },
      select: { automationId: true },
    }),
    prisma.automationOwnership.findMany({
      where: {
        homeId,
        user: { role: { in: [Role.TENANT, Role.ADMIN] } },
      },
      select: { automationId: true },
    }),
  ]);

  return dedupeIds([...createdRows.map((row) => row.automationId), ...ownershipRows.map((row) => row.automationId)]);
}

export async function getAutomationIdsForTenant(homeId: number, tenantUserId: number) {
  const [createdRows, ownershipRows] = await Promise.all([
    prisma.homeAutomation.findMany({
      where: {
        homeId,
        createdByUserId: tenantUserId,
      },
      select: { automationId: true },
    }),
    prisma.automationOwnership.findMany({
      where: {
        homeId,
        userId: tenantUserId,
      },
      select: { automationId: true },
    }),
  ]);

  return dedupeIds([
    ...createdRows.map((row) => row.automationId),
    ...ownershipRows.map((row) => row.automationId),
  ]);
}
