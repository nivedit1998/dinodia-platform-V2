// Architecture: Shared platform helper src/lib/rateLimit.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { kv } from '@vercel/kv';
import { safeLog } from '@/lib/safeLogger';

export type RateLimitKey = string;

export interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
}

type RateLimitBucket = {
  count: number;
  expiresAt: number;
};

const memoryBuckets = new Map<RateLimitKey, RateLimitBucket>();

function hasKvConfig(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function checkRateLimitKv(key: RateLimitKey, options: RateLimitOptions) {
  const { maxRequests, windowMs } = options;
  const bucketKey = `rl:${key}`;

  const txn = kv.multi();
  txn.incr(bucketKey);
  txn.expire(bucketKey, Math.ceil(windowMs / 1000));
  const [count] = await txn.exec<number[]>();

  if (typeof count !== 'number') return true;
  return count <= maxRequests;
}

function checkRateLimitMemory(key: RateLimitKey, options: RateLimitOptions) {
  const { maxRequests, windowMs } = options;
  const now = Date.now();
  const existing = memoryBuckets.get(key);

  if (!existing || existing.expiresAt < now) {
    memoryBuckets.set(key, { count: 1, expiresAt: now + windowMs });
    return true;
  }

  if (existing.count < maxRequests) {
    existing.count += 1;
    return true;
  }

  return false;
}

export async function checkRateLimit(
  key: RateLimitKey,
  options: RateLimitOptions
): Promise<boolean> {
  if (hasKvConfig()) {
    try {
      return await checkRateLimitKv(key, options);
    } catch (err) {
      safeLog('warn', '[rateLimit] KV unavailable, falling back to memory', { err });
    }
  }
  return checkRateLimitMemory(key, options);
}
