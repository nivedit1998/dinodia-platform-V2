import type { Prisma } from '@prisma/client';

export class TenantDeviceDashboardDenied extends Error {
  constructor(readonly code: 'MEMBERSHIP_REQUIRED' | 'TENANT_ROLE_REQUIRED' | 'SESSION_REVOKED') { super(code); }
}

/**
 * Builds the cloud-owned half of the live tenant dashboard. Device state and
 * descriptors are deliberately absent: those remain authoritative at OS.
 * Every returned device is filtered here, before it can reach the app.
 */
export async function readTenantDeviceDashboard(db: Prisma.TransactionClient, input: {
  accountId: string;
  sessionId: string;
  trustedDeviceId: string;
  tokenHash: string;
  credentialKind: 'account_access' | 'account_refresh';
  homeId: string;
  membershipId: string;
  hubInstallationId: string;
}) {
  const membership = await db.homeMembership.findFirst({
    where: {
      id: input.membershipId,
      customerAccountId: input.accountId,
      homeId: input.homeId,
      role: 'TENANT',
      status: 'ACTIVE',
      customerAccount: { status: 'ACTIVE' },
      home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: input.hubInstallationId },
    },
    select: {
      id: true,
      homeId: true,
      role: true,
      accessRevision: true,
      customerAccount: { select: { id: true, displayName: true, username: true } },
      home: { select: { id: true, managementRevision: true, postcode: true, activeHubInstallationId: true } },
      tenantAreaGrants: {
        where: { revokedAt: null, area: { status: 'ACTIVE' } },
        orderBy: { areaId: 'asc' },
        select: { areaId: true, policyRevision: true, area: { select: { id: true, originalName: true, overrideName: true, revision: true } } },
      },
    },
  });
  if (!membership) throw new TenantDeviceDashboardDenied('MEMBERSHIP_REQUIRED');

  const session = await db.customerSession.findFirst({
    where: {
      id: input.sessionId,
      customerAccountId: input.accountId,
      trustedDeviceId: input.trustedDeviceId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      absoluteExpiresAt: { gt: new Date() },
      ...(input.credentialKind === 'account_access' ? { accessTokenHash: input.tokenHash, accessTokenExpiresAt: { gt: new Date() } } : { refreshTokenHash: input.tokenHash }),
      trustedDevice: { id: input.trustedDeviceId, customerAccountId: input.accountId, revokedAt: null },
      customerAccount: { id: input.accountId, status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!session) throw new TenantDeviceDashboardDenied('SESSION_REVOKED');

  const grantedAreaIds = membership.tenantAreaGrants.map((grant) => grant.areaId);
  // Area grouping is presentation-only. Compute it against the complete
  // canonical home catalogue, but disclose a group only when this membership
  // holds every active Area in that explicit-override group. Partial access
  // receives no hint that another matching Area exists.
  const allActiveAreas = await db.area.findMany({
    where: { homeId: membership.homeId, status: 'ACTIVE' },
    orderBy: { id: 'asc' },
    select: { id: true, overrideName: true },
  });
  const grantedAreaIdSet = new Set(grantedAreaIds);
  const normalizedOverride = (value: string | null): string | null => {
    if (!value) return null;
    const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
    return normalized.length > 0 ? normalized : null;
  };
  const areaGroupBuckets = new Map<string, { name: string; areaIds: string[] }>();
  for (const area of allActiveAreas) {
    const key = normalizedOverride(area.overrideName);
    if (!key || !area.overrideName) continue;
    const bucket = areaGroupBuckets.get(key) ?? { name: area.overrideName.normalize('NFKC').trim().replace(/\s+/g, ' '), areaIds: [] };
    bucket.areaIds.push(area.id);
    areaGroupBuckets.set(key, bucket);
  }
  const areaGroups = [...areaGroupBuckets.values()]
    .filter((group) => group.areaIds.length > 1 && group.areaIds.every((areaId) => grantedAreaIdSet.has(areaId)))
    .map((group) => ({ name: group.name, areaIds: group.areaIds }));
  const devices = grantedAreaIds.length === 0 ? [] : await db.nativeDevice.findMany({
    where: {
      homeId: membership.homeId,
      hubInstallationId: input.hubInstallationId,
      lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] },
      OR: [
        { managementClass: 'PROPERTY_DEVICE', assignments: { some: { validUntil: null, areaId: { in: grantedAreaIds }, area: { status: 'ACTIVE' } } } },
        { managementClass: 'TENANT_DEVICE', ownerMembershipId: membership.id, assignments: { some: { validUntil: null, areaId: { in: grantedAreaIds }, area: { status: 'ACTIVE' } } } },
      ],
    },
    orderBy: [{ originalName: 'asc' }, { id: 'asc' }],
    select: {
      id: true, osDeviceId: true, originalName: true, overrideName: true, customerLabel: true, technicalLabel: true,
      inventoryRevision: true,
      managementClass: true, ownerMembershipId: true, lifecycle: true, onlineState: true,
      descriptorRevision: true,
      assignments: {
        where: { validUntil: null, areaId: { in: grantedAreaIds }, area: { status: 'ACTIVE' } },
        orderBy: { areaId: 'asc' },
        select: { areaId: true, area: { select: { id: true, originalName: true, overrideName: true, revision: true } } },
      },
    },
  });

  const deviceOverrides = devices.flatMap((device) => {
    const owner = device.managementClass === 'TENANT_DEVICE' && device.ownerMembershipId === membership.id;
    if (device.managementClass === 'TENANT_DEVICE' && !owner) return [];
    const areaIds = device.assignments.map(({ area }) => area.id);
    if (areaIds.length === 0) return [];
    return [{
      id: device.id,
      osDeviceId: device.osDeviceId,
      inventoryRevision: device.inventoryRevision,
      descriptorRevision: device.descriptorRevision,
      managementClass: owner ? 'tenant_device' : 'property_device',
      ownerMembershipId: owner ? membership.id : null,
      areaIds,
      overrideName: device.overrideName,
      customerLabel: owner ? device.customerLabel : null,
      canManage: owner,
      canRename: owner,
      canRelabel: owner,
      canMove: owner && device.lifecycle === 'INSTALLED',
      canRemove: owner && device.lifecycle === 'INSTALLED',
    }];
  });

  const [layout, recoveryRows, pendingRemovalRows, hubSync] = await Promise.all([
    db.memberPreferenceDocument.findUnique({
      where: { membershipId_kind: { membershipId: membership.id, kind: 'DASHBOARD_LAYOUT' } },
      select: { revision: true, document: true, updatedAt: true },
    }),
    db.nativeTenantDeviceRecovery.findMany({
      where: {
        homeId: membership.homeId,
        ownerMembershipId: membership.id,
        recoveredAt: null,
        expiredAt: null,
        recommissionExpiresAt: { gt: new Date() },
      },
      orderBy: { recommissionExpiresAt: 'asc' },
      select: { deviceId: true, recommissionExpiresAt: true, device: { select: { originalName: true, customerLabel: true } } },
    }),
    db.nativeDevice.findMany({ where: { homeId: membership.homeId, ownerMembershipId: membership.id,
      managementClass: 'TENANT_DEVICE', lifecycle: 'REMOVAL_PENDING' }, orderBy: { retiredAt: 'asc' }, take: 50,
      select: { id: true, originalName: true, retiredAt: true } }),
    db.hubInstallation.findFirst({ where: { id: input.hubInstallationId, homeId: membership.homeId },
      select: { cloudConfigurationRevision: true, acknowledgedCloudRevision: true, lastSuccessfulSyncAt: true, lastSyncErrorCode: true } }),
  ]);
  const visibleDeviceIds = new Set(deviceOverrides.map((device) => device.id));
  const storedLayout = layout?.document && typeof layout.document === 'object' && !Array.isArray(layout.document)
    ? layout.document as Record<string, unknown> : {};
  const storedTiles = Array.isArray(storedLayout.tiles) ? storedLayout.tiles : [];
  const safeTiles = storedTiles.filter((tile): tile is Record<string, unknown> => Boolean(tile) && typeof tile === 'object' && !Array.isArray(tile))
    .filter((tile) => typeof tile.deviceId === 'string' && visibleDeviceIds.has(tile.deviceId));
  const safeLayoutDocument = {
    version: 1,
    tiles: safeTiles,
    ...(storedLayout.labelColours && typeof storedLayout.labelColours === 'object' && !Array.isArray(storedLayout.labelColours)
      ? { labelColours: storedLayout.labelColours } : {}),
  };

  return {
    schemaVersion: 'dinodia.v1',
    ok: true,
    revision: { streamId: `tenant-context-${membership.id}`, sequence: membership.home.managementRevision },
    home: { id: membership.home.id, postcode: membership.home.postcode },
    tenant: { id: membership.customerAccount.id, name: membership.customerAccount.displayName, username: membership.customerAccount.username },
    membership: { membershipId: membership.id, homeId: membership.homeId, role: 'tenant', status: 'active', revision: membership.accessRevision },
    areaAccess: grantedAreaIds.map((areaId) => ({ areaId })),
    areaOverrides: membership.tenantAreaGrants.map(({ area }) => ({ areaId: area.id, originalName: area.originalName, overrideName: area.overrideName })),
    areaGroups,
    deviceOverrides,
    preferences: { layoutRevision: layout?.revision ?? 0 },
    layout: layout ? { revision: layout.revision, document: safeLayoutDocument, updatedAt: layout.updatedAt.toISOString() } : { revision: 0, document: { version: 1, tiles: [], labelColours: {} }, updatedAt: null },
    recovery: recoveryRows.map((row) => ({ deviceId: row.deviceId, displayName: row.device.customerLabel ?? row.device.originalName, expiresAt: row.recommissionExpiresAt.toISOString() })),
    pendingRemovals: pendingRemovalRows.map((row) => ({ deviceId: row.id, displayName: row.originalName, requestedAt: row.retiredAt?.toISOString() ?? null })),
    hubSync: hubSync ? {
      configurationRevision: hubSync.cloudConfigurationRevision,
      appliedRevision: hubSync.acknowledgedCloudRevision,
      lastSuccessfulSyncAt: hubSync.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastErrorCode: hubSync.lastSyncErrorCode,
    } : null,
  };
}
