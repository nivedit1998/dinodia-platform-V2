import crypto from 'node:crypto';
import { Prisma, StepUpPurpose } from '@prisma/client';
import { prisma } from './prisma';

type Client = Prisma.TransactionClient | typeof prisma;

export const SENSITIVE_OPERATION_STEP_UP_TTL_MS = 30_000;

export type SensitiveOperationInput = {
  actorId: number;
  trustedSessionId: string;
  homeId: number;
  membershipId: string;
  hubInstallId: string;
  deviceId?: string | null;
  operationKind: string;
  targetIds: string[];
  value?: unknown;
  now?: Date;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function sensitiveOperationDigest(input: { actorId: number; trustedSessionId: string; homeId: number; membershipId: string; hubInstallId: string; operation: string; targetIds: string[]; value?: unknown }) {
  return crypto.createHash('sha256').update(JSON.stringify({ actorId: input.actorId, trustedSessionId: input.trustedSessionId, homeId: input.homeId, membershipId: input.membershipId, hubInstallId: input.hubInstallId, operation: input.operation, targetIds: [...input.targetIds].map(String).sort(), value: stable(input.value) }), 'utf8').digest('hex');
}

export function assertSensitiveOperationBinding(proof: { actorId: number; trustedSessionId: string; homeId: number; membershipId?: string | null; hubInstallId?: string | null; operationDigest: string }, input: { actorId: number; trustedSessionId: string; homeId: number; membershipId: string; hubInstallId: string; operation: string; targetIds: string[]; value?: unknown }) {
  if (proof.actorId !== input.actorId || proof.trustedSessionId !== input.trustedSessionId || proof.homeId !== input.homeId || proof.membershipId !== input.membershipId || proof.hubInstallId !== input.hubInstallId) throw new Error('Step-up proof actor, membership, hub or home mismatch');
  if (proof.operationDigest !== sensitiveOperationDigest(input)) throw new Error('Step-up proof operation mismatch');
  return true;
}

export async function createSensitiveOperationStepUp(input: SensitiveOperationInput, client: Client = prisma) {
  const now = input.now ?? new Date();
  const digest = sensitiveOperationDigest({
    actorId: input.actorId,
    trustedSessionId: input.trustedSessionId,
    homeId: input.homeId,
    membershipId: input.membershipId,
    hubInstallId: input.hubInstallId,
    operation: input.operationKind,
    targetIds: input.targetIds,
    value: input.value,
  });
  return client.stepUpApproval.create({
    data: {
      userId: input.actorId,
      deviceId: input.deviceId,
      purpose: StepUpPurpose.SENSITIVE_OPERATION,
      operationKind: input.operationKind,
      operationDigest: digest,
      trustedSessionId: input.trustedSessionId,
      membershipId: input.membershipId,
      hubInstallId: input.hubInstallId,
      targetIds: input.targetIds,
      homeId: input.homeId,
      approvedAt: now,
      expiresAt: new Date(now.getTime() + SENSITIVE_OPERATION_STEP_UP_TTL_MS),
    },
  });
}

export async function consumeSensitiveOperationStepUp(input: SensitiveOperationInput & { proofId: string }, client: Client = prisma) {
  const now = input.now ?? new Date();
  const digest = sensitiveOperationDigest({
    actorId: input.actorId,
    trustedSessionId: input.trustedSessionId,
    homeId: input.homeId,
    membershipId: input.membershipId,
    hubInstallId: input.hubInstallId,
    operation: input.operationKind,
    targetIds: input.targetIds,
    value: input.value,
  });
  const consumed = await client.stepUpApproval.updateMany({
    where: {
      id: input.proofId,
      userId: input.actorId,
      purpose: StepUpPurpose.SENSITIVE_OPERATION,
      deviceId: input.deviceId,
      trustedSessionId: input.trustedSessionId,
      membershipId: input.membershipId,
      hubInstallId: input.hubInstallId,
      homeId: input.homeId,
      operationKind: input.operationKind,
      operationDigest: digest,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  if (consumed.count !== 1) return null;
  return { proofId: input.proofId, usedAt: now, operationDigest: digest };
}
