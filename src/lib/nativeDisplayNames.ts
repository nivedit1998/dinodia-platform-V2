import type { Prisma } from '@prisma/client';
import { boundedCustomerLabel } from './nativeSchemaValidation';

export { NativePresentationError, setAreaOverrideName, setPropertyDeviceOverrideName } from './nativePresentation';

export async function setTenantDeviceCustomerLabel(db: Prisma.TransactionClient, input: {
  accountId: string; membershipId: string; homeId: string; deviceId: string; expectedInventoryRevision: number; label: unknown;
}) {
  const customerLabel = boundedCustomerLabel(input.label);
  const membership = await db.homeMembership.findFirst({ where: { id: input.membershipId, customerAccountId: input.accountId, homeId: input.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' }, home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } }, select: { id: true } });
  if (!membership) throw new Error('Tenant membership is not active in the selected home');
  const updated = await db.nativeDevice.updateMany({
    where: { id: input.deviceId, homeId: input.homeId, managementClass: 'TENANT_DEVICE', ownerMembershipId: membership.id, lifecycle: { notIn: ['RETIRED', 'REMOVED'] }, inventoryRevision: input.expectedInventoryRevision },
    data: { customerLabel, inventoryRevision: { increment: 1 } },
  });
  if (updated.count !== 1) throw new Error('Device owner or inventory revision changed');
  return { customerLabel, inventoryRevision: input.expectedInventoryRevision + 1 };
}
