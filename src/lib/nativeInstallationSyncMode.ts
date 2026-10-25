export type NativeInstallationSyncMode = 'ACTIVE' | 'INSTALLATION_BOOTSTRAP' | 'UNAVAILABLE';

export function resolveNativeInstallationSyncMode(input: {
  hubId: string;
  hubState: string;
  hubLifecycleStatus: string;
  cloudUrlVerifiedAt: Date | null;
  remoteVerificationAt: Date | null;
  homeId: string;
  homeLifecycle: string;
  installationStatus: string;
  activeHubInstallationId: string | null;
  openAssignedInstallationWorkCount: number;
  activeMembershipCount: number;
  now?: Date;
}): NativeInstallationSyncMode {
  const now = input.now ?? new Date();
  if (input.hubState === 'ACTIVE' && input.hubLifecycleStatus === 'ACTIVE' && input.activeHubInstallationId === input.hubId
    && input.installationStatus === 'COMPLETE'
    && ['PENDING_INSTALLATION', 'ACTIVE'].includes(input.homeLifecycle)) return 'ACTIVE';

  const verified = Boolean(input.cloudUrlVerifiedAt && input.remoteVerificationAt
    && input.cloudUrlVerifiedAt <= now && input.remoteVerificationAt <= now);
  // A completed hub can remain intentionally ownerless while its initial
  // claim is available or reserved. Keep it on the bounded installer
  // projection until owner activation: this lets the enrolled hub refresh
  // signed liveness (including LAN/TLS receipts) without granting tenant
  // inventory, telemetry, or device-event synchronization.
  if (input.hubState === 'ACTIVE' && input.hubLifecycleStatus === 'ACTIVE'
    && input.activeHubInstallationId === input.hubId && input.installationStatus === 'COMPLETE'
    && ['CLAIMABLE', 'CLAIM_RESERVED'].includes(input.homeLifecycle)
    && input.activeMembershipCount === 0 && verified) return 'INSTALLATION_BOOTSTRAP';

  if (input.hubLifecycleStatus === 'PENDING' && input.hubState === 'PROVISIONED'
    && input.homeLifecycle === 'INSTALLING' && input.installationStatus === 'IN_PROGRESS'
    && input.activeHubInstallationId === null && input.openAssignedInstallationWorkCount === 1
    && input.activeMembershipCount === 0 && verified) return 'INSTALLATION_BOOTSTRAP';

  return 'UNAVAILABLE';
}
