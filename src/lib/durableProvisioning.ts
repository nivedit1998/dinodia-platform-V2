import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { type ManufacturingPairingEnvelope, verifyManufacturingEnvelope } from '@/lib/manufacturingIdentity';

const PRESENTATION_TTL_MS = 15 * 60 * 1000;

function digest(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function secureReference(prefix: string) {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

export type DurableProvisioningFailure =
  | 'invalid_manufacturing_identity'
  | 'identity_revoked'
  | 'identity_conflict'
  | 'attempt_conflict'
  | 'pairing_expired'
  | 'pairing_invalid'
  | 'pairing_already_consumed'
  | 'pairing_not_found'
  | 'installation_not_redeemed';

export async function registerManufacturingAttempt(input: {
  envelope: ManufacturingPairingEnvelope;
  code: string;
  roots: ReturnType<typeof import('@/lib/manufacturingIdentity').parseManufacturingRoots>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!verifyManufacturingEnvelope(input.envelope, input.roots, now.getTime())) {
    return { ok: false as const, errorCode: 'invalid_manufacturing_identity' as DurableProvisioningFailure };
  }
  const envelope = input.envelope;
  const codeHash = digest(input.code);
  const expiresAt = new Date(envelope.expiresAt);
  let encryptionKeyFingerprint = '';
  try {
    const encryptionPublicKey = crypto.createPublicKey(envelope.encryptionPublicKeyPem);
    encryptionKeyFingerprint = crypto.createHash('sha256').update(encryptionPublicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  } catch {
    return { ok: false as const, errorCode: 'invalid_manufacturing_identity' as DurableProvisioningFailure };
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.hubManufacturingIdentity.findUnique({ where: { serial: envelope.serial } });
      if (existing?.status === 'REVOKED' || existing?.revokedAt) throw new Error('identity_revoked');
      const keysMatch = Boolean(existing && existing.publicKeyFingerprint === envelope.publicKeyFingerprint && existing.encryptionPublicKey === envelope.encryptionPublicKeyPem && existing.encryptionKeyFingerprint === encryptionKeyFingerprint);
      if (existing && !keysMatch && envelope.identityGeneration <= existing.identityGeneration) throw new Error('identity_conflict');
      const identity = existing
        ? keysMatch
          ? existing
          : await tx.hubManufacturingIdentity.update({
              where: { id: existing.id },
              data: {
                signingPublicKey: envelope.publicKeyPem,
                encryptionPublicKey: envelope.encryptionPublicKeyPem,
                publicKeyFingerprint: envelope.publicKeyFingerprint,
                encryptionKeyFingerprint,
                identityGeneration: envelope.identityGeneration,
                status: 'ACTIVE',
                revokedAt: null,
              },
            })
        : await tx.hubManufacturingIdentity.create({
            data: {
              serial: envelope.serial,
              signingPublicKey: envelope.publicKeyPem,
              encryptionPublicKey: envelope.encryptionPublicKeyPem,
              publicKeyFingerprint: envelope.publicKeyFingerprint,
              encryptionKeyFingerprint,
              identityGeneration: envelope.identityGeneration,
              status: 'ACTIVE',
            },
          });
      if (existing && !keysMatch) {
        await tx.hubProvisioningAttempt.updateMany({ where: { identityId: existing.id, state: { in: ['PENDING', 'REDEEMED', 'CHALLENGE_SENT', 'CREDENTIAL_DELIVERED'] }, revokedAt: null }, data: { revokedAt: now, state: 'REVOKED' } });
      }
      const previous = await tx.hubProvisioningAttempt.findUnique({ where: { attemptId: envelope.attemptId } });
      if (previous) {
        if (previous.identityId !== identity.id || previous.serial !== envelope.serial || previous.codeHash !== codeHash) throw new Error('attempt_conflict');
        return previous;
      }
      return tx.hubProvisioningAttempt.create({
        data: {
          attemptId: envelope.attemptId,
          identityId: identity.id,
          serial: envelope.serial,
          baseUrl: envelope.baseUrl.replace(/\/$/, ''),
          codeHash,
          state: 'PENDING',
          expiresAt,
          homeQrReference: secureReference('home_claim'),
        },
      });
    });
    return {
      ok: true as const,
      id: result.id,
      attemptId: result.attemptId,
      serial: result.serial,
      baseUrl: result.baseUrl,
      homeQrReference: result.homeQrReference,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    const code = String((error as Error).message || '');
    const errorCode = (['identity_revoked', 'identity_conflict', 'attempt_conflict'].includes(code) ? code : 'pairing_invalid') as DurableProvisioningFailure;
    return { ok: false as const, errorCode };
  }
}

export async function redeemDurableProvisioningPresentation(input: { attemptId: string; code: string; operatorId: number; workflowId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const attempt = await prisma.hubProvisioningAttempt.findUnique({ where: { attemptId: input.attemptId } });
  if (!attempt) return { ok: false as const, errorCode: 'pairing_not_found' as DurableProvisioningFailure };
  if (attempt.state === 'REDEEMED' || attempt.state === 'CHALLENGE_SENT' || attempt.state === 'DELIVERED' || attempt.state === 'ACKNOWLEDGED' || attempt.state === 'COMPLETED') return { ok: false as const, errorCode: 'pairing_already_consumed' as DurableProvisioningFailure };
  if (attempt.revokedAt || attempt.expiresAt <= now) return { ok: false as const, errorCode: 'pairing_expired' as DurableProvisioningFailure };
  const workflow = await prisma.osOperatorWorkflow.findUnique({ where: { id: input.workflowId } });
  const workflowValid = Boolean(workflow && workflow.workflowType === 'INSTALLATION' && workflow.assignedEmployeeId === input.operatorId && ['APPROVED', 'ASSIGNED'].includes(workflow.status) && workflow.approvedAt && !workflow.revokedAt && (!workflow.expiresAt || workflow.expiresAt > now));
  if (!workflowValid || !workflow) return { ok: false as const, errorCode: 'pairing_invalid' as DurableProvisioningFailure };
  const linkedHub = await prisma.hubInstall.findUnique({ where: { serial: attempt.serial }, select: { id: true } });
  if (linkedHub && linkedHub.id !== workflow!.hubInstallId) return { ok: false as const, errorCode: 'pairing_invalid' as DurableProvisioningFailure };
  // Redeem the pairing and create the opaque Home QR resolver in one database
  // transaction. A failed resolver write must not consume the one-use pairing.
  try {
    const result = await prisma.$transaction(async (tx) => {
      const redeemed = await tx.hubProvisioningAttempt.updateMany({
        where: { id: attempt.id, codeHash: digest(input.code), state: 'PENDING', revokedAt: null, expiresAt: { gt: now } },
        data: { state: 'REDEEMED', redeemedAt: now, challengeIssuedAt: now, provisioningOperatorId: input.operatorId, provisioningWorkflowId: input.workflowId, operatorBoundAt: now },
      });
      if (redeemed.count !== 1) return { count: 0 };
      const reference = attempt.homeQrReference?.trim();
      if (!reference) throw new Error('home_qr_reference_required');
      const referenceHash = digest(reference);
      const existing = await tx.stage1ClaimReservation.findUnique({ where: { hubLabelReferenceHash: referenceHash } });
      if (existing && existing.hubInstallId !== workflow.hubInstallId) throw new Error('home_qr_reference_conflict');
      if (!existing) {
        const hub = await tx.hubInstall.findUnique({ where: { id: workflow.hubInstallId }, select: { id: true } });
        if (!hub) throw new Error('hub_install_not_found');
        await tx.stage1ClaimReservation.create({ data: { hubInstallId: workflow.hubInstallId, hubLabelReferenceHash: referenceHash, state: 'AVAILABLE' } });
      }
      return { count: 1 };
    });
    if (result.count !== 1) return { ok: false as const, errorCode: 'pairing_invalid' as DurableProvisioningFailure };
  } catch {
    return { ok: false as const, errorCode: 'pairing_invalid' as DurableProvisioningFailure };
  }
  return { ok: true as const, pairingId: attempt.id, attemptId: attempt.attemptId, serial: attempt.serial, baseUrl: attempt.baseUrl };
}

export async function completeDurableProvisioningAttempt(input: { attemptId: string; operatorId: number; workflowId: string; role?: string }, now = new Date()) {
  const target = await prisma.hubProvisioningAttempt.findFirst({ where: { OR: [{ attemptId: input.attemptId }, { id: input.attemptId }], provisioningOperatorId: input.operatorId, provisioningWorkflowId: input.workflowId }, select: { id: true, serial: true, cloudUrlVerifiedAt: true } });
  if (!target) return { ok: false as const, errorCode: 'installation_not_redeemed' as DurableProvisioningFailure };
  if (!target.cloudUrlVerifiedAt) return { ok: false as const, errorCode: 'installation_not_redeemed' as DurableProvisioningFailure };
  const workflow = await prisma.osOperatorWorkflow.findUnique({ where: { id: input.workflowId }, select: { hubInstallId: true, workflowType: true, assignedEmployeeId: true, status: true, approvedAt: true, expiresAt: true, revokedAt: true } });
  const hub = workflow ? await prisma.hubInstall.findUnique({ where: { id: workflow.hubInstallId }, select: { serial: true } }) : null;
  const roleAllowed = input.role === 'INSTALLER' || input.role === 'SENIOR_OPERATIONS_MANAGER' || input.role === 'CXO';
  const workflowAllowed = Boolean(workflow && hub && workflow.workflowType === 'INSTALLATION' && workflow.assignedEmployeeId === input.operatorId && ['ASSIGNED', 'APPROVED'].includes(workflow.status) && workflow.approvedAt && (!workflow.expiresAt || workflow.expiresAt > now) && !workflow.revokedAt && hub.serial === target.serial && roleAllowed);
  if (!workflowAllowed) return { ok: false as const, errorCode: 'installation_not_redeemed' as DurableProvisioningFailure };
  const result = await prisma.hubProvisioningAttempt.updateMany({
    where: { id: target.id, state: 'ACKNOWLEDGED', installationCompletedAt: null, revokedAt: null },
    data: { state: 'COMPLETED', installationCompletedAt: now },
  });
  if (result.count !== 1) return { ok: false as const, errorCode: 'installation_not_redeemed' as DurableProvisioningFailure };
  const record = await prisma.hubProvisioningAttempt.findUnique({ where: { id: target.id } });
  return { ok: true as const, homeQrReference: record?.homeQrReference ?? null };
}

export async function durableProvisioningClaimState(attemptId: string) {
  const record = await prisma.hubProvisioningAttempt.findFirst({ where: { OR: [{ attemptId }, { id: attemptId }] }, select: { state: true, homeQrReference: true, installationCompletedAt: true, expiresAt: true } });
  if (!record) return { ok: false as const, errorCode: 'pairing_not_found' as DurableProvisioningFailure };
  // The opaque Home QR reference may be issued before installation is
  // complete, but downstream claim routes must still enforce completion.
  return { ok: true as const, pendingInstallation: record.state !== 'COMPLETED', state: record.state, homeQrReference: record.homeQrReference, expiresAt: record.expiresAt };
}

export async function releaseExpiredDurableProvisioning(now = new Date()) {
  return prisma.hubProvisioningAttempt.updateMany({ where: { state: { in: ['PENDING', 'REDEEMED'] }, expiresAt: { lte: now }, revokedAt: null }, data: { state: 'EXPIRED', revokedAt: now } });
}

export { PRESENTATION_TTL_MS };
