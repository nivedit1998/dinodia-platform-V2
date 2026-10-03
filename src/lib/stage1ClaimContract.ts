import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';

const RESERVATION_MS = 30 * 60 * 1000;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

type ClaimTransaction = Prisma.TransactionClient;

async function cleanReleasedReservation(tx: ClaimTransaction, reservation: { id: string; claimReferenceId: string; customerAccountId: string }, now: Date, manual: { employeeId?: string; reason?: string } = {}) {
  // The reservation, never the person who happens to scan next, owns cleanup.
  const holderId = reservation.customerAccountId;
  await tx.pendingHomeSetup.deleteMany({ where: { reservationId: reservation.id } });
  await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { state: manual.employeeId ? 'MANUALLY_RELEASED' : 'EXPIRED', releasedByEmployeeId: manual.employeeId, releaseReason: manual.reason, updatedAt: now } });
  const reference = await tx.homeClaimReference.update({ where: { id: reservation.claimReferenceId }, data: { state: 'AVAILABLE', reservedAt: null, claimedAccountId: null, consumedAt: null }, select: { homeId: true } });
  await tx.home.update({ where: { id: reference.homeId }, data: { lifecycle: 'CLAIMABLE' } });
  await tx.auditEvent.create({ data: { homeId: reference.homeId, actorType: manual.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: manual.employeeId || null, category: 'SECURITY', action: manual.employeeId ? 'claim_manually_released' : 'claim_expired', targetType: 'HomeClaimReservation', targetId: reservation.id, metadata: { outcome: 'released', reason: String(manual.reason || 'reservation_expired').slice(0, 500) }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  const [membershipCount, invitationCount, requestCount, pendingSetupCount, otherReservationCount] = await Promise.all([
    tx.homeMembership.count({ where: { customerAccountId: holderId, status: 'ACTIVE' } }),
    tx.membershipInvitation.count({ where: { targetAccountId: holderId, state: 'PENDING', expiresAt: { gt: now } } }),
    tx.areaAccessRequest.count({ where: { requesterAccountId: holderId, status: 'PENDING', expiresAt: { gt: now } } }),
    tx.pendingHomeSetup.count({ where: { customerAccountId: holderId, reservationId: { not: reservation.id }, state: { not: 'EXPIRED' } } }),
    tx.homeClaimReservation.count({ where: { customerAccountId: holderId, id: { not: reservation.id }, state: 'ACTIVE', expiresAt: { gt: now } } }),
  ]);
  const accountDeleted = !membershipCount && !invitationCount && !requestCount && !pendingSetupCount && !otherReservationCount;
  if (accountDeleted) {
    await tx.customerSession.updateMany({ where: { customerAccountId: holderId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'claim_reservation_released' } });
    await tx.trustedDevice.updateMany({ where: { customerAccountId: holderId, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 } } });
    const trustedDevices = await tx.trustedDevice.findMany({ where: { customerAccountId: holderId }, select: { id: true } });
    await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: trustedDevices.map((device) => device.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'claim_reservation_released' } });
    await tx.stepUpChallenge.updateMany({ where: { customerAccountId: holderId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
    await tx.customerAccount.delete({ where: { id: holderId } });
  }
  return { released: true, accountDeleted };
}

function claimPepper(): Buffer {
  const value = String(process.env.CLAIM_REFERENCE_PEPPER ?? '');
  if (!value) throw new Stage1AuthError(503, 'claim_reference_unconfigured', 'Claim reference trust is not configured');
  return Buffer.from(value, 'utf8');
}

function currentNativePolicyVersion(): string {
  const version = String(process.env.DINODIA_NATIVE_POLICY_VERSION ?? '').trim();
  if (!POLICY_VERSION_PATTERN.test(version)) throw new Stage1AuthError(503, 'claim_policy_unavailable', 'The current customer policy is not configured');
  return version;
}

type ClaimAddress = { addressLine1: string | null; addressLine2: string | null; city: string | null; region: string | null; postcode: string | null; country: string | null; timezone: string | null; managementRevision: number };

function addressDigest(address: ClaimAddress): string {
  return crypto.createHmac('sha256', claimPepper()).update(JSON.stringify([address.addressLine1, address.addressLine2, address.city, address.region, address.postcode, address.country, address.timezone])).digest('hex');
}

function completeAddress(address: ClaimAddress): boolean {
  return Boolean(address.addressLine1 && address.city && address.postcode && address.country && address.timezone);
}

function normalizeOptionalAddressPart(value: unknown, limit: number): string | null {
  return String(value ?? '').trim().slice(0, limit) || null;
}

function normalizeClaimAddress(mutation: Record<string, unknown>) {
  return {
    addressLine1: String(mutation.addressLine1 ?? '').trim(),
    addressLine2: normalizeOptionalAddressPart(mutation.addressLine2, 200),
    city: String(mutation.city ?? '').trim(),
    region: normalizeOptionalAddressPart(mutation.region, 120),
    postcode: String(mutation.postcode ?? '').trim(),
    country: String(mutation.country ?? '').trim().toUpperCase(),
    timezone: String(mutation.timezone ?? '').trim(),
  };
}

function normalizedPersistedAddress(address: { addressLine1: string | null; addressLine2: string | null; city: string | null; region: string | null; postcode: string | null; country: string | null; timezone: string | null }) {
  return {
    addressLine1: String(address.addressLine1 ?? '').trim(),
    addressLine2: normalizeOptionalAddressPart(address.addressLine2, 200),
    city: String(address.city ?? '').trim(),
    region: normalizeOptionalAddressPart(address.region, 120),
    postcode: String(address.postcode ?? '').trim(),
    country: String(address.country ?? '').trim().toUpperCase(),
    timezone: String(address.timezone ?? '').trim(),
  };
}

function sameNormalizedAddress(left: ReturnType<typeof normalizeClaimAddress>, right: ReturnType<typeof normalizedPersistedAddress>): boolean {
  return left.addressLine1 === right.addressLine1
    && left.addressLine2 === right.addressLine2
    && left.city === right.city
    && left.region === right.region
    && left.postcode === right.postcode
    && left.country === right.country
    && left.timezone === right.timezone;
}

export async function readClaimAddressContract(reservationId: string, customerAccountId: string) {
  const reservation = await prisma.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { customerAccountId: true, state: true, expiresAt: true, claimReference: { select: { homeId: true } } } });
  if (!reservation || reservation.customerAccountId !== customerAccountId || (reservation.state !== 'ACTIVE' && reservation.state !== 'CONVERTED_TO_PENDING_INSTALLATION') || (reservation.state === 'ACTIVE' && reservation.expiresAt <= new Date())) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
  const address = await prisma.home.findUniqueOrThrow({ where: { id: reservation.claimReference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, managementRevision: true } });
  return { addressLine1: address.addressLine1, addressLine2: address.addressLine2, city: address.city, region: address.region, postcode: address.postcode, country: address.country, timezone: address.timezone, addressRevision: address.managementRevision, addressDigest: addressDigest(address) };
}

export async function correctRetainedAddressContract(homeId: string, employeeId: string, address: Record<string, unknown>) {
  const employee = await prisma.companyEmployeeAccount.findUnique({ where: { id: employeeId }, select: { status: true, role: true } });
  if (!employee || employee.status !== 'ACTIVE' || !['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER'].includes(employee.role)) throw new Stage1AuthError(403, 'claim_staff_required', 'Authorised staff must correct the registered address');
  const addressLine1 = String(address.addressLine1 ?? '').trim();
  const city = String(address.city ?? '').trim();
  const postcode = String(address.postcode ?? '').trim();
  const country = String(address.country ?? '').trim().toUpperCase();
  const timezone = String(address.timezone ?? '').trim();
  if (!addressLine1 || !city || !postcode || !/^[A-Z]{2}$/.test(country) || !timezone || addressLine1.length > 200 || city.length > 120 || postcode.length > 32 || timezone.length > 80) throw new Stage1AuthError(400, 'claim_address_invalid', 'A complete registered address is required');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${homeId}::uuid FOR UPDATE`;
    const home = await tx.home.findUnique({ where: { id: homeId }, select: { id: true, lifecycle: true } });
    if (!home || !['CLAIMABLE', 'CLAIM_RESERVED', 'PENDING_INSTALLATION'].includes(home.lifecycle)) throw new Stage1AuthError(409, 'claim_address_unavailable', 'The registered address cannot be corrected in this state');
    const updated = await tx.home.update({ where: { id: homeId }, data: { addressLine1, addressLine2: String(address.addressLine2 ?? '').trim().slice(0, 200) || null, city, region: String(address.region ?? '').trim().slice(0, 120) || null, postcode, country, timezone, addressStatus: 'STAFF_CORRECTED', managementRevision: { increment: 1 } }, select: { managementRevision: true } });
    await tx.pendingHomeSetup.updateMany({ where: { claimReference: { homeId }, state: { not: 'ACTIVATED' } }, data: { retainedAddressRevision: null, retainedAddressDigest: null, retainedAddressConfirmedAt: null, retainedAddressConfirmedByAccountId: null } });
    return { addressRevision: updated.managementRevision };
  });
}

export function hashClaimReference(value: string): string {
  return crypto.createHmac('sha256', claimPepper()).update(String(value), 'utf8').digest('hex');
}

export async function redeemClaimContract(input: { reference: string; customerAccountId: string; emailVerified: boolean }) {
  if (!input.emailVerified) throw new Stage1AuthError(403, 'claim_email_unverified', 'Email verification is required before a claim can be reserved');
  const result = await prisma.$transaction(async (tx) => {
    // Serialize all claim attempts for the same physical reference. This is
    // the database-level first-wins rule; application-side checks alone race.
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "companyQrReferenceHash" = ${hashClaimReference(input.reference)} FOR UPDATE`;
    // Expiry is evaluated only after the serialization lock. A request queued
    // before expiresAt cannot redeem the reservation using stale request time.
    const now = new Date();
    const reference = await tx.homeClaimReference.findUnique({ where: { companyQrReferenceHash: hashClaimReference(input.reference) }, select: { id: true, homeId: true, hubInstallationId: true, state: true, generation: true } });
    if (!reference || !['AVAILABLE', 'RESERVED'].includes(reference.state)) throw new Stage1AuthError(409, 'claim_unavailable', 'This property claim is unavailable');
    const existing = await tx.homeClaimReservation.findFirst({ where: { claimReferenceId: reference.id, state: 'ACTIVE' }, select: { id: true, claimReferenceId: true, customerAccountId: true, expiresAt: true } });
    if (existing && existing.expiresAt > now && existing.customerAccountId !== input.customerAccountId) throw new Stage1AuthError(409, 'claim_already_reserved', 'This property is currently being claimed');
    // Redemption, polling and rescanning are reads for an already active
    // claimant. They must be idempotent and must never slide the deadline.
    if (existing && existing.expiresAt > now && existing.customerAccountId === input.customerAccountId) {
      return { expired: false as const, reservationId: existing.id, expiresAt: existing.expiresAt, generation: reference.generation };
    }
    if (existing && existing.expiresAt <= now) {
      const cleanup = await cleanReleasedReservation(tx, existing, now);
      // The enclosing transaction must commit the cleanup before the caller
      // receives the expiry error. Throwing here would roll back the account,
      // reservation and draft cleanup together. This applies to both account
      // deletion and account-preservation branches; an expired reservation
      // must never silently create a replacement reservation.
      return { expired: true as const, accountDeleted: cleanup.accountDeleted };
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
  const requestedPolicyVersion = normalizedStep === 'POLICY' && typeof mutation.policyVersion === 'string' ? mutation.policyVersion.trim() : null;
  if (normalizedStep === 'POLICY' && (!requestedPolicyVersion || !POLICY_VERSION_PATTERN.test(requestedPolicyVersion))) throw new Stage1AuthError(400, 'claim_policy_invalid', 'A valid policy version is required');
  const authoritativePolicyVersion = normalizedStep === 'POLICY' ? currentNativePolicyVersion() : null;
  if (normalizedStep === 'POLICY' && requestedPolicyVersion !== authoritativePolicyVersion) throw new Stage1AuthError(409, 'claim_policy_stale', 'The accepted policy version is no longer current');
  return prisma.$transaction(async (tx) => {
    const claimLookup = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { claimReferenceId: true } });
    if (!claimLookup) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${claimLookup.claimReferenceId}::uuid FOR UPDATE`;
    const initialReservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { customerAccountId: true, state: true, claimReference: { select: { homeId: true } } } });
    if (!initialReservation || initialReservation.customerAccountId !== customerAccountId) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');

    // PROFILE and POLICY are account-wide. Serialize them across claims for
    // different homes before comparing persisted values, so concurrent saves
    // cannot both treat the same value as a newly accepted mutation.
    if (normalizedStep === 'PROFILE' || normalizedStep === 'POLICY') {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${customerAccountId}::uuid FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${initialReservation.claimReference.homeId}::uuid FOR UPDATE`;
    }

    // Read time only after obtaining all serialization locks. A request that
    // waited at a lock must not use a timestamp from before the reservation
    // expired and thereby revive it.
    const now = new Date();
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { id: true, customerAccountId: true, state: true, expiresAt: true, claimReferenceId: true, setupRevision: true, claimReference: { select: { homeId: true } } } });
    const pendingReconfirmation = normalizedStep === 'ADDRESS_CONFIRMATION' && reservation?.state === 'CONVERTED_TO_PENDING_INSTALLATION';
    if (!reservation || reservation.customerAccountId !== customerAccountId || (!pendingReconfirmation && (reservation.state !== 'ACTIVE' || reservation.expiresAt <= now))) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    const unchanged = () => ({ id: reservation.id, expiresAt: reservation.expiresAt, setupRevision: reservation.setupRevision });
    if (normalizedStep === 'PROFILE') {
      const displayName = String(mutation.displayName ?? '').trim();
      const username = String(mutation.username ?? '').trim();
      if (!displayName || !username || displayName.length > 160 || username.length > 80) throw new Stage1AuthError(400, 'claim_profile_invalid', 'A saved display name and username are required');
      const current = await tx.customerAccount.findUnique({ where: { id: customerAccountId }, select: { displayName: true, username: true, usernameNormalized: true } });
      if (!current) throw new Stage1AuthError(404, 'claim_account_missing', 'The customer account does not exist');
      if (current.displayName.trim() === displayName && current.usernameNormalized === username.toLowerCase()) return unchanged();
      await tx.customerAccount.update({ where: { id: customerAccountId }, data: { displayName, username, usernameNormalized: username.toLowerCase() } });
    } else if (normalizedStep === 'ADDRESS') {
      const nextAddress = normalizeClaimAddress(mutation);
      const { addressLine1, city, postcode, country, timezone } = nextAddress;
      if (!addressLine1 || !city || !postcode || !/^[A-Z]{2}$/.test(country) || !timezone || addressLine1.length > 200 || city.length > 120 || postcode.length > 32 || timezone.length > 80) throw new Stage1AuthError(400, 'claim_address_invalid', 'A complete address is required');
      const current = await tx.home.findUniqueOrThrow({ where: { id: reservation.claimReference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, addressStatus: true } });
      if (current.addressStatus === 'VERIFIED' || current.addressStatus === 'STAFF_CORRECTED') throw new Stage1AuthError(403, 'claim_staff_required', 'Only authorised staff may correct a registered address');
      if (sameNormalizedAddress(nextAddress, normalizedPersistedAddress(current))) return unchanged();
      await tx.home.update({ where: { id: reservation.claimReference.homeId }, data: { ...nextAddress, addressStatus: 'PENDING_CLAIM', managementRevision: { increment: 1 } } });
      await tx.pendingHomeSetup.update({ where: { reservationId }, data: { retainedAddressRevision: null, retainedAddressDigest: null, retainedAddressConfirmedAt: null, retainedAddressConfirmedByAccountId: null } });
    } else if (normalizedStep === 'ADDRESS_CONFIRMATION') {
      const current = await tx.home.findUniqueOrThrow({ where: { id: reservation.claimReference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, managementRevision: true } });
      const revision = mutation.addressRevision;
      const digest = mutation.addressDigest;
      if (!completeAddress(current) || !Number.isSafeInteger(revision) || revision !== current.managementRevision || typeof digest !== 'string' || digest !== addressDigest(current)) throw new Stage1AuthError(409, 'claim_address_changed', 'The registered address changed; refresh and confirm the current value');
      const pending = await tx.pendingHomeSetup.findUniqueOrThrow({ where: { reservationId }, select: { retainedAddressRevision: true, retainedAddressDigest: true, retainedAddressConfirmedByAccountId: true } });
      if (pending.retainedAddressRevision === revision && pending.retainedAddressDigest === digest && pending.retainedAddressConfirmedByAccountId === customerAccountId) return { id: reservation.id, expiresAt: reservation.expiresAt, setupRevision: reservation.setupRevision };
      await tx.pendingHomeSetup.update({ where: { reservationId }, data: { retainedAddressRevision: current.managementRevision, retainedAddressDigest: digest, retainedAddressConfirmedAt: now, retainedAddressConfirmedByAccountId: customerAccountId } });
    } else {
      // Persist the deployment's server-owned current version, never a
      // caller-selected identifier. The request value is only an equality
      // precondition checked above.
      const existing = await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: authoritativePolicyVersion! } }, select: { id: true } });
      if (existing) return unchanged();
      await tx.policyAcceptance.create({ data: { customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: authoritativePolicyVersion! } });
    }
    if (pendingReconfirmation) return { id: reservation.id, expiresAt: reservation.expiresAt, setupRevision: reservation.setupRevision };
    const updated = await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(now.getTime() + RESERVATION_MS), setupRevision: { increment: 1 }, lastQualifyingMutationAt: now }, select: { id: true, expiresAt: true, setupRevision: true } });
    await tx.pendingHomeSetup.update({ where: { reservationId }, data: { requiredStep: normalizedStep, setupRevision: updated.setupRevision, lastQualifyingMutationAt: now } });
    return updated;
  });
}

export async function completeClaimSetup(reservationId: string, customerAccountId: string) {
  return prisma.$transaction(async (tx) => {
    const claimLookup = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { claimReferenceId: true } });
    if (!claimLookup) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${claimLookup.claimReferenceId}::uuid FOR UPDATE`;
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { id: true, customerAccountId: true, claimReferenceId: true, state: true, expiresAt: true } });
    if (!reservation || reservation.customerAccountId !== customerAccountId || reservation.state !== 'ACTIVE') throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    const reference = await tx.homeClaimReference.findUniqueOrThrow({ where: { id: reservation.claimReferenceId }, select: { homeId: true, state: true } });
    if (reference.state !== 'RESERVED') throw new Stage1AuthError(409, 'claim_unavailable', 'This property claim is unavailable');
    const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId }, select: { status: true, emailVerifiedAt: true } });
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt) throw new Stage1AuthError(403, 'claim_account_unverified', 'An active verified customer account is required');
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${reference.homeId}::uuid FOR UPDATE`;
    // Check the deadline after all serialization locks, immediately before
    // changing the pending authority state.
    const now = new Date();
    if (reservation.expiresAt <= now) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    const pending = await tx.pendingHomeSetup.findUniqueOrThrow({ where: { reservationId }, select: { retainedAddressRevision: true, retainedAddressDigest: true, retainedAddressConfirmedByAccountId: true } });
    const home = await tx.home.findUniqueOrThrow({ where: { id: reference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, managementRevision: true } });
    if (!completeAddress(home) || pending.retainedAddressRevision !== home.managementRevision || pending.retainedAddressDigest !== addressDigest(home) || pending.retainedAddressConfirmedByAccountId !== customerAccountId) throw new Stage1AuthError(409, 'claim_address_confirmation_required', 'Confirm the current registered address before continuing');
    await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { state: 'CONVERTED_TO_PENDING_INSTALLATION', updatedAt: now } });
    await tx.pendingHomeSetup.update({ where: { reservationId }, data: { state: 'PENDING_INSTALLATION', completedAt: now } });
    await tx.homeClaimReference.update({ where: { id: reservation.claimReferenceId }, data: { state: 'PENDING_INSTALLATION', claimedAccountId: customerAccountId, consumedAt: null } });
    await tx.home.update({ where: { id: reference.homeId }, data: { lifecycle: 'PENDING_INSTALLATION' } });
    return { ok: true, state: 'PENDING_INSTALLATION' as const };
  });
}

// Invoked only by the owning installation-completion workflow after its own
// authentication. A pending claim is deliberately not customer authority.
export async function activatePendingInitialClaim(reservationId: string, customerAccountId: string) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const lookup = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { claimReferenceId: true } });
    if (!lookup) throw new Stage1AuthError(409, 'claim_unavailable', 'This property claim is unavailable');
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${lookup.claimReferenceId}::uuid FOR UPDATE`;
    const claim = await tx.homeClaimReference.findUniqueOrThrow({ where: { id: lookup.claimReferenceId }, select: { id: true, homeId: true, hubInstallationId: true, purpose: true, state: true, claimedAccountId: true, consumedAt: true } });
    const reservation = await tx.homeClaimReservation.findUniqueOrThrow({ where: { id: reservationId }, select: { state: true, customerAccountId: true } });
    if (claim.state === 'CONSUMED' && claim.claimedAccountId === customerAccountId && claim.consumedAt && reservation.customerAccountId === customerAccountId && reservation.state === 'CONVERTED_TO_PENDING_INSTALLATION') return { ok: true, state: 'ACTIVE' as const, idempotentReplay: true };
    if (claim.purpose !== 'INITIAL_OWNER' || claim.state !== 'PENDING_INSTALLATION' || claim.consumedAt || claim.claimedAccountId !== customerAccountId || reservation.customerAccountId !== customerAccountId || reservation.state !== 'CONVERTED_TO_PENDING_INSTALLATION') throw new Stage1AuthError(409, 'claim_unavailable', 'This property claim is unavailable');
    const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId }, select: { status: true, emailVerifiedAt: true } });
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt) throw new Stage1AuthError(403, 'claim_account_unverified', 'An active verified customer account is required for owner activation');
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${claim.homeId}::uuid FOR UPDATE`;
    const home = await tx.home.findUniqueOrThrow({ where: { id: claim.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, managementRevision: true, installationStatus: true, activeHubInstallationId: true, lifecycle: true } });
    const hub = await tx.hubInstallation.findUniqueOrThrow({ where: { id: claim.hubInstallationId }, select: { cloudUrl: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, cleanupState: true } });
    const areas = await tx.area.findMany({ where: { homeId: claim.homeId, status: 'ACTIVE' }, select: { id: true, originalName: true, overrideName: true }, orderBy: { id: 'asc' } });
    if (home.installationStatus !== 'COMPLETE' || home.activeHubInstallationId !== claim.hubInstallationId || home.lifecycle !== 'PENDING_INSTALLATION' || !hub.cloudUrl || !hub.cloudUrlVerifiedAt || !hub.remoteVerificationAt || hub.cleanupState === 'WAITING_FOR_HUB' || areas.length === 0 || areas.length > 500) throw new Stage1AuthError(409, 'claim_installation_incomplete', 'Installation and hub security cleanup must complete before owner activation');
    const pending = await tx.pendingHomeSetup.findUniqueOrThrow({ where: { reservationId }, select: { state: true, retainedAddressRevision: true, retainedAddressDigest: true, retainedAddressConfirmedByAccountId: true } });
    if (pending.state !== 'PENDING_INSTALLATION' || !completeAddress(home) || pending.retainedAddressRevision !== home.managementRevision || pending.retainedAddressDigest !== addressDigest(home) || pending.retainedAddressConfirmedByAccountId !== customerAccountId) throw new Stage1AuthError(409, 'claim_address_confirmation_required', 'Confirm the current registered address before activation');
    if (await tx.homeMembership.count({ where: { homeId: claim.homeId, status: 'ACTIVE', role: 'OWNER' } })) throw new Stage1AuthError(409, 'claim_owner_exists', 'This property already has an owner');
    await tx.homeMembership.create({ data: { homeId: claim.homeId, customerAccountId, role: 'OWNER', status: 'ACTIVE' } });
    const columns = Math.ceil(Math.sqrt(areas.length));
    const rows = Math.ceil(areas.length / columns);
    const width = 100 / columns;
    const height = 100 / rows;
    await tx.homeDocument.upsert({ where: { homeId_kind: { homeId: claim.homeId, kind: 'FLOORPLAN' } }, create: { homeId: claim.homeId, kind: 'FLOORPLAN', document: { version: 1, areas: areas.map((area, index) => ({ areaId: area.id, x: (index % columns) * width, y: Math.floor(index / columns) * height, width, height })) }, createdByAccountId: customerAccountId }, update: {} });
    await tx.homeClaimReference.update({ where: { id: claim.id }, data: { state: 'CONSUMED', consumedAt: now } });
    await tx.pendingHomeSetup.update({ where: { reservationId }, data: { state: 'ACTIVATED' } });
    await tx.home.update({ where: { id: claim.homeId }, data: { lifecycle: 'ACTIVE', addressStatus: 'VERIFIED' } });
    await tx.nativeDomainOutbox.create({ data: { homeId: claim.homeId, hubInstallationId: claim.hubInstallationId, aggregateType: 'HomeClaimReference', aggregateId: claim.id, eventType: 'installation_complete', idempotencyKey: `claim-activated:${claim.id}`, payload: { homeId: claim.homeId, accountId: customerAccountId }, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) } });
    return { ok: true, state: 'ACTIVE' as const, idempotentReplay: false };
  }, { isolationLevel: 'Serializable' });
}

export async function releaseExpiredClaim(reservationId: string, manual: { employeeId?: string; reason?: string } = {}, effectiveNow = new Date()) {
  const now = effectiveNow;
  return prisma.$transaction(async (tx) => {
    const original = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { claimReferenceId: true } });
    if (!original) return { released: false };
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${original.claimReferenceId}::uuid FOR UPDATE`;
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { id: true, claimReferenceId: true, customerAccountId: true, state: true, expiresAt: true } });
    if (!reservation || !['ACTIVE'].includes(reservation.state)) return { released: false };
    if (!manual.employeeId && reservation.expiresAt > now) throw new Stage1AuthError(409, 'claim_not_expired', 'The claim reservation is still active');
    if (manual.employeeId && !String(manual.reason || '').trim()) throw new Stage1AuthError(400, 'claim_release_reason_required', 'A reason is required for manual claim release');
    return cleanReleasedReservation(tx, reservation, now, manual);
  });
}
