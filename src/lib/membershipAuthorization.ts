import 'server-only';
import { HomeMembershipRole, HomeMembershipStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export async function getActiveHomeMembership(userId: number, homeId: number) {
  return prisma.homeMembership.findUnique({ where: { userId_homeId: { userId, homeId } }, include: { areaGrants: true } }).then((record) => record && record.status === HomeMembershipStatus.ACTIVE && !record.removedAt ? record : null);
}

export function hasAreaGrant(membership: { role: HomeMembershipRole; areaGrants: Array<{ areaId: string; revokedAt: Date | null }> }, areaId: string) {
  if (membership.role === HomeMembershipRole.OWNER || membership.role === HomeMembershipRole.PROPERTY_MANAGER) return true;
  return membership.areaGrants.some((grant) => grant.areaId === String(areaId) && !grant.revokedAt);
}

export function hasEveryAreaGrant(membership: { role: HomeMembershipRole; areaGrants: Array<{ areaId: string; revokedAt: Date | null }> }, areaIds: string[]) {
  return areaIds.every((areaId) => hasAreaGrant(membership, areaId));
}

export function canManagePermanentProperty(membership: { role: HomeMembershipRole }) {
  return membership.role === HomeMembershipRole.OWNER || membership.role === HomeMembershipRole.PROPERTY_MANAGER;
}

export function canControlPermanentDevice(membership: { role: HomeMembershipRole; areaGrants: Array<{ areaId: string; revokedAt: Date | null }> }, areaId: string) {
  return membership.role === HomeMembershipRole.TENANT && hasAreaGrant(membership, areaId);
}
