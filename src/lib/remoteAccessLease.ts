// Architecture: Shared platform helper src/lib/remoteAccessLease.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import crypto from 'crypto';
import { Prisma, StepUpPurpose } from '@prisma/client';
import { prisma } from './prisma';

type Client = Prisma.TransactionClient | typeof prisma;

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createRemoteAccessLease(
  userId: number,
  deviceId: string,
  purpose: StepUpPurpose,
  opts: { ttlMs?: number } = {},
  client: Client = prisma
) {
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // Invalidate any previous leases for this device/purpose.
  await client.remoteAccessLease.updateMany({
    where: {
      userId,
      deviceId,
      purpose,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { revokedAt: now },
  });

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);

  await client.remoteAccessLease.create({
    data: {
      userId,
      deviceId,
      purpose,
      tokenHash,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function validateRemoteAccessLease(
  userId: number,
  deviceId: string,
  purpose: StepUpPurpose,
  token: string,
  client: Client = prisma
) {
  if (!token || typeof token !== 'string') return null;
  const now = new Date();
  const tokenHash = hashToken(token);
  const lease = await client.remoteAccessLease.findFirst({
    where: {
      userId,
      deviceId,
      purpose,
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
  return lease ?? null;
}
