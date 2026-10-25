import type { Prisma } from '@prisma/client';

export class NativePresentationError extends Error {
  constructor(readonly code: 'MEMBERSHIP_FORBIDDEN' | 'RESOURCE_FORBIDDEN' | 'REVISION_CONFLICT' | 'INVALID_NAME') { super(code); }
}

function normalizedOverride(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new NativePresentationError('INVALID_NAME');
  const normalized = value.normalize('NFC').trim();
  if (!normalized || [...normalized].length > 160 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new NativePresentationError('INVALID_NAME');
  return normalized;
}

async function activeManager(db: Prisma.TransactionClient, accountId: string, membershipId: string, homeId: string) {
  return db.homeMembership.findFirst({
    where: { id: membershipId, customerAccountId: accountId, homeId, role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE', customerAccount: { status: 'ACTIVE' }, home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } },
    select: { id: true, role: true },
  });
}

/** Home and manager display overrides never mutate source names or security identity. */
export async function setAreaOverrideName(db: Prisma.TransactionClient, input: {
  accountId: string; membershipId: string; homeId: string; areaId: string; expectedAreaRevision: number; expectedManagementRevision: number; overrideName: unknown; now?: Date;
}) {
  const overrideName = normalizedOverride(input.overrideName);
  const actor = await activeManager(db, input.accountId, input.membershipId, input.homeId);
  if (!actor) throw new NativePresentationError('MEMBERSHIP_FORBIDDEN');
  const [area, home] = await Promise.all([
    db.area.findFirst({ where: { id: input.areaId, homeId: input.homeId, status: 'ACTIVE' }, select: { id: true, revision: true, originalName: true } }),
    db.home.findUnique({ where: { id: input.homeId }, select: { managementRevision: true } }),
  ]);
  if (!area || !home) throw new NativePresentationError('RESOURCE_FORBIDDEN');
  if (area.revision !== input.expectedAreaRevision || home.managementRevision !== input.expectedManagementRevision) throw new NativePresentationError('REVISION_CONFLICT');
  const now = input.now ?? new Date();
  const [areaWrite, homeWrite] = await Promise.all([
    db.area.updateMany({ where: { id: area.id, homeId: input.homeId, revision: area.revision, status: 'ACTIVE' }, data: { overrideName, revision: { increment: 1 } } }),
    db.home.updateMany({ where: { id: input.homeId, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } }),
  ]);
  if (areaWrite.count !== 1 || homeWrite.count !== 1) throw new NativePresentationError('REVISION_CONFLICT');
  await db.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.accountId, category: 'MANAGEMENT', action: 'area_display_override_changed', targetType: 'Area', targetId: input.areaId, metadata: { overridePresent: overrideName !== null, originalNamePreserved: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  return { areaId: input.areaId, originalName: area.originalName, overrideName, revision: area.revision + 1, managementRevision: home.managementRevision + 1 };
}

export async function setPropertyDeviceOverrideName(db: Prisma.TransactionClient, input: {
  accountId: string; membershipId: string; homeId: string; deviceId: string; expectedInventoryRevision: number; overrideName: unknown; now?: Date;
}) {
  const overrideName = normalizedOverride(input.overrideName);
  const actor = await activeManager(db, input.accountId, input.membershipId, input.homeId);
  if (!actor) throw new NativePresentationError('MEMBERSHIP_FORBIDDEN');
  const device = await db.nativeDevice.findFirst({ where: { id: input.deviceId, homeId: input.homeId, managementClass: 'PROPERTY_DEVICE', lifecycle: { notIn: ['RETIRED', 'REMOVED'] } }, select: { id: true, originalName: true, inventoryRevision: true } });
  if (!device) throw new NativePresentationError('RESOURCE_FORBIDDEN');
  if (device.inventoryRevision !== input.expectedInventoryRevision) throw new NativePresentationError('REVISION_CONFLICT');
  const updated = await db.nativeDevice.updateMany({ where: { id: device.id, homeId: input.homeId, managementClass: 'PROPERTY_DEVICE', inventoryRevision: device.inventoryRevision }, data: { overrideName, inventoryRevision: { increment: 1 } } });
  if (updated.count !== 1) throw new NativePresentationError('REVISION_CONFLICT');
  const now = input.now ?? new Date();
  await db.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.accountId, category: 'MANAGEMENT', action: 'property_device_display_override_changed', targetType: 'NativeDevice', targetId: input.deviceId, metadata: { overridePresent: overrideName !== null, originalNamePreserved: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  return { deviceId: input.deviceId, originalName: device.originalName, overrideName, inventoryRevision: device.inventoryRevision + 1 };
}
