import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { Stage1AuthError, type CustomerAccountSessionPrincipal } from './stage1Auth';
import { consumeSignedClaimResolverProof } from './stage1ClaimResolver';
import { starterFloorplan } from './homeFloorplan';
import { serializableTransaction } from './serializableTransaction';

const RESERVATION_MS = 30 * 60 * 1000;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export type ClaimTransaction = Prisma.TransactionClient;

export async function assertClaimSessionCurrent(tx: ClaimTransaction, principal?: CustomerAccountSessionPrincipal): Promise<void> {
  if (!principal) return;
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${principal.trustedDeviceId}::uuid FOR UPDATE`;
  const now = new Date();
  const [account, session, device] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, securityVersion: true } }),
    tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
    tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
  ]);
  const credentialCurrent = principal.credentialKind === 'access'
    ? Boolean(principal.accessTokenHash && session?.accessTokenHash === principal.accessTokenHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
    : session?.refreshTokenHash === principal.refreshTokenHash;
  if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword
    || account.securityVersion !== principal.securityVersion || !session || session.customerAccountId !== account.id
    || session.id !== principal.sessionId || session.trustedDeviceId !== principal.trustedDeviceId || !credentialCurrent
    || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== principal.trustedDeviceSessionVersion
    || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
    || !device || device.customerAccountId !== account.id || device.revokedAt
    || device.sessionVersion !== session.trustedDeviceSessionVersion) {
    throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
  }
}

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

export async function readClaimAddressContract(reservationId: string, customerAccountId: string, principal?: CustomerAccountSessionPrincipal) {
  return prisma.$transaction(async (tx) => {
    await assertClaimSessionCurrent(tx, principal);
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { customerAccountId: true, state: true, expiresAt: true, claimReference: { select: { homeId: true } } } });
    if (!reservation || reservation.customerAccountId !== customerAccountId || (reservation.state !== 'ACTIVE' && reservation.state !== 'CONVERTED_TO_PENDING_INSTALLATION') || (reservation.state === 'ACTIVE' && reservation.expiresAt <= new Date())) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    const address = await tx.home.findUniqueOrThrow({ where: { id: reservation.claimReference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, managementRevision: true } });
    return { addressLine1: address.addressLine1, addressLine2: address.addressLine2, city: address.city, region: address.region, postcode: address.postcode, country: address.country, timezone: address.timezone, addressRevision: address.managementRevision, addressDigest: addressDigest(address) };
  });
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

export async function redeemClaimContract(input: { reference: string; customerAccountId: string; emailVerified: boolean; principal?: CustomerAccountSessionPrincipal; resolverProof?: Record<string, unknown> }) {
  if (input.principal && input.principal.id !== input.customerAccountId) throw new Stage1AuthError(403, 'claim_account_mismatch', 'The signed-in account does not match this claim');
  if (!input.emailVerified) throw new Stage1AuthError(403, 'claim_email_unverified', 'Email verification is required before a claim can be reserved');
  const usesPermanentLabel = input.resolverProof !== undefined;
  const qrReference = /^dno_home_[A-Za-z0-9_-]{40,64}$/.test(input.reference);
  const permanentLabel = /^DNO-HOME-[A-Za-z0-9_-]{32,64}$/.test(input.reference);
  if (!(qrReference && !usesPermanentLabel) && !(permanentLabel && usesPermanentLabel)) throw new Stage1AuthError(400, 'claim_reference_invalid', 'A current Home QR or verified local hub label is required');
  const result = await serializableTransaction(async (tx) => {
    await assertClaimSessionCurrent(tx, input.principal);
    let resolvedClaimId: string | null = null;
    if (usesPermanentLabel) {
      const resolved = await consumeSignedClaimResolverProof(tx, input.resolverProof!, { purpose: 'INITIAL_OWNER' });
      resolvedClaimId = resolved.claimReferenceId;
    } else {
      // Serialize all QR claim attempts for the same physical reference. This
      // is the database-level first-wins rule; application-side checks race.
      await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "companyQrReferenceHash" = ${hashClaimReference(input.reference)} FOR UPDATE`;
    }
    // Expiry is evaluated only after the serialization lock. A request queued
    // before expiresAt cannot redeem the reservation using stale request time.
    const now = new Date();
    const reference = resolvedClaimId
      ? await tx.homeClaimReference.findUnique({ where: { id: resolvedClaimId }, select: { id: true, homeId: true, hubInstallationId: true, state: true, generation: true, purpose: true } })
      : await tx.homeClaimReference.findUnique({ where: { companyQrReferenceHash: hashClaimReference(input.reference) }, select: { id: true, homeId: true, hubInstallationId: true, state: true, generation: true, purpose: true } });
    if (!reference || reference.purpose !== 'INITIAL_OWNER' || !['AVAILABLE', 'RESERVED'].includes(reference.state)) throw new Stage1AuthError(409, 'claim_unavailable', 'This property claim is unavailable');
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

export async function recordQualifyingClaimMutation(reservationId: string, customerAccountId: string, step: string, mutation: Record<string, unknown> = {}, principal?: CustomerAccountSessionPrincipal, expectedSetupRevision?: number) {
  const normalizedStep = String(step).toUpperCase();
  if (!['PROFILE', 'ADDRESS', 'ADDRESS_CONFIRMATION', 'POLICY'].includes(normalizedStep)) throw new Stage1AuthError(400, 'claim_step_invalid', 'The setup step is not a qualifying persisted setup mutation');
  const requestedPolicyVersion = normalizedStep === 'POLICY' && typeof mutation.policyVersion === 'string' ? mutation.policyVersion.trim() : null;
  if (normalizedStep === 'POLICY' && (!requestedPolicyVersion || !POLICY_VERSION_PATTERN.test(requestedPolicyVersion))) throw new Stage1AuthError(400, 'claim_policy_invalid', 'A valid policy version is required');
  const authoritativePolicyVersion = normalizedStep === 'POLICY' ? currentNativePolicyVersion() : null;
  if (normalizedStep === 'POLICY' && requestedPolicyVersion !== authoritativePolicyVersion) throw new Stage1AuthError(409, 'claim_policy_stale', 'The accepted policy version is no longer current');
  return prisma.$transaction(async (tx) => {
    await assertClaimSessionCurrent(tx, principal);
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
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: {
      id: true, customerAccountId: true, state: true, expiresAt: true, claimReferenceId: true, setupRevision: true,
      claimReference: { select: { homeId: true } },
      pendingSetup: { select: { state: true, requiredStep: true, retainedAddressRevision: true, retainedAddressDigest: true, retainedAddressConfirmedByAccountId: true } },
    } });
    const pendingReconfirmation = normalizedStep === 'ADDRESS_CONFIRMATION' && reservation?.state === 'CONVERTED_TO_PENDING_INSTALLATION';
    if (!reservation || reservation.customerAccountId !== customerAccountId || (!pendingReconfirmation && (reservation.state !== 'ACTIVE' || reservation.expiresAt <= now))) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    const unchanged = () => ({ id: reservation.id, expiresAt: reservation.expiresAt, setupRevision: reservation.setupRevision });
    const currentStep = reservation.pendingSetup?.requiredStep;
    const staleStep = () => { throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and continue with the current step'); };
    const advanceWithoutDeadline = async (requiredStep: string, state: 'ADDRESS_REQUIRED'|'POLICY_REQUIRED') => {
      if (expectedSetupRevision !== undefined && reservation.setupRevision !== expectedSetupRevision) staleStep();
      const updated = await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { setupRevision: { increment: 1 } }, select: { id: true, expiresAt: true, setupRevision: true } });
      await tx.pendingHomeSetup.update({ where: { reservationId }, data: { state, requiredStep, setupRevision: updated.setupRevision } });
      return updated;
    };
    if (normalizedStep === 'PROFILE') {
      const displayName = String(mutation.displayName ?? '').trim();
      const username = String(mutation.username ?? '').trim();
      if (!displayName || !username || displayName.length > 160 || username.length > 80) throw new Stage1AuthError(400, 'claim_profile_invalid', 'A saved display name and username are required');
      const current = await tx.customerAccount.findUnique({ where: { id: customerAccountId }, select: { displayName: true, username: true, usernameNormalized: true } });
      if (!current) throw new Stage1AuthError(404, 'claim_account_missing', 'The customer account does not exist');
      const profileUnchanged = current.displayName.trim() === displayName && current.usernameNormalized === username.toLowerCase();
      if (profileUnchanged) {
        // A complete profile already present at registration satisfies the
        // initial profile step. Record only the setup-step transition: do not
        // update account data or slide the reservation deadline. Once the
        // flow has advanced, a normalized retry remains a strict no-op.
        if (currentStep === 'PROFILE') return advanceWithoutDeadline('ADDRESS', 'ADDRESS_REQUIRED');
        if (['ADDRESS', 'ADDRESS_CONFIRMATION', 'POLICY'].includes(String(currentStep))) return unchanged();
        return staleStep();
      }
      if (!currentStep) return staleStep();
      if (expectedSetupRevision !== undefined && reservation.setupRevision !== expectedSetupRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and try again');
      await tx.customerAccount.update({ where: { id: customerAccountId }, data: { displayName, username, usernameNormalized: username.toLowerCase() } });
    } else if (normalizedStep === 'ADDRESS') {
      const nextAddress = normalizeClaimAddress(mutation);
      const { addressLine1, city, postcode, country, timezone } = nextAddress;
      if (!addressLine1 || !city || !postcode || !/^[A-Z]{2}$/.test(country) || !timezone || addressLine1.length > 200 || city.length > 120 || postcode.length > 32 || timezone.length > 80) throw new Stage1AuthError(400, 'claim_address_invalid', 'A complete address is required');
      const current = await tx.home.findUniqueOrThrow({ where: { id: reservation.claimReference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, addressStatus: true } });
      const addressUnchanged = sameNormalizedAddress(nextAddress, normalizedPersistedAddress(current));
      if (current.addressStatus === 'VERIFIED' || current.addressStatus === 'STAFF_CORRECTED') {
        if (addressUnchanged && currentStep === 'ADDRESS') return advanceWithoutDeadline('ADDRESS_CONFIRMATION', 'ADDRESS_REQUIRED');
        if (addressUnchanged && ['ADDRESS_CONFIRMATION', 'POLICY'].includes(String(currentStep))) return unchanged();
        throw new Stage1AuthError(403, 'claim_staff_required', 'Only authorised staff may correct a registered address');
      }
      if (currentStep !== 'ADDRESS') {
        if (addressUnchanged && ['ADDRESS_CONFIRMATION', 'POLICY'].includes(String(currentStep))) return unchanged();
        // A customer may revise an unverified address after confirming it;
        // the normal mutation below invalidates the prior confirmation and
        // returns the wizard to ADDRESS_CONFIRMATION. Do not regress to the
        // address-entry step or permit edits to staff-verified addresses.
        if (!['ADDRESS_CONFIRMATION', 'POLICY'].includes(String(currentStep))) return staleStep();
      }
      if (addressUnchanged) return advanceWithoutDeadline('ADDRESS_CONFIRMATION', 'ADDRESS_REQUIRED');
      if (expectedSetupRevision !== undefined && reservation.setupRevision !== expectedSetupRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and try again');
      await tx.home.update({ where: { id: reservation.claimReference.homeId }, data: { ...nextAddress, addressStatus: 'PENDING_CLAIM', managementRevision: { increment: 1 } } });
      await tx.pendingHomeSetup.update({ where: { reservationId }, data: { retainedAddressRevision: null, retainedAddressDigest: null, retainedAddressConfirmedAt: null, retainedAddressConfirmedByAccountId: null } });
    } else if (normalizedStep === 'ADDRESS_CONFIRMATION') {
      const current = await tx.home.findUniqueOrThrow({ where: { id: reservation.claimReference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, managementRevision: true } });
      const revision = mutation.addressRevision;
      const digest = mutation.addressDigest;
      if (!completeAddress(current) || !Number.isSafeInteger(revision) || revision !== current.managementRevision || typeof digest !== 'string' || digest !== addressDigest(current)) throw new Stage1AuthError(409, 'claim_address_changed', 'The registered address changed; refresh and confirm the current value');
      const pending = reservation.pendingSetup;
      if (!pending) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
      const alreadyConfirmed = pending.retainedAddressRevision === revision && pending.retainedAddressDigest === digest && pending.retainedAddressConfirmedByAccountId === customerAccountId;
      if (alreadyConfirmed) return { id: reservation.id, expiresAt: reservation.expiresAt, setupRevision: reservation.setupRevision };
      const staffCorrectionNeedsReconfirmation = currentStep === 'POLICY'
        && (pending.retainedAddressRevision !== current.managementRevision || pending.retainedAddressDigest !== digest || pending.retainedAddressConfirmedByAccountId !== customerAccountId);
      if (!pendingReconfirmation && currentStep !== 'ADDRESS_CONFIRMATION' && !staffCorrectionNeedsReconfirmation) return staleStep();
      if (expectedSetupRevision !== undefined && reservation.setupRevision !== expectedSetupRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and try again');
      await tx.pendingHomeSetup.update({ where: { reservationId }, data: { retainedAddressRevision: current.managementRevision, retainedAddressDigest: digest, retainedAddressConfirmedAt: now, retainedAddressConfirmedByAccountId: customerAccountId } });
    } else {
      // Persist the deployment's server-owned current version, never a
      // caller-selected identifier. The request value is only an equality
      // precondition checked above.
      const existing = await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: authoritativePolicyVersion! } }, select: { id: true } });
      if (existing) return unchanged();
      if (currentStep !== 'POLICY') return staleStep();
      if (expectedSetupRevision !== undefined && reservation.setupRevision !== expectedSetupRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and try again');
      await tx.policyAcceptance.create({ data: { customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: authoritativePolicyVersion! } });
    }
    if (pendingReconfirmation) return { id: reservation.id, expiresAt: reservation.expiresAt, setupRevision: reservation.setupRevision };
    const updated = await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(now.getTime() + RESERVATION_MS), setupRevision: { increment: 1 }, lastQualifyingMutationAt: now }, select: { id: true, expiresAt: true, setupRevision: true } });
    // A profile correction remains a valid qualifying edit after the wizard
    // has advanced, but it must not regress the customer to an earlier step.
    const nextStep = normalizedStep === 'ADDRESS' ? 'ADDRESS_CONFIRMATION'
      : normalizedStep === 'ADDRESS_CONFIRMATION' ? 'POLICY'
      : normalizedStep === 'POLICY' ? 'POLICY'
      : currentStep === 'PROFILE' ? 'ADDRESS'
      : currentStep;
    const nextState = nextStep === 'PROFILE' ? 'PROFILE_REQUIRED'
      : nextStep === 'POLICY' ? 'POLICY_REQUIRED'
      : 'ADDRESS_REQUIRED';
    await tx.pendingHomeSetup.update({ where: { reservationId }, data: { state: nextState, requiredStep: nextStep, setupRevision: updated.setupRevision, lastQualifyingMutationAt: now } });
    return updated;
  });
}

export async function completeClaimSetup(reservationId: string, customerAccountId: string, principal?: CustomerAccountSessionPrincipal, expectedSetupRevision?: number) {
  return prisma.$transaction(async (tx) => {
    await assertClaimSessionCurrent(tx, principal);
    const claimLookup = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { claimReferenceId: true } });
    if (!claimLookup) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${claimLookup.claimReferenceId}::uuid FOR UPDATE`;
    const reservation = await tx.homeClaimReservation.findUnique({ where: { id: reservationId }, select: { id: true, customerAccountId: true, claimReferenceId: true, state: true, expiresAt: true } });
    if (!reservation || reservation.customerAccountId !== customerAccountId) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    const reference = await tx.homeClaimReference.findUniqueOrThrow({ where: { id: reservation.claimReferenceId }, select: { homeId: true, hubInstallationId: true, state: true, claimedAccountId: true, consumedAt: true } });
    const pending = await tx.pendingHomeSetup.findUniqueOrThrow({ where: { reservationId }, select: { state: true, requiredStep: true, setupRevision: true, retainedAddressRevision: true, retainedAddressDigest: true, retainedAddressConfirmedByAccountId: true } });
    if (expectedSetupRevision !== undefined && pending.setupRevision !== expectedSetupRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The setup changed; refresh and try again');
    if (reservation.state === 'CONVERTED_TO_PENDING_INSTALLATION' && pending.state === 'ACTIVATED' && reference.state === 'CONSUMED' && reference.claimedAccountId === customerAccountId && reference.consumedAt) {
      return { ok: true, state: 'ACTIVE' as const, idempotentReplay: true };
    }
    if (reservation.state === 'CONVERTED_TO_PENDING_INSTALLATION' && pending.state === 'PENDING_INSTALLATION' && reference.state === 'PENDING_INSTALLATION') {
      return { ok: true, state: 'PENDING_INSTALLATION' as const, idempotentReplay: true };
    }
    if (reservation.state !== 'ACTIVE' || reference.state !== 'RESERVED') throw new Stage1AuthError(409, 'claim_unavailable', 'This property claim is unavailable');
    if (pending.state !== 'POLICY_REQUIRED' || pending.requiredStep !== 'POLICY') throw new Stage1AuthError(409, 'claim_setup_incomplete', 'Complete the current Home setup steps before continuing');
    const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId }, select: { status: true, emailVerifiedAt: true } });
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt) throw new Stage1AuthError(403, 'claim_account_unverified', 'An active verified customer account is required');
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${reference.homeId}::uuid FOR UPDATE`;
    // Check the deadline after all serialization locks, immediately before
    // changing the pending authority state.
    const now = new Date();
    if (reservation.expiresAt <= now) throw new Stage1AuthError(409, 'claim_reservation_expired', 'The setup reservation has expired');
    // Completion is still only a pending, ownerless claim, but it must not
    // bypass the account-global policy gate. Resolve the policy version from
    // server configuration after the claim/Home locks, then require that exact
    // version to have been accepted by this verified account.
    const policyVersion = currentNativePolicyVersion();
    const policyAcceptance = await tx.policyAcceptance.findUnique({
      where: { customerAccountId_policyKind_policyVersion: { customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion } },
      select: { id: true },
    });
    if (!policyAcceptance) throw new Stage1AuthError(409, 'claim_policy_required', 'Accept the current customer policy before completing Home setup');
    const home = await tx.home.findUniqueOrThrow({ where: { id: reference.homeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, managementRevision: true, installationStatus: true, activeHubInstallationId: true, lifecycle: true } });
    if (!completeAddress(home) || pending.retainedAddressRevision !== home.managementRevision || pending.retainedAddressDigest !== addressDigest(home) || pending.retainedAddressConfirmedByAccountId !== customerAccountId) throw new Stage1AuthError(409, 'claim_address_confirmation_required', 'Confirm the current registered address before continuing');
    if (home.installationStatus === 'COMPLETE') {
      const [hub, areas, existingOwnerCount] = await Promise.all([
        tx.hubInstallation.findUnique({ where: { id: reference.hubInstallationId }, select: { id: true, state: true, cloudUrl: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, cleanupState: true } }),
        tx.area.findMany({ where: { homeId: reference.homeId, status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } }),
        tx.homeMembership.count({ where: { homeId: reference.homeId, status: 'ACTIVE', role: 'OWNER' } }),
      ]);
      if (!hub || hub.id !== home.activeHubInstallationId || hub.state !== 'ACTIVE' || !hub.cloudUrl || !hub.cloudUrlVerifiedAt || !hub.remoteVerificationAt
        || hub.cleanupState === 'WAITING_FOR_HUB' || !areas.length || areas.length > 500 || home.lifecycle !== 'CLAIM_RESERVED' || existingOwnerCount) {
        throw new Stage1AuthError(409, 'claim_installation_incomplete', 'The completed installation is not yet eligible for owner activation');
      }
      await tx.homeMembership.create({ data: { homeId: reference.homeId, customerAccountId, role: 'OWNER', status: 'ACTIVE' } });
      // A Home that already has a plan keeps it (update is empty); only a Home with none gets a starter layout.
      await tx.homeDocument.upsert({ where: { homeId_kind: { homeId: reference.homeId, kind: 'FLOORPLAN' } },
        create: { homeId: reference.homeId, kind: 'FLOORPLAN', document: { version: 1, areas: starterFloorplan(areas.map((area) => area.id)) }, createdByAccountId: customerAccountId }, update: {} });
      await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { state: 'CONVERTED_TO_PENDING_INSTALLATION', updatedAt: now } });
      // requiredStep is non-null in the durable row. The customer projection
      // deliberately maps an ACTIVATED setup to no next step.
      await tx.pendingHomeSetup.update({ where: { reservationId }, data: { state: 'ACTIVATED', requiredStep: 'COMPLETE', completedAt: now } });
      await tx.homeClaimReference.update({ where: { id: reservation.claimReferenceId }, data: { state: 'CONSUMED', claimedAccountId: customerAccountId, consumedAt: now } });
      await tx.home.update({ where: { id: reference.homeId }, data: { lifecycle: 'ACTIVE', addressStatus: 'VERIFIED' } });
      await tx.nativeDomainOutbox.create({ data: { homeId: reference.homeId, hubInstallationId: hub.id, aggregateType: 'HomeClaimReference', aggregateId: reservation.claimReferenceId, eventType: 'installation_complete', idempotencyKey: `claim-activated:${reservation.claimReferenceId}`, payload: { homeId: reference.homeId, accountId: customerAccountId }, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) } });
      return { ok: true, state: 'ACTIVE' as const, idempotentReplay: false };
    }
    await tx.homeClaimReservation.update({ where: { id: reservation.id }, data: { state: 'CONVERTED_TO_PENDING_INSTALLATION', updatedAt: now } });
    await tx.pendingHomeSetup.update({ where: { reservationId }, data: { state: 'PENDING_INSTALLATION', requiredStep: 'INSTALLATION_PENDING', completedAt: now } });
    await tx.homeClaimReference.update({ where: { id: reservation.claimReferenceId }, data: { state: 'PENDING_INSTALLATION', claimedAccountId: customerAccountId, consumedAt: null } });
    await tx.home.update({ where: { id: reference.homeId }, data: { lifecycle: 'PENDING_INSTALLATION' } });
    return { ok: true, state: 'PENDING_INSTALLATION' as const, idempotentReplay: false };
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
    // A Home that already has a plan keeps it (update is empty); only a Home with none gets a starter layout.
    await tx.homeDocument.upsert({ where: { homeId_kind: { homeId: claim.homeId, kind: 'FLOORPLAN' } },
      create: { homeId: claim.homeId, kind: 'FLOORPLAN', document: { version: 1, areas: starterFloorplan(areas.map((area) => area.id)) }, createdByAccountId: customerAccountId }, update: {} });
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
