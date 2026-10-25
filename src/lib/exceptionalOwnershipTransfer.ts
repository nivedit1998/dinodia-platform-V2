import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { currentCustomerPolicy } from './customerPolicyConfig';
import { encryptPlatformEnvelope } from './hubOperatorCredentials';
import { homeownerLifecycleMutationsEnabled } from './homeownerLifecycleAvailability';
import { transferRecipientHash, transferReferenceForClaim } from './homeTransferIdentity';
import { hashClaimReference } from './stage1ClaimContract';
import { sha256 } from './stage1Crypto';
import { Stage1AuthError, type EmployeePrincipal } from './stage1Auth';
import { serializableTransaction } from './serializableTransaction';

const SUBMIT_NS = 'company-exceptional-home-transfer-submit:v1';
const CANCEL_NS = 'company-exceptional-home-transfer-cancel:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RELATIONSHIP_MS = 365 * 24 * 60 * 60 * 1000;

export class ExceptionalTransferDenied extends Error {}

export type ExceptionalTransferInput = {
  proposedIncomingEmail: string;
  reason: string;
  verificationMethod: string;
  verificationReference: string;
  staffAttestation: string;
};

function bounded(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= limit;
}

function normalizeInput(value: ExceptionalTransferInput) {
  const proposedIncomingEmail = typeof value.proposedIncomingEmail === 'string' ? value.proposedIncomingEmail.trim().toLowerCase() : '';
  if (!EMAIL.test(proposedIncomingEmail) || proposedIncomingEmail.length > 320
    || !bounded(value.reason, 1000) || !bounded(value.verificationMethod, 80)
    || !bounded(value.verificationReference, 200) || !bounded(value.staffAttestation, 1000)) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Provide a valid proposed-owner email and all bounded verification, reason and attestation fields');
  }
  return { proposedIncomingEmail, reason: value.reason.trim(), verificationMethod: value.verificationMethod.trim(),
    verificationReference: value.verificationReference.trim(), staffAttestation: value.staffAttestation.trim() };
}

function requireAuthorisedRole(employee: EmployeePrincipal) {
  if (employee.role !== 'CXO' && employee.role !== 'SENIOR_OPERATIONS_MANAGER') {
    throw new Stage1AuthError(403, 'employee_role_denied', 'Only CXO or Senior Operations Manager can use exceptional ownership transfer');
  }
}

async function lockAndRevalidateEmployee(tx: Prisma.TransactionClient, employee: EmployeePrincipal, now: Date) {
  requireAuthorisedRole(employee);
  await tx.$queryRaw`SELECT "id" FROM "CompanyEmployeeAccount" WHERE "id" = ${employee.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "EmployeeSession" WHERE "id" = ${employee.sessionId}::uuid FOR UPDATE`;
  const [account, session] = await Promise.all([
    tx.companyEmployeeAccount.findUnique({ where: { id: employee.id }, select: { id: true, role: true, status: true } }),
    tx.employeeSession.findUnique({ where: { id: employee.sessionId }, select: { id: true, employeeId: true, tokenHash: true, status: true, expiresAt: true, recentAuthenticatedAt: true } }),
  ]);
  if (!account || account.status !== 'ACTIVE' || account.role !== employee.role
    || !session || session.employeeId !== employee.id || session.tokenHash !== employee.tokenHash
    || session.status !== 'ACTIVE' || session.expiresAt <= now
    || session.recentAuthenticatedAt.getTime() < now.getTime() - 5 * 60_000) {
    throw new Stage1AuthError(401, 'recent_authentication_required', 'A current, recently authenticated authorised Company Portal session is required');
  }
}

async function getHomeTransferPreview(tx: Prisma.TransactionClient, homeId: string, email: string) {
  const [home, memberships, recipient, activeTransfer, openCase] = await Promise.all([
    tx.home.findUnique({ where: { id: homeId }, select: { id: true, lifecycle: true, installationStatus: true,
      managementRevision: true, activeHubInstallationId: true, addressLine1: true, addressLine2: true,
      city: true, region: true, postcode: true, country: true, timezone: true,
      areas: { where: { status: 'ACTIVE' }, select: { id: true } },
      devices: { where: { lifecycle: { notIn: ['REMOVED', 'RETIRED'] } }, select: { id: true, managementClass: true } },
      workItems: { where: { state: 'IN_PROGRESS' }, select: { id: true } },
      homeDocuments: { where: { kind: 'FLOORPLAN' }, select: { id: true } },
      hubInstallations: { where: { lifecycleStatus: 'ACTIVE' }, select: { id: true, permanentResolverStatus: true, permanentResolverGeneration: true } },
    } }),
    tx.homeMembership.findMany({ where: { homeId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER', 'TENANT'] } },
      orderBy: [{ role: 'asc' }, { id: 'asc' }], select: { id: true, role: true, accessRevision: true,
        customerAccountId: true, customerAccount: { select: { displayName: true, email: true, emailNormalized: true } } } }),
    tx.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true, status: true } }),
    tx.homeClaimReference.findFirst({ where: { homeId, purpose: 'OWNERSHIP_TRANSFER', state: { in: ['AVAILABLE', 'RESERVED'] },
      cancelledAt: null, revokedAt: null, invalidatedAt: null }, select: { id: true } }),
    tx.exceptionalOwnershipTransfer.findFirst({ where: { homeId, status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED'] } },
      select: { id: true, status: true, revision: true, claimReferenceId: true } }),
  ]);
  const owner = memberships.find((row) => row.role === 'OWNER');
  const managers = memberships.filter((row) => row.role === 'PROPERTY_MANAGER');
  const tenants = memberships.filter((row) => row.role === 'TENANT');
  const hub = home?.hubInstallations.find((row) => row.id === home.activeHubInstallationId);
  const targetIsCurrentOwner = Boolean(recipient && owner?.customerAccountId === recipient.id);
  const targetIsActiveTenant = Boolean(recipient && tenants.some((row) => row.customerAccountId === recipient.id));
  const activeClaim = openCase?.claimReferenceId ? await tx.homeClaimReference.findUnique({ where: { id: openCase.claimReferenceId },
    select: { id: true, state: true, transferRecipientEmailHash: true } }) : null;
  const caseReference = activeClaim?.state === 'AVAILABLE'
    && activeClaim.transferRecipientEmailHash === transferRecipientHash(email)
    ? transferReferenceForClaim(activeClaim.id) : null;
  const policy = currentCustomerPolicy();
  const blockers: string[] = [];
  if (!home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE') blockers.push('HOME_NOT_COMPLETE');
  if (!owner) blockers.push('CURRENT_OWNER_UNAVAILABLE');
  if (targetIsCurrentOwner) blockers.push('CURRENT_OWNER_SUCCESSOR');
  if (!hub || hub.permanentResolverStatus !== 'ACTIVE') blockers.push('CURRENT_HUB_RESOLVER_UNAVAILABLE');
  if (targetIsActiveTenant) blockers.push('ACTIVE_TENANT_SUCCESSOR');
  if (recipient?.status === 'SUSPENDED') blockers.push('PROPOSED_ACCOUNT_SUSPENDED');
  if (activeTransfer) blockers.push('TRANSFER_ALREADY_ACTIVE');
  if (openCase) blockers.push('EXCEPTIONAL_CASE_ALREADY_OPEN');
  if (!policy) blockers.push('CUSTOMER_POLICY_UNAVAILABLE');
  const retainedAddress = home ? [home.addressLine1, home.addressLine2, home.city, home.region, home.postcode, home.country]
    .filter((part): part is string => Boolean(part?.trim())).join(', ') : '';
  const removedRecipients = [owner, ...managers].filter((row): row is NonNullable<typeof row> => Boolean(row)).map((row) => ({
    membershipId: row.id, role: row.role, displayName: row.customerAccount.displayName,
    verifiedEmail: row.customerAccount.email,
  }));
  const cleanupEffects = await Promise.all(removedRecipients.map(async (row) => {
    const relationshipCount = await tx.homeMembership.count({ where: { customerAccountId: memberships.find((m) => m.id === row.membershipId)!.customerAccountId,
      status: 'ACTIVE', homeId: { not: homeId } } });
    return { membershipId: row.membershipId, role: row.role, finalRelationshipWouldBeRemoved: relationshipCount === 0 };
  }));
  return {
    schemaVersion: 'dinodia.v1', ok: true, homeId, managementRevision: home?.managementRevision ?? 0,
    eligible: blockers.length === 0 && homeownerLifecycleMutationsEnabled(),
    actionAvailable: homeownerLifecycleMutationsEnabled(), blockers: homeownerLifecycleMutationsEnabled() ? blockers : [...blockers, 'STAGE_13_LIFECYCLE_REHEARSAL_REQUIRED'],
    proposedIncomingEmail: email,
    home: home ? { lifecycle: home.lifecycle, installationStatus: home.installationStatus, retainedAddress: retainedAddress || null,
      retainsTimezone: Boolean(home.timezone), activeAreaCount: home.areas.length,
      permanentDevicesPreserved: home.devices.filter((row) => row.managementClass === 'PROPERTY_DEVICE').length,
      privateDevicesRemoved: home.devices.filter((row) => row.managementClass === 'TENANT_DEVICE').length,
      floorplanRegeneratedForSuccessor: home.homeDocuments.length > 0,
      inProgressInstallationWorkPreserved: home.workItems.length } : null,
    currentOwner: owner ? { membershipId: owner.id, displayName: owner.customerAccount.displayName, email: owner.customerAccount.email } : null,
    removedManagers: managers.map((row) => ({ membershipId: row.id, displayName: row.customerAccount.displayName, email: row.customerAccount.email })),
    notificationRecipients: removedRecipients,
    activeCase: openCase ? { caseId: openCase.id, status: openCase.status, revision: openCase.revision,
      claimReferenceId: openCase.claimReferenceId, transferReference: caseReference } : null,
    currentOwnerSuccessorRejected: targetIsCurrentOwner,
    activeTenantSuccessorRejected: targetIsActiveTenant,
    cleanupEffects,
    preserved: { activeTenantMemberships: tenants.length, canonicalAreas: home?.areas.length ?? 0,
      permanentDevices: home?.devices.filter((row) => row.managementClass === 'PROPERTY_DEVICE').length ?? 0,
      floorplanAndPresentation: true, hubAndTunnel: true, inProgressInstallationWork: home?.workItems.length ?? 0 },
  };
}

export async function previewExceptionalOwnershipTransfer(input: { homeId: string; proposedIncomingEmail: string; employee: EmployeePrincipal }) {
  requireAuthorisedRole(input.employee);
  if (!UUID.test(input.homeId)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid Home is required');
  const email = normalizeInput({ proposedIncomingEmail: input.proposedIncomingEmail, reason: 'Preview only',
    verificationMethod: 'Preview only', verificationReference: 'Preview only', staffAttestation: 'Preview only' }).proposedIncomingEmail;
  return serializableTransaction(async (tx) => {
    const now = new Date();
    await lockAndRevalidateEmployee(tx, input.employee, now);
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR SHARE`;
    const preview = await getHomeTransferPreview(tx, input.homeId, email);
    await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'EMPLOYEE', actorId: input.employee.id,
      category: 'SECURITY', action: 'exceptional_transfer_previewed', targetType: 'Home', targetId: input.homeId,
      metadata: { outcome: preview.eligible ? 'eligible' : 'blocked', proposedRecipientHash: transferRecipientHash(email),
        managementRevision: preview.managementRevision, blockerCount: preview.blockers.length },
      purgeAt: new Date(now.getTime() + RELATIONSHIP_MS) } });
    return preview;
  });
}

export async function submitExceptionalOwnershipTransfer(input: {
  homeId: string; employee: EmployeePrincipal; proposedIncomingEmail: string; expectedManagementRevision: number;
  reason: string; verificationMethod: string; verificationReference: string; staffAttestation: string; idempotencyKey: string;
}) {
  requireAuthorisedRole(input.employee);
  const values = normalizeInput(input);
  if (!UUID.test(input.homeId) || !Number.isSafeInteger(input.expectedManagementRevision) || input.expectedManagementRevision < 1
    || !/^[A-Za-z0-9._:-]{16,160}$/.test(input.idempotencyKey)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current Home revision and idempotency key are required');
  if (!homeownerLifecycleMutationsEnabled()) throw new Stage1AuthError(503, 'FEATURE_NOT_ENABLED', 'Exceptional transfer is unavailable until the lifecycle safety rehearsal is released');
  const recipientHash = transferRecipientHash(values.proposedIncomingEmail);
  const keyHash = sha256(`exceptional-transfer:${input.employee.id}:${input.homeId}:${input.idempotencyKey}`);
  const requestHash = sha256(JSON.stringify({ homeId: input.homeId, recipientHash, expectedManagementRevision: input.expectedManagementRevision,
    reason: values.reason, verificationMethod: values.verificationMethod, verificationReference: values.verificationReference,
    staffAttestation: values.staffAttestation }));
  const encryptedEmail = JSON.stringify(encryptPlatformEnvelope(values.proposedIncomingEmail));
  const result = await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR UPDATE`;
    const now = new Date();
    await lockAndRevalidateEmployee(tx, input.employee, now);
    const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: SUBMIT_NS, keyHash } },
      select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
    if (prior) {
      if (prior.actorId !== input.employee.id || prior.homeId !== input.homeId || prior.requestHash !== requestHash
        || prior.expiresAt <= now || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)) {
        throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This Company Portal request key was already used for another transfer');
      }
      const body = prior.responseBody as Record<string, unknown>;
      const caseId = String(body.caseId ?? ''); const claimId = String(body.claimId ?? '');
      if (!UUID.test(caseId) || !UUID.test(claimId)) throw new Stage1AuthError(409, 'TRANSFER_UNAVAILABLE', 'The original transfer result is no longer available');
      return { caseId, claimId, revision: Number(body.revision), state: String(body.state), replay: true };
    }
    const preview = await getHomeTransferPreview(tx, input.homeId, values.proposedIncomingEmail);
    if (preview.managementRevision !== input.expectedManagementRevision || !preview.actionAvailable || preview.blockers.length > 0) {
      throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The Home, recipient or transfer eligibility changed. Refresh the read-only preview.');
    }
    const owner = await tx.homeMembership.findFirst({ where: { homeId: input.homeId, status: 'ACTIVE', role: 'OWNER' },
      select: { id: true, customerAccountId: true } });
    const home = await tx.home.findUniqueOrThrow({ where: { id: input.homeId }, select: { id: true, lifecycle: true,
      installationStatus: true, managementRevision: true, activeHubInstallationId: true } });
    const hub = home.activeHubInstallationId ? await tx.hubInstallation.findFirst({ where: { id: home.activeHubInstallationId,
      homeId: home.id, lifecycleStatus: 'ACTIVE', permanentResolverStatus: 'ACTIVE' }, select: { id: true,
      permanentResolverGeneration: true } }) : null;
    if (!owner || !hub || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE'
      || home.managementRevision !== input.expectedManagementRevision) {
      throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The current owner, completed Home or hub resolver changed');
    }
    const maxGeneration = await tx.homeClaimReference.aggregate({ where: { hubInstallationId: hub.id }, _max: { generation: true } });
    const claimId = crypto.randomUUID();
    const reference = transferReferenceForClaim(claimId);
    const referenceHash = hashClaimReference(reference);
    const nowAgain = new Date();
    const created = await tx.exceptionalOwnershipTransfer.create({ data: {
      homeId: home.id, outgoingOwnerMembershipId: owner.id, createdByEmployeeId: input.employee.id,
      proposedIncomingEmailCiphertext: encryptedEmail, contactKeyVersion: 1, reason: values.reason,
      verificationMethod: values.verificationMethod, verificationReference: values.verificationReference,
      staffAttestation: values.staffAttestation, status: 'SUBMITTED', submittedAt: nowAgain,
    }, select: { id: true, revision: true } });
    await tx.homeClaimReference.create({ data: {
      id: claimId, homeId: home.id, hubInstallationId: hub.id, purpose: 'OWNERSHIP_TRANSFER',
      generation: Number(maxGeneration._max.generation ?? 0) + 1, state: 'AVAILABLE',
      companyQrReferenceHash: referenceHash, transferCodeHash: referenceHash,
      transferRecipientEmailHash: recipientHash, transferRecipientEmail: null,
      resolverGeneration: hub.permanentResolverGeneration, outgoingOwnerMembershipId: owner.id,
      auditReference: `exceptional:${sha256(`${input.employee.id}:${created.id}`).slice(0, 64)}`, issuedAt: nowAgain,
    } });
    await tx.exceptionalOwnershipTransfer.update({ where: { id: created.id }, data: { claimReferenceId: claimId } });
    const safeReceipt = { caseId: created.id, claimId, revision: created.revision, state: 'SUBMITTED' };
    await tx.idempotencyRecord.create({ data: { namespace: SUBMIT_NS, keyHash, actorId: input.employee.id, homeId: home.id,
      hubInstallationId: hub.id, requestHash, responseStatus: 202, responseDigest: sha256(JSON.stringify(safeReceipt)),
      responseBody: safeReceipt as Prisma.InputJsonValue, expiresAt: new Date(nowAgain.getTime() + 30 * 24 * 60 * 60 * 1000) } });
    await tx.auditEvent.create({ data: { homeId: home.id, actorType: 'EMPLOYEE', actorId: input.employee.id,
      category: 'SECURITY', action: 'exceptional_transfer_submitted', targetType: 'ExceptionalOwnershipTransfer',
      targetId: created.id, metadata: { outcome: 'submitted', proposedRecipientHash: recipientHash,
        claimReferenceId: claimId, ownershipMutated: false, managementRevision: home.managementRevision },
      purgeAt: new Date(nowAgain.getTime() + RELATIONSHIP_MS) } });
    await tx.auditEvent.create({ data: { homeId: home.id, actorType: 'EMPLOYEE', actorId: input.employee.id,
      category: 'SECURITY', action: 'exceptional_transfer_claim_issued', targetType: 'HomeClaimReference',
      targetId: claimId, metadata: { outcome: 'issued_for_normal_transfer_claim', caseId: created.id,
        recipientHash, oneUse: true }, purgeAt: new Date(nowAgain.getTime() + RELATIONSHIP_MS) } });
    return { ...safeReceipt, replay: false };
  });
  return { schemaVersion: 'dinodia.v1', ok: true, homeId: input.homeId, caseId: result.caseId,
    claimReferenceId: result.claimId, state: result.state, revision: result.revision,
    transferReference: transferReferenceForClaim(result.claimId), idempotentReplay: result.replay,
    incomingOwnerNotNotified: true, ownershipChanged: false };
}

export async function cancelExceptionalOwnershipTransfer(input: {
  homeId: string; caseId: string; expectedRevision: number; idempotencyKey: string; employee: EmployeePrincipal;
}) {
  requireAuthorisedRole(input.employee);
  if (!UUID.test(input.homeId) || !UUID.test(input.caseId) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1 || !/^[A-Za-z0-9._:-]{16,160}$/.test(input.idempotencyKey)) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current case revision and idempotency key are required');
  }
  const keyHash = sha256(`exceptional-transfer-cancel:${input.employee.id}:${input.homeId}:${input.idempotencyKey}`);
  const requestHash = sha256(JSON.stringify({ homeId: input.homeId, caseId: input.caseId, expectedRevision: input.expectedRevision }));
  return serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR UPDATE`;
    const now = new Date();
    await lockAndRevalidateEmployee(tx, input.employee, now);
    const previous = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: CANCEL_NS, keyHash } },
      select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
    if (previous) {
      if (previous.actorId !== input.employee.id || previous.homeId !== input.homeId || previous.requestHash !== requestHash
        || previous.expiresAt <= now || !previous.responseBody || typeof previous.responseBody !== 'object' || Array.isArray(previous.responseBody)) {
        throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This cancellation key was already used for another request');
      }
      return { ...(previous.responseBody as Record<string, unknown>), idempotentReplay: true };
    }
    await tx.$queryRaw`SELECT "id" FROM "ExceptionalOwnershipTransfer" WHERE "id" = ${input.caseId}::uuid FOR UPDATE`;
    const caseRow = await tx.exceptionalOwnershipTransfer.findFirst({ where: { id: input.caseId, homeId: input.homeId },
      select: { id: true, status: true, revision: true, claimReferenceId: true } });
    if (!caseRow || !caseRow.claimReferenceId || caseRow.revision !== input.expectedRevision
      || !['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'].includes(caseRow.status)) {
      throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The exceptional transfer changed or is no longer cancellable');
    }
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${caseRow.claimReferenceId}::uuid FOR UPDATE`;
    const claim = await tx.homeClaimReference.findUnique({ where: { id: caseRow.claimReferenceId },
      select: { id: true, state: true, transferCodeHash: true, transferRecipientEmailHash: true } });
    if (!claim || claim.state !== 'AVAILABLE') throw new Stage1AuthError(409, 'TRANSFER_ALREADY_CLAIMED', 'A transfer already in progress cannot be cancelled');
    await tx.exceptionalOwnershipTransfer.update({ where: { id: caseRow.id }, data: {
      status: 'CANCELLED', cancelledAt: now, decidedAt: now, revision: { increment: 1 },
    } });
    await tx.homeClaimReference.update({ where: { id: claim.id }, data: { state: 'CANCELLED', cancelledAt: now,
      invalidatedAt: now, transferCodeHash: null, transferRecipientEmail: null, transferRecipientEmailHash: null } });
    await tx.homeClaimChallenge.updateMany({ where: { claimReferenceId: claim.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, homeId: input.homeId, caseId: caseRow.id,
      state: 'CANCELLED', revision: caseRow.revision + 1, idempotentReplay: false };
    await tx.idempotencyRecord.create({ data: { namespace: CANCEL_NS, keyHash, actorId: input.employee.id,
      homeId: input.homeId, requestHash, responseStatus: 200, responseDigest: sha256(JSON.stringify(receipt)),
      responseBody: receipt as Prisma.InputJsonValue, expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } });
    await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'EMPLOYEE', actorId: input.employee.id,
      category: 'SECURITY', action: 'exceptional_transfer_cancelled', targetType: 'ExceptionalOwnershipTransfer',
      targetId: caseRow.id, metadata: { outcome: 'cancelled', revision: caseRow.revision + 1,
        claimInvalidated: true, recipientHash: claim.transferRecipientEmailHash },
      purgeAt: new Date(now.getTime() + RELATIONSHIP_MS) } });
    return receipt;
  });
}
