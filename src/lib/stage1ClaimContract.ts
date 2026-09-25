import crypto from 'node:crypto';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';

const RESERVATION_MS = 30 * 60 * 1000;

function claimPepper(): Buffer {
  const value = String(process.env.CLAIM_REFERENCE_PEPPER ?? '');
  if (!value) throw new Stage1AuthError(503, 'claim_reference_unconfigured', 'Claim reference trust is not configured');
  return Buffer.from(value, 'utf8');
}

export function hashClaimReference(value: string): string {
  return crypto.createHmac('sha256', claimPepper()).update(String(value), 'utf8').digest('hex');
}

export async function redeemClaimContract(input: { reference: string; customerAccountId: string; emailVerified: boolean }) {
  if (!input.emailVerified) throw new Stage1AuthError(403, 'claim_email_unverified', 'Email verification is required before a claim can be reserved');
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    // Serialize all claim attempts for the same physical reference. This is
    // the database-level first-wins rule; application-side checks alone race.
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "companyQrReferenceHash" = ${hashClaimReference(input.reference)} FOR UPDATE`;
    const reference = await tx.homeClaimReference.findUnique({ where: { companyQrReferenceHash: hashClaimReference(input.reference) }, select: { id: true, homeId: true, hubInstallationId: true, state: true, generation: true } });
    if (!reference || !['AVAILABLE', 'RESERVED'].includes(reference.state)) throw new Stage1AuthError(409, 'claim_unavailable', 'This property claim is unavailable');
    const existing = await tx.homeClaimReservation.findFirst({ where: { claimReferenceId: reference.id, state: 'ACTIVE' }, select: { id: true, customerAccountId: true, expiresAt: true } });
    if (existing && existing.expiresAt > now && existing.customerAccountId !== input.customerAccountId) throw new Stage1AuthError(409, 'claim_already_reserved', 'This property is currently being claimed');
    // Redemption, polling and rescanning are reads for an already active
    // claimant. They must be idempotent and must never slide the deadline.
    if (existing && existing.expiresAt > now && existing.customerAccountId === input.customerAccountId) {
      return { expired: false as const, reservationId: existing.id, expiresAt: existing.expiresAt, generation: reference.generation };
    }
    if (existing && existing.expiresAt <= now) {
      await tx.pendingHomeSetup.deleteMany({ where: { reservationId: existing.id } });
      await tx.homeClaimReservation.update({ where: { id: existing.id }, data: { state: 'EXPIRED', updatedAt: now } });
      await tx.homeClaimReference.update({ where: { id: reference.id }, data: { state: 'AVAILABLE', reservedAt: null } });
      await tx.home.update({ where: { id: reference.homeId }, data: { lifecycle: 'CLAIMABLE' } });
      const [membershipCount, invitationCount, requestCount, pendingSetupCount, otherReservationCount] = await Promise.all([
        tx.homeMembership.count({ where: { customerAccountId: input.customerAccountId, status: 'ACTIVE' } }),
        tx.membershipInvitation.count({ where: { targetAccountId: input.customerAccountId, state: 'PENDING', expiresAt: { gt: now } } }),
        tx.areaAccessRequest.count({ where: { requesterAccountId: input.customerAccountId, status: 'PENDING', expiresAt: { gt: now } } }),
        tx.pendingHomeSetup.count({ where: { customerAccountId: input.customerAccountId, reservationId: { not: existing.id }, state: { not: 'EXPIRED' } } }),
        tx.homeClaimReservation.count({ where: { customerAccountId: input.customerAccountId, id: { not: existing.id }, state: 'ACTIVE', expiresAt: { gt: now } } }),
      ]);
      const accountCanBeDeleted = !membershipCount && !invitationCount && !requestCount && !pendingSetupCount && !otherReservationCount;
      if (accountCanBeDeleted) {
        await tx.customerSession.updateMany({ where: { customerAccountId: input.customerAccountId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'claim_reservation_expired' } });
        await tx.trustedDevice.updateMany({ where: { customerAccountId: input.customerAccountId, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 } } });
        const trustedDevices = await tx.trustedDevice.findMany({ where: { customerAccountId: input.customerAccountId }, select: { id: true } });
        await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: trustedDevices.map((device) => device.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'claim_reservation_expired' } });
        await tx.stepUpChallenge.updateMany({ where: { customerAccountId: input.customerAccountId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
        await tx.customerAccount.delete({ where: { id: input.customerAccountId } });
      }
      // The enclosing transaction must commit the cleanup before the caller
      // receives the expiry error. Throwing here would roll back the account,
      // reservation and draft cleanup together. This applies to both account
      // deletion and account-preservation branches; an expired reservation
      // must never silently create a replacement reservation.
      return { expired: true as const, accountDeleted: accountCanBeDeleted as boolean };
    }
    const expiresAt = new Date(now.getTime() + RESERVATION_MS);
    const reservation = await tx.homeClaimReservation.create({ data: { claimReferenceId: reference.id, customerAccountId: input.customerAccountId, state: 'ACTIVE', expiresAt }, select: { id: true, expiresAt: true } });
    await tx.pendingHomeSetup.upsert({ where: { reservationId: reservation.id }, create: { claimReferenceId: reference.id, reservationId: reservation.id, customerAccountId: input.customerAccountId, state: 'PROFILE_REQUIRED', requiredStep: 'PROFILE' }, update: { state: 'PROFILE_REQUIRED', expiredAt: null } });
    await tx.homeClaimReference.update({ where: { id: reference.id }, data: { state: 'RESERVED', reservedAt: now } });
    await tx.home.update({ where: { id: reference.homeId }, data: { lifecycle: 'CLAIM_RESERVED' } });
    return { expired: false as const, reservationId: reservation.id, expiresAt: reservation.expiresAt, generation: reference.generation };
  });
  if (result.expired) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The claim reservation expired; verify the account again before restarting');
  return result;
}

export async function recordQualifyingClaimMutation(reservationId: string, customerAccountId: string, step: string, mutation: Record<string, unknown> = {}) {
  const normalizedStep = String(step).toUpperCase();
  if (!['PROFILE', 'ADDRESS', 'ADDRESS_CONFIRMATION', 'POLICY'].includes(normalizedStep)) throw new Stage1AuthError(400, 'claim_step_invalid', 'The setup step is not a qualifying persisted setup mutation');
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { id: true, customerAccountId: true, state: true, expiresAt: true, claimReferenceId: true, setupRevision: true, claimReference: { select: { homeId: true } } } });
    if (!reservation || reservation.customerAccountId !== customerAccountId || reservation.state !== 'ACTIVE' || reservation.expiresAt <= now) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    if (normalizedStep === 'PROFILE') {
      const displayName = String(mutation.displayName ?? '').trim();
      const username = String(mutation.username ?? '').trim();
      if (!displayName || !username || displayName.length > 160 || username.length > 80) throw new Stage1AuthError(400, 'claim_profile_invalid', 'A saved display name and username are required');
      await tx.customerAccount.update({ where: { id: customerAccountId }, data: { displayName, username, usernameNormalized: username.toLowerCase() } });
    } else if (normalizedStep === 'ADDRESS') {
      const addressLine1 = String(mutation.addressLine1 ?? '').trim();
      const postcode = String(mutation.postcode ?? '').trim();
      const timezone = String(mutation.timezone ?? '').trim();
      if (!addressLine1 || !postcode || !timezone || addressLine1.length > 200 || postcode.length > 32 || timezone.length > 80) throw new Stage1AuthError(400, 'claim_address_invalid', 'A saved address, postcode and timezone are required');
      await tx.home.update({ where: { id: reservation.claimReference.homeId }, data: { addressLine1, addressLine2: String(mutation.addressLine2 ?? '').trim().slice(0, 200) || null, city: String(mutation.city ?? '').trim().slice(0, 120) || null, region: String(mutation.region ?? '').trim().slice(0, 120) || null, postcode, timezone, addressStatus: 'PENDING_CLAIM' } });
    } else if (normalizedStep === 'ADDRESS_CONFIRMATION') {
      await tx.home.update({ where: { id: reservation.claimReference.homeId }, data: { addressStatus: 'VERIFIED' } });
    } else {
      const policyVersion = String(mutation.policyVersion ?? '').trim();
      if (!policyVersion || policyVersion.length > 80) throw new Stage1AuthError(400, 'claim_policy_invalid', 'A policy version is required');
      await tx.policyAcceptance.upsert({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion } }, create: { customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion }, update: {} });
    }
    const updated = await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(now.getTime() + RESERVATION_MS), setupRevision: { increment: 1 }, lastQualifyingMutationAt: now }, select: { id: true, expiresAt: true, setupRevision: true } });
    await tx.pendingHomeSetup.update({ where: { reservationId }, data: { requiredStep: normalizedStep, setupRevision: updated.setupRevision, lastQualifyingMutationAt: now } });
    return updated;
  });
}

export async function completeClaimSetup(reservationId: string, customerAccountId: string) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { id: true, customerAccountId: true, claimReferenceId: true, state: true, expiresAt: true } });
    if (!reservation || reservation.customerAccountId !== customerAccountId || reservation.state !== 'ACTIVE' || reservation.expiresAt <= now) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { state: 'CONVERTED_TO_PENDING_INSTALLATION', updatedAt: now } });
    await tx.pendingHomeSetup.update({ where: { reservationId }, data: { state: 'PENDING_INSTALLATION', completedAt: now } });
    await tx.homeClaimReference.update({ where: { id: reservation.claimReferenceId }, data: { state: 'PENDING_INSTALLATION', claimedAccountId: customerAccountId, consumedAt: now } });
    return { ok: true, state: 'PENDING_INSTALLATION' as const };
  });
}

export async function releaseExpiredClaim(reservationId: string, manual: { employeeId?: string; reason?: string } = {}) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { id: true, claimReferenceId: true, customerAccountId: true, state: true, expiresAt: true } });
    if (!reservation || !['ACTIVE'].includes(reservation.state)) return { released: false };
    if (!manual.employeeId && reservation.expiresAt > now) throw new Stage1AuthError(409, 'claim_not_expired', 'The claim reservation is still active');
    if (manual.employeeId && !String(manual.reason || '').trim()) throw new Stage1AuthError(400, 'claim_release_reason_required', 'A reason is required for manual claim release');
    await tx.pendingHomeSetup.deleteMany({ where: { reservationId } });
    await tx.homeClaimReservation.update({ where: { id: reservationId }, data: { state: manual.employeeId ? 'MANUALLY_RELEASED' : 'EXPIRED', releasedByEmployeeId: manual.employeeId, releaseReason: manual.reason, updatedAt: now } });
    const reference = await tx.homeClaimReference.update({ where: { id: reservation.claimReferenceId }, data: { state: 'AVAILABLE', reservedAt: null } , select: { homeId: true } });
    await tx.home.update({ where: { id: reference.homeId }, data: { lifecycle: 'CLAIMABLE' } });
    await tx.auditEvent.create({ data: { homeId: reference.homeId, actorType: manual.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: manual.employeeId || null, category: 'SECURITY', action: manual.employeeId ? 'claim_manually_released' : 'claim_expired', targetType: 'HomeClaimReservation', targetId: reservationId, metadata: { outcome: 'released', reason: String(manual.reason || 'reservation_expired').slice(0, 500) }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    const [membershipCount, invitationCount, requestCount, pendingSetupCount, otherReservationCount] = await Promise.all([
      tx.homeMembership.count({ where: { customerAccountId: reservation.customerAccountId, status: 'ACTIVE' } }),
      tx.membershipInvitation.count({ where: { targetAccountId: reservation.customerAccountId, state: 'PENDING', expiresAt: { gt: now } } }),
      tx.areaAccessRequest.count({ where: { requesterAccountId: reservation.customerAccountId, status: 'PENDING', expiresAt: { gt: now } } }),
      tx.pendingHomeSetup.count({ where: { customerAccountId: reservation.customerAccountId, reservationId: { not: reservation.id }, state: { not: 'EXPIRED' } } }),
      tx.homeClaimReservation.count({ where: { customerAccountId: reservation.customerAccountId, id: { not: reservation.id }, state: 'ACTIVE', expiresAt: { gt: now } } }),
    ]);
    const accountCanBeDeleted = !membershipCount && !invitationCount && !requestCount && !pendingSetupCount && !otherReservationCount;
    if (accountCanBeDeleted) {
      await tx.customerSession.updateMany({ where: { customerAccountId: reservation.customerAccountId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'claim_reservation_released' } });
      await tx.trustedDevice.updateMany({ where: { customerAccountId: reservation.customerAccountId, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 } } });
      const trustedDevices = await tx.trustedDevice.findMany({ where: { customerAccountId: reservation.customerAccountId }, select: { id: true } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: trustedDevices.map((device) => device.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'claim_reservation_released' } });
      await tx.stepUpChallenge.updateMany({ where: { customerAccountId: reservation.customerAccountId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.customerAccount.delete({ where: { id: reservation.customerAccountId } });
    }
    return { released: true, accountDeleted: accountCanBeDeleted };
  });
}
