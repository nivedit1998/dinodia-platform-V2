// Durable Stage 1 handoff storage. Vercel instances are disposable, so an
// in-memory registry alone cannot provide one-use or restart-safe semantics.
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';

export const OPERATOR_HANDOFF_TTL_MS = 60_000;

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export async function issueDurableOperatorHandoff(input: {
  employeeId: number;
  homeId: number;
  hubInstallId: string;
  workflow: string;
  workflowId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const value = `dno_handoff_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + OPERATOR_HANDOFF_TTL_MS);
  await prisma.operatorSessionHandoff.create({
    data: {
      tokenHash: digest(value),
      employeeId: input.employeeId,
      homeId: input.homeId,
      hubInstallId: input.hubInstallId,
      workflow: input.workflow,
      workflowId: input.workflowId,
      expiresAt,
    },
  });
  return { value, expiresAt };
}

export async function consumeDurableOperatorHandoff(input: {
  value: string;
  employeeId: number;
  homeId: number;
  hubInstallId: string;
  workflow: string;
  workflowId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const key = digest(String(input.value || ''));
  const result = await prisma.operatorSessionHandoff.updateMany({
    where: {
      tokenHash: key,
      employeeId: input.employeeId,
      homeId: input.homeId,
      hubInstallId: input.hubInstallId,
      workflow: input.workflow,
      workflowId: input.workflowId,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (result.count !== 1) return null;
  return {
    employeeId: input.employeeId,
    homeId: input.homeId,
    hubInstallId: input.hubInstallId,
    workflow: input.workflow,
    workflowId: input.workflowId,
    expiresAt: now.getTime() + OPERATOR_HANDOFF_TTL_MS,
    consumedAt: now.getTime(),
  };
}

// Dinodia OS consumes the opaque handoff over the outbound/CloudURL channel.
// The handoff itself is the one-use capability; workflow and employee identity
// are read from the durable row rather than trusted from the hub request.
export async function consumeDurableOperatorHandoffForHub(input: { value: string; hubInstallId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const key = digest(String(input.value || ''));
  const existing = await prisma.operatorSessionHandoff.findUnique({ where: { tokenHash: key } });
  if (!existing || existing.hubInstallId !== input.hubInstallId || existing.consumedAt || existing.expiresAt <= now) return null;
  const result = await prisma.operatorSessionHandoff.updateMany({
    where: { id: existing.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (result.count !== 1) return null;
  return {
    employeeId: existing.employeeId,
    homeId: existing.homeId,
    hubInstallId: existing.hubInstallId,
    workflow: existing.workflow,
    workflowId: existing.workflowId,
    expiresAt: existing.expiresAt,
    consumedAt: now,
  };
}

export async function pruneDurableOperatorHandoffs(now = new Date()) {
  return prisma.operatorSessionHandoff.deleteMany({ where: { OR: [{ expiresAt: { lte: now } }, { consumedAt: { not: null } }] } });
}
