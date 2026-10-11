import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { Prisma } from '@prisma/client';

/**
 * Charge a persistent abuse bucket inside the caller's transaction. This is
 * used when quota consumption must commit atomically with a newly-created
 * durable operation, and must not be charged for an exact idempotent replay.
 */
export async function enforcePersistentRateLimitInTransaction(
  tx: Prisma.TransactionClient,
  bucketKey: string,
  limit: number,
  windowMs: number,
  now = new Date(),
): Promise<void> {
  const current = await tx.authRateLimitBucket.findUnique({ where: { bucketKey }, select: { id: true, windowStart: true, attempts: true, blockedUntil: true } });
  if (!current) {
    await tx.authRateLimitBucket.create({ data: { bucketKey, windowStart: now, attempts: 1 } });
    return;
  }
  if (current.blockedUntil && current.blockedUntil > now) {
    throw new Stage1AuthError(429, 'rate_limited', `Too many attempts. Retry in ${Math.ceil((current.blockedUntil.getTime() - now.getTime()) / 1000)} seconds`);
  }
  if (now.getTime() - current.windowStart.getTime() >= windowMs) {
    await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { windowStart: now, attempts: 1, blockedUntil: null } });
    return;
  }
  if (current.attempts >= limit) {
    const blockedUntil = new Date(Math.max(current.windowStart.getTime() + windowMs, now.getTime() + Math.min(windowMs, 5 * 60 * 1000)));
    await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { blockedUntil } });
    throw new Stage1AuthError(429, 'rate_limited', `Too many attempts. Retry in ${Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000)} seconds`);
  }
  await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { attempts: { increment: 1 } } });
}

export async function enforcePersistentRateLimit(bucketKey: string, limit: number, windowMs: number): Promise<void> {
  const now = new Date();
  let result: { allowed: boolean; retryAfterMs: number } | undefined;
  for (let transactionAttempt = 0; transactionAttempt < 3 && !result; transactionAttempt += 1) {
    try {
      result = await prisma.$transaction(async (tx) => {
        const current = await tx.authRateLimitBucket.findUnique({ where: { bucketKey }, select: { id: true, windowStart: true, attempts: true, blockedUntil: true } });
        if (!current) {
          await tx.authRateLimitBucket.create({ data: { bucketKey, windowStart: now, attempts: 1 } });
          return { allowed: true, retryAfterMs: 0 };
        }
        if (current.blockedUntil && current.blockedUntil > now) return { allowed: false, retryAfterMs: current.blockedUntil.getTime() - now.getTime() };
        if (now.getTime() - current.windowStart.getTime() >= windowMs) {
          await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { windowStart: now, attempts: 1, blockedUntil: null } });
          return { allowed: true, retryAfterMs: 0 };
        }
        if (current.attempts >= limit) {
          const blockedUntil = new Date(Math.max(current.windowStart.getTime() + windowMs, now.getTime() + Math.min(windowMs, 5 * 60 * 1000)));
          await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { blockedUntil } });
          return { allowed: false, retryAfterMs: blockedUntil.getTime() - now.getTime() };
        }
        await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { attempts: { increment: 1 } } });
        return { allowed: true, retryAfterMs: 0 };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if ((code === 'P2002' || code === 'P2034') && transactionAttempt < 2) continue;
      throw error;
    }
  }
  if (!result) throw new Stage1AuthError(503, 'rate_limit_retry_exhausted', 'The request could not be admitted safely; please retry');
  if (!result.allowed) throw new Stage1AuthError(429, 'rate_limited', `Too many attempts. Retry in ${Math.ceil(result.retryAfterMs / 1000)} seconds`);
}
