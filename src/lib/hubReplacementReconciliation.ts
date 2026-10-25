import type { Prisma } from '@prisma/client';

export class HubReplacementError extends Error {}

/**
 * Performs only the no-device replacement path. A home with live inventory
 * must use the future signed per-device reconciliation protocol; never
 * blanket-retire or silently rebind its devices here.
 */
export async function activateReplacementHub(db: Prisma.TransactionClient, input: {
  homeId: string; actorEmployeeId: string; expectedCurrentHubId: string; replacementHubId: string; expectedManagementRevision: number; now?: Date;
}) {
  const now = input.now ?? new Date();
  const [home, employee] = await Promise.all([
    db.home.findFirst({ where: { id: input.homeId, lifecycle: { not: 'RETIRED' } }, select: { activeHubInstallationId: true, managementRevision: true } }),
    db.companyEmployeeAccount.findFirst({ where: { id: input.actorEmployeeId, status: 'ACTIVE', role: { in: ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER'] } }, select: { id: true, role: true } }),
  ]);
  if (!employee) throw new HubReplacementError('Authorised active installation employee is required');
  if (!home || home.activeHubInstallationId !== input.expectedCurrentHubId || home.managementRevision !== input.expectedManagementRevision) throw new HubReplacementError('Home or current hub revision changed');
  const replacement = await db.hubInstallation.findFirst({ where: { id: input.replacementHubId, homeId: input.homeId, state: { in: ['PROVISIONED', 'ACTIVE'] }, cloudUrl: { not: null }, cloudUrlVerifiedAt: { not: null }, remoteVerificationAt: { not: null } }, select: { id: true, lifecycleStatus: true, installationGeneration: true } });
  if (!replacement || replacement.id === input.expectedCurrentHubId || replacement.lifecycleStatus !== 'PENDING') throw new HubReplacementError('Replacement hub is not verified and eligible');
  const liveDeviceCount = await db.nativeDevice.count({ where: { homeId: input.homeId, hubInstallationId: input.expectedCurrentHubId, lifecycle: { notIn: ['RETIRED', 'REMOVED'] } } });
  if (liveDeviceCount !== 0) throw new HubReplacementError('Explicit signed per-device reconciliation is required before hub replacement');
  const old = await db.hubInstallation.updateMany({ where: { id: input.expectedCurrentHubId, homeId: input.homeId, lifecycleStatus: 'ACTIVE' }, data: { lifecycleStatus: 'REPLACED', replacedAt: now, state: 'REVOKED', currentMachineCredentialVersion: null, currentOperatorCredentialVersion: null, accessPolicyRevision: { increment: 1 } } });
  if (old.count !== 1) throw new HubReplacementError('Current hub changed during replacement');
  await db.hubCredentialVersion.updateMany({ where: { hubInstallationId: input.expectedCurrentHubId, state: { in: ['PENDING', 'DELIVERED', 'ACTIVE'] } }, data: { state: 'REVOKED', revokedAt: now } });
  await db.hubInstallation.update({ where: { id: replacement.id }, data: { lifecycleStatus: 'ACTIVE', installationGeneration: { increment: 1 }, replacesHubInstallationId: input.expectedCurrentHubId, accessPolicyRevision: { increment: 1 } } });
  const switched = await db.home.updateMany({ where: { id: input.homeId, activeHubInstallationId: input.expectedCurrentHubId, managementRevision: input.expectedManagementRevision }, data: { activeHubInstallationId: replacement.id, managementRevision: { increment: 1 } } });
  if (switched.count !== 1) throw new HubReplacementError('Home changed while replacement was being committed');
  await db.auditEvent.create({ data: { homeId: input.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'INSTALLATION', action: 'native_hub_replacement_activated_empty_inventory', targetType: 'HubInstallation', targetId: replacement.id, metadata: { oldHubInstallationId: input.expectedCurrentHubId, installationGeneration: replacement.installationGeneration + 1, verifiedLiveDeviceCount: 0, ownershipMutated: false }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  return { homeId: input.homeId, previousHubId: input.expectedCurrentHubId, activeHubId: replacement.id, switchedAt: now.toISOString() };
}
