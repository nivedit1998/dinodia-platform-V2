import type { Prisma } from '@prisma/client';

export class NativeProvisioningError extends Error {
  constructor(readonly code: 'HUB_NOT_CURRENT' | 'REMOTE_VERIFICATION_REQUIRED' | 'CANONICAL_AREA_REQUIRED' | 'INSTALLATION_STATE_INVALID') { super(code); }
}

export async function assertNativeInstallationCompletable(db: Prisma.TransactionClient, homeId: string, hubInstallationId: string) {
  const [home, hub, areaCount, otherActiveCount, activeMembershipCount] = await Promise.all([
    db.home.findUnique({ where: { id: homeId }, select: { id: true, lifecycle: true, activeHubInstallationId: true, installationStatus: true } }),
    db.hubInstallation.findFirst({ where: { id: hubInstallationId, homeId }, select: { id: true, state: true, lifecycleStatus: true, manufacturingIdentityId: true, serialNumberSnapshot: true, cloudUrl: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true } }),
    db.area.count({ where: { homeId, status: 'ACTIVE' } }),
    db.hubInstallation.count({ where: { homeId, id: { not: hubInstallationId }, lifecycleStatus: 'ACTIVE', state: { notIn: ['REVOKED', 'WAITING_FOR_CLEANUP'] } } }),
    db.homeMembership.count({ where: { homeId, status: 'ACTIVE' } }),
  ]);
  if (!home || !hub || otherActiveCount > 0) throw new NativeProvisioningError('HUB_NOT_CURRENT');
  const pendingInstallation = hub.lifecycleStatus === 'PENDING' && hub.state === 'PROVISIONED'
    && home.lifecycle === 'INSTALLING' && home.installationStatus === 'IN_PROGRESS'
    && home.activeHubInstallationId === null;
  if (!pendingInstallation) throw new NativeProvisioningError('HUB_NOT_CURRENT');
  if (activeMembershipCount !== 0) throw new NativeProvisioningError('INSTALLATION_STATE_INVALID');
  const identity = await db.hubManufacturingIdentity.findFirst({ where: {
    id: hub.manufacturingIdentityId, serialNumber: hub.serialNumberSnapshot, status: 'ACTIVE',
  }, select: { id: true } });
  if (!identity || !['PROVISIONED', 'ACTIVE'].includes(hub.state) || !hub.cloudUrl || !hub.cloudUrlVerifiedAt
    || !hub.remoteVerificationAt || hub.cloudUrlVerifiedAt > new Date() || hub.remoteVerificationAt > new Date()) {
    throw new NativeProvisioningError('REMOTE_VERIFICATION_REQUIRED');
  }
  if (areaCount < 1) throw new NativeProvisioningError('CANONICAL_AREA_REQUIRED');
  if (home.installationStatus === 'COMPLETE') throw new NativeProvisioningError('INSTALLATION_STATE_INVALID');
  return { homeId, hubInstallationId, areaCount };
}
