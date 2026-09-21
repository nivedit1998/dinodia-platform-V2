// Architecture: Shared platform helper src/lib/stepUp.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { Prisma, StepUpPurpose } from '@prisma/client';
import { prisma } from './prisma';
import { safeLog } from './safeLogger';

type Client = Prisma.TransactionClient | typeof prisma;

export async function createStepUpApproval(
  userId: number,
  deviceId: string,
  purpose: StepUpPurpose,
  client: Client = prisma
) {
  const existing = await client.stepUpApproval.findFirst({
    where: { userId, deviceId, purpose, usedAt: null },
    orderBy: { approvedAt: 'desc' },
  });
  if (existing) {
    safeLog('info', '[stepUp] reused existing approval', {
      event: 'step_up_approval',
      result: 'reused_existing',
      userId,
      deviceId,
      purpose,
      approvalId: existing.id,
    });
    return existing;
  }

  const created = await client.stepUpApproval.create({
    data: {
      userId,
      deviceId,
      purpose,
    },
  });

  safeLog('info', '[stepUp] created approval', {
    event: 'step_up_approval',
    result: 'created_new',
    userId,
    deviceId,
    purpose,
    approvalId: created.id,
  });

  return created;
}

export async function consumeStepUpApproval(
  userId: number,
  deviceId: string,
  purpose: StepUpPurpose,
  client: Client = prisma
) {
  const existing = await client.stepUpApproval.findFirst({
    where: { userId, deviceId, purpose, usedAt: null },
    orderBy: { approvedAt: 'desc' },
  });
  if (!existing) return null;
  return client.stepUpApproval.update({
    where: { id: existing.id },
    data: { usedAt: new Date() },
  });
}

export async function getLatestStepUpApproval(
  userId: number,
  deviceId: string,
  purpose: StepUpPurpose,
  opts: { maxAgeMs?: number } = {},
  client: Client = prisma
) {
  const maxAgeMs = typeof opts.maxAgeMs === 'number' && opts.maxAgeMs > 0 ? opts.maxAgeMs : undefined;
  const cutoff = maxAgeMs ? new Date(Date.now() - maxAgeMs) : undefined;
  return client.stepUpApproval.findFirst({
    where: {
      userId,
      deviceId,
      purpose,
      usedAt: null,
      ...(cutoff ? { approvedAt: { gte: cutoff } } : {}),
    },
    orderBy: { approvedAt: 'desc' },
  });
}

export async function consumeLatestStepUpApproval(
  userId: number,
  deviceId: string,
  purpose: StepUpPurpose,
  client: Client = prisma
) {
  const latest = await client.stepUpApproval.findFirst({
    where: { userId, deviceId, purpose, usedAt: null },
    orderBy: { approvedAt: 'desc' },
  });
  if (!latest) return null;
  return client.stepUpApproval.update({
    where: { id: latest.id },
    data: { usedAt: new Date() },
  });
}
