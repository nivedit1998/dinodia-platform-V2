import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { Prisma } from '@prisma/client';

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
