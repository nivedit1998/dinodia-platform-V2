// Architecture: Shared platform helper src/lib/loginIntents.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const DEFAULT_LOGIN_INTENT_TTL_MINUTES = 20;
const MAX_LOGIN_INTENT_TTL_MINUTES = 120;

type LoginIntentFailureReason = 'NOT_FOUND' | 'REVOKED' | 'CONSUMED' | 'EXPIRED';

export type ActiveLoginIntent = {
  id: string;
  userId: number;
  username: string;
  role: Role;
  deviceId: string;
  deviceLabel: string | null;
  expiresAt: Date;
};

function resolveTtlMinutes() {
  const raw = Number(process.env.LOGIN_INTENT_TTL_MINUTES || DEFAULT_LOGIN_INTENT_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LOGIN_INTENT_TTL_MINUTES;
  return Math.min(Math.floor(raw), MAX_LOGIN_INTENT_TTL_MINUTES);
}

function ttlExpiryDate(now = new Date()) {
  const ttlMinutes = resolveTtlMinutes();
  return new Date(now.getTime() + ttlMinutes * 60 * 1000);
}

export async function createLoginIntent(input: {
  userId: number;
  username: string;
  role: Role;
  deviceId: string;
  deviceLabel?: string | null;
}): Promise<ActiveLoginIntent> {
  const now = new Date();
  const created = await prisma.loginIntent.create({
    data: {
      userId: input.userId,
      username: input.username,
      role: input.role,
      deviceId: input.deviceId,
      deviceLabel: input.deviceLabel || null,
      expiresAt: ttlExpiryDate(now),
    },
    select: {
      id: true,
      userId: true,
      username: true,
      role: true,
      deviceId: true,
      deviceLabel: true,
      expiresAt: true,
    },
  });

  return created;
}

export async function getActiveLoginIntent(id: string): Promise<
  | { ok: true; intent: ActiveLoginIntent }
  | { ok: false; reason: LoginIntentFailureReason }
> {
  const intent = await prisma.loginIntent.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      username: true,
      role: true,
      deviceId: true,
      deviceLabel: true,
      expiresAt: true,
      consumedAt: true,
      revokedAt: true,
    },
  });

  if (!intent) return { ok: false, reason: 'NOT_FOUND' };
  if (intent.revokedAt) return { ok: false, reason: 'REVOKED' };
  if (intent.consumedAt) return { ok: false, reason: 'CONSUMED' };

  if (intent.expiresAt.getTime() <= Date.now()) {
    await prisma.loginIntent.updateMany({
      where: { id, consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: false, reason: 'EXPIRED' };
  }

  return {
    ok: true,
    intent: {
      id: intent.id,
      userId: intent.userId,
      username: intent.username,
      role: intent.role,
      deviceId: intent.deviceId,
      deviceLabel: intent.deviceLabel,
      expiresAt: intent.expiresAt,
    },
  };
}

export async function consumeLoginIntent(id: string): Promise<void> {
  await prisma.loginIntent.updateMany({
    where: { id, consumedAt: null, revokedAt: null },
    data: { consumedAt: new Date() },
  });
}

export async function revokeLoginIntent(id: string): Promise<void> {
  await prisma.loginIntent.updateMany({
    where: { id, consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
