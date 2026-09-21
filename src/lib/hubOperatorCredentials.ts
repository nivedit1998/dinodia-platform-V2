// Stage 1 native operator credential lifecycle. This module never returns a
// plaintext credential to a Company Portal response.
import crypto from 'node:crypto';
import { HubOperatorCredentialStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { encryptSecret, generateRandomHex, hashSha256 } from './hubCrypto';

export const OPERATOR_ROTATE_MINUTES = 60;
export const OPERATOR_GRACE_MINUTES = 20;

export function generateOperatorCredential() {
  const plaintext = `dno_ops_${generateRandomHex(32)}`;
  return { plaintext, hash: hashSha256(plaintext), ciphertext: encryptSecret(plaintext) };
}

export function redactOperatorCredential(record: {
  version: number;
  status: HubOperatorCredentialStatus;
  issuedAt: Date;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
  activatedAt: Date | null;
  graceUntil: Date | null;
  revokedAt: Date | null;
}) {
  return {
    version: record.version,
    status: record.status,
    issuedAt: record.issuedAt,
    deliveredAt: record.deliveredAt,
    acknowledgedAt: record.acknowledgedAt,
    activatedAt: record.activatedAt,
    graceUntil: record.graceUntil,
    revokedAt: record.revokedAt,
  };
}

export function assertOperatorTransition(from: HubOperatorCredentialStatus, to: HubOperatorCredentialStatus) {
  const allowed: Record<HubOperatorCredentialStatus, HubOperatorCredentialStatus[]> = {
    PENDING: [HubOperatorCredentialStatus.DELIVERED, HubOperatorCredentialStatus.REVOKED],
    DELIVERED: [HubOperatorCredentialStatus.ACKNOWLEDGED, HubOperatorCredentialStatus.REVOKED],
    ACKNOWLEDGED: [HubOperatorCredentialStatus.ACTIVE, HubOperatorCredentialStatus.REVOKED],
    ACTIVE: [HubOperatorCredentialStatus.GRACE, HubOperatorCredentialStatus.REVOKED],
    GRACE: [HubOperatorCredentialStatus.REVOKED],
    REVOKED: [],
  };
  if (!allowed[from]?.includes(to)) throw new Error(`Invalid operator credential transition ${from} -> ${to}`);
}

export async function createPendingOperatorCredential(hubInstallId: string, version: number) {
  const existing = await prisma.hubOperatorCredential.findFirst({ where: { hubInstallId, status: HubOperatorCredentialStatus.PENDING }, orderBy: { version: 'desc' } });
  if (existing) return { record: redactOperatorCredential(existing), deliveryCiphertext: null };
  const credential = generateOperatorCredential();
  const created = await prisma.hubOperatorCredential.create({
    data: {
      hubInstallId,
      version,
      status: HubOperatorCredentialStatus.PENDING,
      tokenHash: credential.hash,
      tokenCiphertext: credential.ciphertext,
    },
  });
  return { record: redactOperatorCredential(created), deliveryCiphertext: credential.ciphertext };
}

export async function acknowledgeOperatorCredential(hubInstallId: string, version: number) {
  const record = await prisma.hubOperatorCredential.findUnique({ where: { hubInstallId_version: { hubInstallId, version } } });
  if (!record || !([HubOperatorCredentialStatus.DELIVERED, HubOperatorCredentialStatus.PENDING] as HubOperatorCredentialStatus[]).includes(record.status)) throw new Error('Delivered operator credential was not found');
  const acknowledged = await prisma.hubOperatorCredential.update({ where: { id: record.id }, data: { status: HubOperatorCredentialStatus.ACKNOWLEDGED, acknowledgedAt: new Date() } });
  return redactOperatorCredential(acknowledged);
}

export async function markOperatorCredentialDelivered(hubInstallId: string, version: number) {
  const record = await prisma.hubOperatorCredential.findUnique({ where: { hubInstallId_version: { hubInstallId, version } } });
  if (!record || record.status !== HubOperatorCredentialStatus.PENDING) throw new Error('Pending operator credential was not found');
  const delivered = await prisma.hubOperatorCredential.update({
    where: { id: record.id },
    data: { status: HubOperatorCredentialStatus.DELIVERED, deliveredAt: new Date(), deliveryAttempts: { increment: 1 } },
  });
  await prisma.hubInstall.update({ where: { id: hubInstallId }, data: { deliveredOperatorCredentialVersion: version } });
  return { record: redactOperatorCredential(delivered), ciphertext: record.tokenCiphertext };
}

export async function publishAcknowledgedOperatorCredential(hubInstallId: string, version: number, previousVersion: number, _graceMinutes = OPERATOR_GRACE_MINUTES) {
  void _graceMinutes;
  const now = new Date();
  const graceUntil = new Date(now.getTime() + OPERATOR_GRACE_MINUTES * 60_000);
  return prisma.$transaction(async (tx) => {
    const pending = await tx.hubOperatorCredential.findUnique({ where: { hubInstallId_version: { hubInstallId, version } } });
    if (!pending || pending.status !== HubOperatorCredentialStatus.ACKNOWLEDGED) throw new Error('Acknowledged operator credential was not found');
    const previous = previousVersion > 0
      ? await tx.hubOperatorCredential.findUnique({ where: { hubInstallId_version: { hubInstallId, version: previousVersion } } })
      : null;
    if (previous) {
      assertOperatorTransition(previous.status, HubOperatorCredentialStatus.GRACE);
      await tx.hubOperatorCredential.update({ where: { id: previous.id }, data: { status: HubOperatorCredentialStatus.GRACE, graceUntil } });
    }
    assertOperatorTransition(pending.status, HubOperatorCredentialStatus.ACTIVE);
    if (!pending.acknowledgedAt) throw new Error('Hub acknowledgement is required before activation');
    const active = await tx.hubOperatorCredential.update({ where: { id: pending.id }, data: { status: HubOperatorCredentialStatus.ACTIVE, activatedAt: now } });
    await tx.hubInstall.update({ where: { id: hubInstallId }, data: { publishedOperatorCredentialVersion: version, lastAckedOperatorCredentialVersion: version, activeOperatorCredentialVersion: version } });
    return redactOperatorCredential(active);
  });
}

export async function revokeOperatorCredentials(hubInstallId: string, reason: string) {
  if (!String(reason || '').trim()) throw new Error('A revocation reason is required');
  const result = await prisma.hubOperatorCredential.updateMany({ where: { hubInstallId, status: { in: [HubOperatorCredentialStatus.PENDING, HubOperatorCredentialStatus.ACTIVE, HubOperatorCredentialStatus.GRACE] } }, data: { status: HubOperatorCredentialStatus.REVOKED, revokedAt: new Date() } });
  await prisma.hubInstall.update({ where: { id: hubInstallId }, data: { accessPolicyRevision: { increment: 1 } } });
  return { revoked: result.count, reason: String(reason).slice(0, 256) };
}

export function operatorCredentialFingerprint(value: string) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 32);
}
