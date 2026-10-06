import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { sendCustomerAuthEmail } from '@/lib/customerAuthEmail';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { hashClaimReference } from '@/lib/stage1ClaimContract';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { sha256 } from '@/lib/stage1Crypto';
import { consumeSignedClaimResolverProof } from '@/lib/stage1ClaimResolver';
import { serializableTransaction } from '@/lib/serializableTransaction';

const START_NS = 'customer-home-transfer-start';
const CANCEL_NS = 'customer-home-transfer-cancel';
const COMPLETE_NS = 'customer-home-transfer-complete';
const RELATIONSHIP_MS = 365 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TransferPrincipal = {
  id: string; homeId: string; membershipId: string; hubInstallationId: string;
  trustedDeviceId: string; sessionId: string; tokenHash: string;
  credentialKind: 'account_access' | 'account_refresh'; securityVersion: number;
  trustedDeviceSessionVersion: number; policyRevision: number;
};

function pepper(): Buffer {
  const value = String(process.env.CLAIM_REFERENCE_PEPPER ?? '');
  if (!value) throw new Stage1AuthError(503, 'claim_reference_unconfigured', 'Transfer authority is not configured');
  return Buffer.from(value, 'utf8');
}

/** Stable, unguessable presentation token allows safe idempotent owner retries without storing a bearer secret. */
export function transferReferenceForClaim(claimId: string): string {
  if (!UUID.test(claimId)) throw new Stage1AuthError(500, 'transfer_reference_invalid', 'The transfer reference is unavailable');
  const mac = crypto.createHmac('sha256', pepper()).update(`dinodia-transfer-reference-v1:${claimId}`, 'utf8').digest('base64url');
  return `dno_transfer_${claimId}_${mac}`;
}

function transferRecipientHash(email: string): string {
  return hashClaimReference(`dinodia-transfer-recipient-v1:${email}`);
}

function policyOrDeny() {
  const policy = currentCustomerPolicy();
  if (!policy) throw new Stage1AuthError(503, 'customer_policy_unavailable', 'The current approved customer policy is unavailable');
  return policy;
}

async function assertRelationshipCurrent(tx: Prisma.TransactionClient, principal: TransferPrincipal, now: Date) {
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${principal.trustedDeviceId}::uuid FOR UPDATE`;
  const policy = policyOrDeny();
  const [account, session, device, acceptance] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, status: true, emailNormalized: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true, securityVersion: true } }),
    tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
    tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
    tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: principal.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } }, select: { id: true } }),
  ]);
  const tokenCurrent = principal.credentialKind === 'account_access'
    ? Boolean(principal.tokenHash && session?.accessTokenHash === principal.tokenHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
    : Boolean(principal.tokenHash && session?.refreshTokenHash === principal.tokenHash);
  if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword || account.usernameSelectionRequired
    || account.securityVersion !== principal.securityVersion || !session || session.customerAccountId !== principal.id
    || session.trustedDeviceId !== principal.trustedDeviceId || !tokenCurrent || session.securityVersion !== account.securityVersion
    || session.trustedDeviceSessionVersion !== principal.trustedDeviceSessionVersion || session.revokedAt
    || session.expiresAt <= now || session.absoluteExpiresAt <= now || !device || device.customerAccountId !== principal.id
    || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion || !acceptance) {
    throw new Stage1AuthError(401, 'customer_session_invalid', 'The account, policy acceptance or trusted phone is no longer current');
  }
  return account;
}

function consumeOwnerProof(tx: Prisma.TransactionClient, input: {
  principal: TransferPrincipal; proof: string; homeId: string; membershipId: string; value: unknown; targetIds: string[]; now: Date;
}) {
  const digest = operationDigest({ customerAccountId: input.principal.id, customerSessionId: input.principal.sessionId,
    trustedDeviceId: input.principal.trustedDeviceId, homeId: input.homeId, membershipId: input.membershipId,
    hubInstallationId: input.principal.hubInstallationId, operationKind: 'home.transfer', targetIds: input.targetIds, value: input.value });
  return tx.stepUpAuthorization.updateMany({ where: {
    nonceHash: sha256(input.proof), customerAccountId: input.principal.id, customerSessionId: input.principal.sessionId,
    trustedDeviceId: input.principal.trustedDeviceId, homeId: input.homeId, membershipId: input.membershipId,
    operationKind: 'home.transfer', targetDigest: targetDigest(input.targetIds), normalizedValueDigest: digest,
    policyRevision: input.principal.policyRevision, consumedAt: null, revokedAt: null, expiresAt: { gt: input.now },
  }, data: { consumedAt: input.now } });
}

type StartTransactionResult = { transferId: string; emailDeliveryStatus: 'PENDING'|'ACCEPTED'|'FAILED'; replay: boolean; deliver: boolean };

export async function startOwnershipTransfer(input: {
  principal: TransferPrincipal; homeId: string; recipientEmail: string; expectedManagementRevision: number;
  proof: string; idempotencyKey: string;
}): Promise<{ transferId: string; reference: string; state: 'PENDING'; emailDeliveryStatus: 'PENDING'|'ACCEPTED'|'FAILED'; idempotentReplay: boolean }> {
  const email = input.recipientEmail.trim().toLowerCase();
  if (!UUID.test(input.homeId) || input.homeId !== input.principal.homeId || !EMAIL.test(email) || email.length > 320
    || !Number.isSafeInteger(input.expectedManagementRevision) || input.expectedManagementRevision < 1
    || typeof input.proof !== 'string' || input.proof.length < 40 || input.proof.length > 8192
    || !/^[A-Za-z0-9._:-]{16,160}$/.test(input.idempotencyKey)) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid recipient, current Home revision, confirmation and idempotency key are required');
  }
  const keyHash = sha256(`${input.principal.id}:${input.homeId}:${input.idempotencyKey}`);
  const requestHash = sha256(JSON.stringify({ homeId: input.homeId, recipientEmail: email, expectedManagementRevision: input.expectedManagementRevision }));
  const result = await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR UPDATE`;
    await assertRelationshipCurrent(tx, input.principal, new Date());
    const previous = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: START_NS, keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseBody: true } });
    if (previous) {
      if (previous.actorId !== input.principal.id || previous.homeId !== input.homeId || previous.requestHash !== requestHash
        || !previous.responseBody || typeof previous.responseBody !== 'object' || !('transferId' in previous.responseBody)) {
        throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This transfer request key was already used for different details');
      }
      const claimId = String((previous.responseBody as { transferId: unknown }).transferId);
      const claim = await tx.homeClaimReference.findFirst({ where: { id: claimId, homeId: input.homeId, purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE' }, select: { id: true, transferEmailDeliveryStatus: true } });
      if (!claim) throw new Stage1AuthError(409, 'transfer_unavailable', 'This transfer is no longer active');
      return { transferId: claim.id, emailDeliveryStatus: (claim.transferEmailDeliveryStatus ?? 'PENDING') as StartTransactionResult['emailDeliveryStatus'], replay: true, deliver: claim.transferEmailDeliveryStatus !== 'ACCEPTED' };
    }
    const now = new Date();
    const targetIds = [input.homeId, input.principal.membershipId];
    const value = { action: 'START', recipientEmailNormalized: email, expectedManagementRevision: input.expectedManagementRevision,
      confirmation: `I confirm transfer of this Home to ${email}` };
    const [home, owner, hub, targetAccount, activeTransfer] = await Promise.all([
      tx.home.findUnique({ where: { id: input.homeId }, select: { id: true, lifecycle: true, installationStatus: true, managementRevision: true, activeHubInstallationId: true } }),
      tx.homeMembership.findUnique({ where: { id: input.principal.membershipId }, select: { id: true, customerAccountId: true, homeId: true, role: true, status: true } }),
      tx.hubInstallation.findUnique({ where: { id: input.principal.hubInstallationId }, select: { id: true, homeId: true, lifecycleStatus: true, permanentResolverGeneration: true, permanentResolverStatus: true } }),
      tx.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true, status: true, emailVerifiedAt: true } }),
      tx.homeClaimReference.findFirst({ where: { homeId: input.homeId, purpose: 'OWNERSHIP_TRANSFER', state: { in: ['AVAILABLE','RESERVED'] } }, select: { id: true } }),
    ]);
    if (!home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE' || home.managementRevision !== input.expectedManagementRevision
      || home.activeHubInstallationId !== input.principal.hubInstallationId || !owner || owner.customerAccountId !== input.principal.id
      || owner.homeId !== home.id || owner.role !== 'OWNER' || owner.status !== 'ACTIVE' || !hub || hub.homeId !== home.id
      || hub.lifecycleStatus !== 'ACTIVE' || hub.permanentResolverStatus !== 'ACTIVE' || activeTransfer) {
      throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The current owner, Home or transfer state changed. Refresh before continuing.');
    }
    if (targetAccount?.id === input.principal.id || targetAccount?.status === 'SUSPENDED') throw new Stage1AuthError(400, 'transfer_recipient_invalid', 'Choose a different eligible customer email address');
    if (targetAccount) {
      const tenant = await tx.homeMembership.findFirst({ where: { homeId: home.id, customerAccountId: targetAccount.id, role: 'TENANT', status: 'ACTIVE' }, select: { id: true } });
      if (tenant) throw new Stage1AuthError(409, 'transfer_tenant_cleanup_required', 'The current tenant must complete normal access removal before receiving ownership');
    }
    const proofUse = await consumeOwnerProof(tx, { principal: input.principal, proof: input.proof, homeId: home.id, membershipId: owner.id, value, targetIds, now });
    if (proofUse.count !== 1) throw new Stage1AuthError(403, 'STEP_UP_REQUIRED', 'Fresh confirmation for this exact recipient and Home is required');

    const maximum = await tx.homeClaimReference.aggregate({ where: { hubInstallationId: hub.id }, _max: { generation: true } });
    const generation = Number(maximum._max.generation ?? 0) + 1;
    const transferId = crypto.randomUUID();
    const reference = transferReferenceForClaim(transferId);
    const referenceHash = hashClaimReference(reference);
    const transfer = await tx.homeClaimReference.create({ data: {
      id: transferId, homeId: home.id, hubInstallationId: hub.id, purpose: 'OWNERSHIP_TRANSFER', generation,
      state: 'AVAILABLE', companyQrReferenceHash: referenceHash, transferCodeHash: referenceHash,
      transferRecipientEmailHash: transferRecipientHash(email), transferRecipientEmail: email, transferEmailDeliveryStatus: 'PENDING',
      resolverGeneration: hub.permanentResolverGeneration, outgoingOwnerMembershipId: owner.id,
      auditReference: `customer:${sha256(keyHash).slice(0, 96)}`,
      issuedAt: now,
    }, select: { id: true, updatedAt: true } });
    const responseBody = { transferId: transfer.id, reference, emailDeliveryStatus: 'PENDING' };
    await tx.idempotencyRecord.create({ data: { namespace: START_NS, keyHash, actorId: input.principal.id, homeId: home.id,
      requestHash, responseStatus: 202, responseDigest: sha256(JSON.stringify(responseBody)),
      responseBody: { transferId: transfer.id } as Prisma.InputJsonValue, expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } });
    await tx.auditEvent.create({ data: { homeId: home.id, actorType: 'CUSTOMER', actorId: input.principal.id, category: 'SECURITY', action: 'ownership_transfer_started', targetType: 'HomeClaimReference', targetId: transfer.id,
      metadata: { outcome: 'pending', recipientEmailHash: transferRecipientHash(email), managementRevision: home.managementRevision }, purgeAt: new Date(now.getTime() + RELATIONSHIP_MS) } });
    return { transferId: transfer.id, emailDeliveryStatus: 'PENDING' as const, replay: false, deliver: true };
  });

  let emailDeliveryStatus = result.emailDeliveryStatus;
  if (result.deliver) {
    const reference = transferReferenceForClaim(result.transferId);
    try {
      await sendCustomerAuthEmail({ email, purpose: 'ownership-transfer', token: reference, challengeId: result.transferId, expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) });
      emailDeliveryStatus = 'ACCEPTED';
    } catch (error) {
      const safeCode = error instanceof Stage1AuthError ? error.code
        : error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code).slice(0, 64) : 'provider_send_failed';
      console.warn('[stage6:ownership-transfer] email submission was not accepted', { code: safeCode });
      emailDeliveryStatus = 'FAILED';
    }
    await prisma.homeClaimReference.updateMany({ where: { id: result.transferId, purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE' }, data: { transferEmailDeliveryStatus: emailDeliveryStatus } });
  }
  return { transferId: result.transferId, reference: transferReferenceForClaim(result.transferId), state: 'PENDING' as const,
    emailDeliveryStatus, idempotentReplay: result.replay };
}

export async function currentOwnershipTransfer(input: { principal: TransferPrincipal; homeId: string }) {
  const owner = await prisma.homeMembership.findFirst({ where: { id: input.principal.membershipId, homeId: input.homeId,
    customerAccountId: input.principal.id, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } });
  if (!owner) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Ownership transfer is unavailable for this Home');
  const [claim, home] = await Promise.all([prisma.homeClaimReference.findFirst({ where: { homeId: input.homeId, outgoingOwnerMembershipId: owner.id,
    purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE', cancelledAt: null, revokedAt: null, invalidatedAt: null },
    select: { id: true, state: true, createdAt: true, updatedAt: true, transferEmailDeliveryStatus: true, transferRecipientEmail: true } }),
    prisma.home.findUnique({ where: { id: input.homeId }, select: { managementRevision: true } })]);
  if (!home) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Ownership transfer is unavailable for this Home');
  return { schemaVersion: 'dinodia.v1', homeId: input.homeId, managementRevision: home.managementRevision, activeTransfer: claim ? {
    transferId: claim.id, state: 'PENDING', createdAt: claim.createdAt.toISOString(), updatedAt: claim.updatedAt.toISOString(),
    reference: transferReferenceForClaim(claim.id), recipientEmail: claim.transferRecipientEmail,
    emailDeliveryStatus: claim.transferEmailDeliveryStatus ?? 'PENDING', expiresAt: null,
  } : null };
}

export async function cancelOwnershipTransfer(input: { principal: TransferPrincipal; homeId: string; transferId: string;
  expectedTransferUpdatedAt: string; proof: string; idempotencyKey: string }) {
  if (!UUID.test(input.homeId) || input.homeId !== input.principal.homeId || !UUID.test(input.transferId)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(input.expectedTransferUpdatedAt)
    || !/^[A-Za-z0-9._:-]{16,160}$/.test(input.idempotencyKey) || input.proof.length < 40 || input.proof.length > 8192) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current transfer revision and fresh confirmation are required');
  }
  const keyHash = sha256(`${input.principal.id}:${input.homeId}:${input.idempotencyKey}`);
  const requestHash = sha256(JSON.stringify({ homeId: input.homeId, transferId: input.transferId, expectedTransferUpdatedAt: input.expectedTransferUpdatedAt }));
  return serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR UPDATE`;
    await assertRelationshipCurrent(tx, input.principal, new Date());
    const previous = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: CANCEL_NS, keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseBody: true } });
    if (previous) {
      if (previous.actorId !== input.principal.id || previous.homeId !== input.homeId || previous.requestHash !== requestHash || !previous.responseBody) throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This cancellation key was used for another transfer');
      return { ...(previous.responseBody as Record<string, unknown>), idempotentReplay: true };
    }
    const now = new Date();
    const [owner, claim] = await Promise.all([
      tx.homeMembership.findFirst({ where: { id: input.principal.membershipId, customerAccountId: input.principal.id, homeId: input.homeId, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } }),
      tx.homeClaimReference.findFirst({ where: { id: input.transferId, homeId: input.homeId, purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE' }, select: { id: true, outgoingOwnerMembershipId: true, updatedAt: true } }),
    ]);
    if (!owner || !claim || claim.outgoingOwnerMembershipId !== owner.id || claim.updatedAt.toISOString() !== input.expectedTransferUpdatedAt) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The transfer changed or is no longer available');
    const targetIds = [input.homeId, owner.id, claim.id];
    const value = { action: 'CANCEL', transferId: claim.id, expectedTransferUpdatedAt: input.expectedTransferUpdatedAt,
      confirmation: 'I cancel this ownership transfer' };
    const proofUse = await consumeOwnerProof(tx, { principal: input.principal, proof: input.proof, homeId: input.homeId, membershipId: owner.id, value, targetIds, now });
    if (proofUse.count !== 1) throw new Stage1AuthError(403, 'STEP_UP_REQUIRED', 'Fresh confirmation for this exact transfer is required');
    await tx.homeClaimReference.update({ where: { id: claim.id }, data: { state: 'CANCELLED', cancelledAt: now, invalidatedAt: now, transferCodeHash: null, transferRecipientEmail: null } });
    await tx.homeClaimChallenge.updateMany({ where: { claimReferenceId: claim.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.principal.id, category: 'SECURITY', action: 'ownership_transfer_cancelled', targetType: 'HomeClaimReference', targetId: claim.id,
      metadata: { outcome: 'cancelled', allPresentationsInvalidated: true }, purgeAt: new Date(now.getTime() + RELATIONSHIP_MS) } });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, transferId: claim.id, state: 'CANCELLED', idempotentReplay: false };
    await tx.idempotencyRecord.create({ data: { namespace: CANCEL_NS, keyHash, actorId: input.principal.id, homeId: input.homeId,
      requestHash, responseStatus: 200, responseDigest: sha256(JSON.stringify(receipt)), responseBody: receipt as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } });
    return receipt;
  });
}

async function cleanupRemovedAccount(tx: Prisma.TransactionClient, accountId: string, homeId: string, now: Date) {
  const account = await tx.customerAccount.findUnique({ where: { id: accountId }, select: { id: true, emailNormalized: true } });
  if (!account) return false;
  const [memberships, invitations, requests, setups, reservations] = await Promise.all([
    tx.homeMembership.count({ where: { customerAccountId: accountId, status: 'ACTIVE' } }),
    tx.membershipInvitation.count({ where: { state: 'PENDING', expiresAt: { gt: now }, OR: [{ targetAccountId: accountId }, { targetEmailNormalized: account.emailNormalized }] } }),
    tx.areaAccessRequest.count({ where: { requesterAccountId: accountId, status: 'PENDING', expiresAt: { gt: now } } }),
    tx.pendingHomeSetup.count({ where: { customerAccountId: accountId, state: { in: ['PROFILE_REQUIRED','ADDRESS_REQUIRED','POLICY_REQUIRED','PENDING_INSTALLATION','READY_TO_ACTIVATE'] }, expiredAt: null, reservation: { state: 'ACTIVE', expiresAt: { gt: now } } } }),
    tx.homeClaimReservation.count({ where: { customerAccountId: accountId, state: 'ACTIVE', expiresAt: { gt: now } } }),
  ]);
  if (memberships + invitations + requests + setups + reservations > 0) return false;
  const devices = await tx.trustedDevice.findMany({ where: { customerAccountId: accountId }, select: { id: true } });
  const deviceIds = devices.map((device) => device.id);
  await tx.customerSession.updateMany({ where: { customerAccountId: accountId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'ownership_transferred', accessTokenHash: null, accessTokenExpiresAt: null } });
  await tx.trustedDevice.updateMany({ where: { customerAccountId: accountId, revokedAt: null }, data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, pushRevokedAt: now } });
  if (deviceIds.length) await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: deviceIds }, revokedAt: null }, data: { revokedAt: now, revokeReason: 'ownership_transferred' } });
  await tx.stepUpChallenge.updateMany({ where: { customerAccountId: accountId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
  await tx.stepUpAuthorization.updateMany({ where: { customerAccountId: accountId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
  await tx.supportTicket.updateMany({ where: { customerAccountId: accountId }, data: { status: 'CLOSED', closedAt: now, selectedMembershipId: null,
    description: '[Closed and redacted after relationship removal]', title: null, areaId: null, deviceId: null,
    safeDiagnostics: Prisma.DbNull, customerResolution: null, revision: { increment: 1 } } });
  await tx.customerAccount.delete({ where: { id: accountId } });
  return true;
}

export async function redeemOwnershipTransfer(input: { principal: { id: string; sessionId: string; trustedDeviceId: string; tokenHash: string; credentialKind: 'access'|'refresh'; securityVersion: number; trustedDeviceSessionVersion: number }; reference: string; idempotencyKey: string; resolverProof?: Record<string, unknown> }) {
  const usesPermanentLabel = input.resolverProof !== undefined;
  if ((!/^dno_transfer_[0-9a-f-]{36}_[A-Za-z0-9_-]{40,64}$/.test(input.reference)
      && !(usesPermanentLabel && /^DNO-HOME-[A-Za-z0-9_-]{32,64}$/.test(input.reference)))
    || !/^[A-Za-z0-9._:-]{16,160}$/.test(input.idempotencyKey)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid ownership-transfer code and idempotency key are required');
  const keyHash = sha256(`${input.principal.id}:${input.idempotencyKey}`);
  const refHash = usesPermanentLabel ? null : hashClaimReference(input.reference);
  const resolverChallengeId = usesPermanentLabel ? String(input.resolverProof?.challengeId ?? '') : null;
  const requestHash = sha256(JSON.stringify({ referenceHash: refHash, resolverChallengeId }));
  return serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${input.principal.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${input.principal.sessionId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${input.principal.trustedDeviceId}::uuid FOR UPDATE`;
    const now = new Date();
    const policy = policyOrDeny();
    const [account, session, device, acceptance] = await Promise.all([
      tx.customerAccount.findUnique({ where: { id: input.principal.id }, select: { id: true, emailNormalized: true, emailVerifiedAt: true, status: true, mustChangePassword: true, usernameSelectionRequired: true, securityVersion: true } }),
      tx.customerSession.findUnique({ where: { id: input.principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
      tx.trustedDevice.findUnique({ where: { id: input.principal.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
      tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: input.principal.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } }, select: { id: true } }),
    ]);
    const credentialCurrent = input.principal.credentialKind === 'access'
      ? Boolean(input.principal.tokenHash && session?.accessTokenHash === input.principal.tokenHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
      : Boolean(input.principal.tokenHash && session?.refreshTokenHash === input.principal.tokenHash);
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword || account.usernameSelectionRequired
      || account.securityVersion !== input.principal.securityVersion || !session || session.customerAccountId !== account.id
      || session.trustedDeviceId !== input.principal.trustedDeviceId || !credentialCurrent || session.securityVersion !== account.securityVersion
      || session.trustedDeviceSessionVersion !== input.principal.trustedDeviceSessionVersion || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
      || !device || device.customerAccountId !== account.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion || !acceptance) {
      throw new Stage1AuthError(401, 'customer_session_invalid', 'A current verified customer session and policy acceptance are required');
    }
    const previous = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: COMPLETE_NS, keyHash } }, select: { actorId: true, requestHash: true, responseBody: true } });
    if (previous) {
      if (previous.actorId !== input.principal.id || previous.requestHash !== requestHash || !previous.responseBody) throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This transfer claim key was used for different details');
      return { ...(previous.responseBody as Record<string, unknown>), idempotentReplay: true };
    }
    const expectedRecipientHash = transferRecipientHash(account.emailNormalized);
    const resolverClaim = usesPermanentLabel
      ? await consumeSignedClaimResolverProof(tx, input.resolverProof!, { purpose: 'OWNERSHIP_TRANSFER', recipientEmailHash: expectedRecipientHash })
      : null;
    const claim = resolverClaim
      ? await tx.homeClaimReference.findFirst({ where: { id: resolverClaim.claimReferenceId, purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE',
        transferRecipientEmailHash: expectedRecipientHash, cancelledAt: null, revokedAt: null, invalidatedAt: null },
        select: { id: true, homeId: true, hubInstallationId: true, outgoingOwnerMembershipId: true, resolverGeneration: true } })
      : await tx.homeClaimReference.findFirst({ where: { OR: [{ companyQrReferenceHash: refHash! }, { transferCodeHash: refHash! }], purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE',
        transferRecipientEmailHash: expectedRecipientHash, cancelledAt: null, revokedAt: null, invalidatedAt: null },
        select: { id: true, homeId: true, hubInstallationId: true, outgoingOwnerMembershipId: true, resolverGeneration: true } });
    if (!claim) throw new Stage1AuthError(404, 'transfer_unavailable', 'This ownership transfer is not available to this verified account');
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${claim.homeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${claim.id}::uuid FOR UPDATE`;
    const [currentClaim, currentHome, currentHub, owner, memberships] = await Promise.all([
      tx.homeClaimReference.findUnique({ where: { id: claim.id }, select: { id: true, homeId: true, hubInstallationId: true, purpose: true, state: true, outgoingOwnerMembershipId: true, resolverGeneration: true, transferRecipientEmailHash: true } }),
      tx.home.findUnique({ where: { id: claim.homeId }, select: { id: true, lifecycle: true, installationStatus: true, managementRevision: true, activeHubInstallationId: true } }),
      tx.hubInstallation.findUnique({ where: { id: claim.hubInstallationId }, select: { id: true, homeId: true, lifecycleStatus: true, permanentResolverGeneration: true, permanentResolverStatus: true } }),
      tx.homeMembership.findFirst({ where: { id: claim.outgoingOwnerMembershipId ?? undefined, homeId: claim.homeId, role: 'OWNER', status: 'ACTIVE' }, select: { id: true, customerAccountId: true } }),
      tx.homeMembership.findMany({ where: { homeId: claim.homeId, status: 'ACTIVE', role: { in: ['OWNER','PROPERTY_MANAGER'] } }, select: { id: true, customerAccountId: true, role: true } }),
    ]);
    if (!currentClaim || currentClaim.state !== 'AVAILABLE' || currentClaim.purpose !== 'OWNERSHIP_TRANSFER'
      || currentClaim.transferRecipientEmailHash !== transferRecipientHash(account.emailNormalized) || !currentHome || currentHome.lifecycle !== 'ACTIVE'
      || currentHome.installationStatus !== 'COMPLETE' || currentHome.activeHubInstallationId !== claim.hubInstallationId
      || !currentHub || currentHub.homeId !== claim.homeId || currentHub.lifecycleStatus !== 'ACTIVE'
      || currentHub.permanentResolverStatus !== 'ACTIVE' || currentHub.permanentResolverGeneration !== claim.resolverGeneration
      || !owner || owner.id !== claim.outgoingOwnerMembershipId) throw new Stage1AuthError(409, 'transfer_unavailable', 'The transfer or current Home authority changed');
    const existingMembership = await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: account.id, homeId: claim.homeId } }, select: { id: true, role: true, status: true, accessRevision: true } });
    if (existingMembership?.status === 'ACTIVE' && existingMembership.role === 'TENANT') throw new Stage1AuthError(409, 'transfer_tenant_cleanup_required', 'Tenant access must be removed before transfer acceptance');
    const revokedMemberships = memberships.filter((row) => row.customerAccountId !== account.id);
    const revokedMembershipIds = revokedMemberships.map((row) => row.id);
    await tx.homeMembership.updateMany({ where: { id: { in: memberships.filter((row) => row.customerAccountId !== account.id).map((row) => row.id) } },
      data: { status: 'REMOVED', removedAt: now, removalReason: 'ownership_transferred', accessRevision: { increment: 1 } } });
    let newOwnerMembershipId: string;
    if (existingMembership) {
      const updated = await tx.homeMembership.update({ where: { id: existingMembership.id }, data: { role: 'OWNER', status: 'ACTIVE', removedAt: null, removalReason: null, accessRevision: { increment: 1 } }, select: { id: true } });
      newOwnerMembershipId = updated.id;
    } else {
      const created = await tx.homeMembership.create({ data: { customerAccountId: account.id, homeId: claim.homeId, role: 'OWNER', status: 'ACTIVE', accessRevision: 1 }, select: { id: true } });
      newOwnerMembershipId = created.id;
    }
    const nextManagementRevision = currentHome.managementRevision + 1;
    await tx.home.update({ where: { id: claim.homeId }, data: { managementRevision: { increment: 1 } } });
    if (revokedMembershipIds.length) {
      await tx.tenantAreaGrant.updateMany({ where: { membershipId: { in: revokedMembershipIds }, homeId: claim.homeId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'ownership_transferred', policyRevision: { increment: 1 } } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { membershipId: { in: revokedMembershipIds }, homeId: claim.homeId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'ownership_transferred', policyRevision: { increment: 1 } } });
      await tx.stepUpChallenge.updateMany({ where: { homeId: claim.homeId, membershipId: { in: revokedMembershipIds }, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.stepUpAuthorization.updateMany({ where: { homeId: claim.homeId, membershipId: { in: revokedMembershipIds }, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.memberPreferenceDocument.deleteMany({ where: { membershipId: { in: revokedMembershipIds } } });
      await tx.alexaNativeHomeScope.updateMany({ where: { homeId: claim.homeId, membershipId: { in: revokedMembershipIds }, revokedAt: null }, data: { revokedAt: now, exposureGeneration: { increment: 1 } } });
      await tx.alexaNativeEndpointProjection.deleteMany({ where: { homeId: claim.homeId, membershipId: { in: revokedMembershipIds } } });
      await tx.supportTicket.updateMany({ where: { homeId: claim.homeId, selectedMembershipId: { in: revokedMembershipIds } }, data: { selectedMembershipId: null } });
    }
    await tx.membershipInvitation.updateMany({ where: { homeId: claim.homeId, state: 'PENDING' }, data: { state: 'REVOKED', revokedAt: now } });
    await tx.areaAccessRequest.updateMany({ where: { homeId: claim.homeId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: now } });
    const propertyRequests = await tx.supportAccessRequest.findMany({ where: { homeId: claim.homeId, requestedScope: 'PROPERTY_SCOPE', status: { in: ['REQUESTED','APPROVED','ISSUED','REDEEMED'] } }, select: { id: true } });
    const propertyRequestIds = propertyRequests.map((item) => item.id);
    if (propertyRequestIds.length) {
      await tx.supportSession.updateMany({ where: { accessRequestId: { in: propertyRequestIds }, status: { in: ['ACTIVE','PENDING_HUB_REVOKE'] } }, data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
      await tx.supportAccessRequest.updateMany({ where: { id: { in: propertyRequestIds } }, data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
    }
    await tx.homeClaimReference.update({ where: { id: claim.id }, data: { state: 'CONSUMED', claimedAccountId: account.id, consumedAt: now, transferRecipientEmail: null } });
    await tx.homeClaimChallenge.updateMany({ where: { claimReferenceId: claim.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditEvent.create({ data: { homeId: claim.homeId, actorType: 'CUSTOMER', actorId: account.id, category: 'ACCESS', action: 'ownership_transfer_completed', targetType: 'HomeClaimReference', targetId: claim.id,
      metadata: { outcome: 'transferred', removedManagementMembershipCount: revokedMembershipIds.length, activeTenantsPreserved: true, pendingInvitationsCancelled: true, roomRequestsCancelled: true, propertySupportAuthorityRevoked: true, managementRevision: nextManagementRevision }, purgeAt: new Date(now.getTime() + RELATIONSHIP_MS) } });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, transferId: claim.id, homeId: claim.homeId, homeMembershipId: newOwnerMembershipId, state: 'TRANSFERRED', idempotentReplay: false };
    await tx.idempotencyRecord.create({ data: { namespace: COMPLETE_NS, keyHash, actorId: account.id, homeId: claim.homeId, requestHash,
      responseStatus: 200, responseDigest: sha256(JSON.stringify(receipt)), responseBody: receipt as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } });
    const accountsToCleanup = [...new Set(revokedMemberships.map((row) => row.customerAccountId))];
    for (const removedAccountId of accountsToCleanup) await cleanupRemovedAccount(tx, removedAccountId, claim.homeId, now);
    return receipt;
  });
}

export function transferReferenceDigest(reference: string) { return hashClaimReference(reference); }
