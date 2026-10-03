import type { Prisma } from '@prisma/client';

export class NativeProvisioningError extends Error {
  constructor(readonly code: 'HUB_NOT_CURRENT' | 'REMOTE_VERIFICATION_REQUIRED' | 'CANONICAL_AREA_REQUIRED' | 'INSTALLATION_STATE_INVALID') { super(code); }
}

export async function assertNativeInstallationCompletable(db: Prisma.TransactionClient, homeId: string, hubInstallationId: string) {
  const [home, hub, areaCount] = await Promise.all([
    db.home.findUnique({ where: { id: homeId }, select: { id: true, activeHubInstallationId: true, installationStatus: true } }),
    db.hubInstallation.findFirst({ where: { id: hubInstallationId, homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true, state: true, cloudUrl: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true } }),
    db.area.count({ where: { homeId, status: 'ACTIVE' } }),
  ]);
  if (!home || home.activeHubInstallationId !== hub?.id) throw new NativeProvisioningError('HUB_NOT_CURRENT');
  if (!hub || !['PROVISIONED', 'ACTIVE'].includes(hub.state) || !hub.cloudUrl || !hub.cloudUrlVerifiedAt || !hub.remoteVerificationAt || hub.cloudUrlVerifiedAt > new Date() || hub.remoteVerificationAt > new Date()) throw new NativeProvisioningError('REMOTE_VERIFICATION_REQUIRED');
  if (areaCount < 1) throw new NativeProvisioningError('CANONICAL_AREA_REQUIRED');
  if (home.installationStatus === 'COMPLETE') throw new NativeProvisioningError('INSTALLATION_STATE_INVALID');
  return { homeId, hubInstallationId, areaCount };
}
