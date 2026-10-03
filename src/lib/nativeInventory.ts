import type { Prisma } from '@prisma/client';

export async function readNativeInventory(db: Prisma.TransactionClient, context: {
  homeId: string; membershipId: string; activeHubInstallationId: string; role: 'OWNER' | 'PROPERTY_MANAGER' | 'TENANT'; grantedAreaIds: readonly string[];
}) {
  const permittedAreas = context.role === 'TENANT' ? [...context.grantedAreaIds] : undefined;
  if (permittedAreas && permittedAreas.length === 0) return { devices: [] as Array<Record<string, unknown>> };
  const rows = await db.nativeDevice.findMany({
    where: {
      homeId: context.homeId,
      hubInstallationId: context.activeHubInstallationId,
      lifecycle: { notIn: ['RETIRED', 'REMOVED'] },
      OR: context.role === 'TENANT'
        ? [
          { managementClass: 'PROPERTY_DEVICE', assignments: { some: { validUntil: null, areaId: { in: permittedAreas }, area: { status: 'ACTIVE' } } } },
          { managementClass: 'TENANT_DEVICE', ownerMembershipId: context.membershipId, assignments: { some: { validUntil: null, areaId: { in: permittedAreas }, area: { status: 'ACTIVE' } } } },
        ]
        : [{ managementClass: 'PROPERTY_DEVICE' }],
    },
    select: {
      id: true, homeId: true, originalName: true, overrideName: true, customerLabel: true, deviceType: true,
      managementClass: true, onlineState: true, lastSeenAt: true, descriptorRevision: true, lifecycle: true,
      ownerMembershipId: true,
      assignments: {
        where: { validUntil: null, ...(permittedAreas ? { areaId: { in: permittedAreas } } : {}), area: { status: 'ACTIVE' } },
        select: { areaId: true, area: { select: { originalName: true, overrideName: true, revision: true } } }, take: 1,
      },
    },
    orderBy: [{ originalName: 'asc' }, { id: 'asc' }],
  });
  return {
    devices: rows.flatMap((device) => {
      const assignment = device.assignments[0];
      if (!assignment || (permittedAreas && !permittedAreas.includes(assignment.areaId))) return [];
      const privateDevice = device.managementClass === 'TENANT_DEVICE';
      if (context.role !== 'TENANT' && privateDevice) return [];
      if (privateDevice && device.ownerMembershipId !== context.membershipId) return [];
      return [{
        id: device.id,
        homeId: device.homeId,
        areaId: assignment.areaId,
        areaName: assignment.area.overrideName ?? assignment.area.originalName,
        name: device.overrideName ?? device.originalName,
        ...(privateDevice && device.customerLabel ? { customerLabel: device.customerLabel } : {}),
        deviceType: device.deviceType,
        onlineState: device.onlineState,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        descriptorRevision: device.descriptorRevision,
        lifecycle: device.lifecycle,
      }];
    }),
  };
}
