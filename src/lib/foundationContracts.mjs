export const CLAIM_RESERVATION_WINDOW_MS = 30 * 60 * 1000;

export function effectiveAreaName(area) {
  return area.overrideName?.trim() || area.originalName;
}

export function canReadDevice(membership, device, grantedAreaIds) {
  if (membership.status !== 'ACTIVE' || membership.homeId !== device.homeId) return false;
  if (device.lifecycle === 'REMOVED' || device.lifecycle === 'RETIRED') return false;
  if (membership.role === 'OWNER' || membership.role === 'PROPERTY_MANAGER') {
    return device.managementClass === 'PROPERTY_DEVICE';
  }
  // currentAreaId is a read-model field only. The repository must derive it
  // from the single open DeviceAreaAssignment before calling this contract.
  const currentAreaId = device.currentAreaId ?? device.currentAssignment?.areaId ?? null;
  if (currentAreaId === null || !grantedAreaIds.has(currentAreaId)) return false;
  if (device.managementClass === 'TENANT_DEVICE') return device.ownerMembershipId === membership.id;
  return true;
}

export function canCommandDevice(membership, device, grantedAreaIds) {
  if (!canReadDevice(membership, device, grantedAreaIds)) return false;
  return membership.role === 'TENANT';
}

export function isCurrentClaimChallenge(claim, challenge, now) {
  return (claim.state === 'AVAILABLE' || claim.state === 'RESERVED')
    && challenge.resolverGeneration === claim.resolverGeneration
    && challenge.expiresAt.getTime() > now.getTime()
    && challenge.consumedAt === null
    && challenge.revokedAt === null
    && Boolean(challenge.signedResponseDigest);
}

export function isClaimPresentationShape(claim) {
  if (claim.purpose === 'INITIAL_OWNER') return claim.transferCodeHash === null;
  return claim.purpose === 'OWNERSHIP_TRANSFER';
}

export function reservationDeadline(now) {
  return new Date(now.getTime() + CLAIM_RESERVATION_WINDOW_MS);
}

export function qualifiesReservationExtension(state, currentSetupRevision, nextSetupRevision, persistedMutation) {
  return state === 'ACTIVE' && persistedMutation && nextSetupRevision > currentSetupRevision;
}

export function isAssignedWorkAuthorized(work, employeeId, requestedHomeId, requestedHubInstallationId) {
  return work.assignedEmployeeId === employeeId
    && (work.state === 'ASSIGNED' || work.state === 'IN_PROGRESS' || work.state === 'REOPENED')
    && work.homeId === requestedHomeId
    && work.hubInstallationId === requestedHubInstallationId;
}

export function canSelfRemoveMembership(membership, actorMembershipId) {
  return membership.id === actorMembershipId && membership.role === 'TENANT';
}
