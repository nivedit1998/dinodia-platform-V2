/** @typedef {{ windowStart: Date, attempts: number, blockedUntil: Date | null, attemptTimestamps?: unknown }} BucketState */

/** @typedef {{ allowed: true, action: 'create' | 'update', attempts: number, windowStart: Date, attemptTimestamps: string[] }} AllowedDecision */
/** @typedef {{ allowed: false, action: 'blocked', attempts: number, windowStart: Date, attemptTimestamps: string[], retryAfterMs: number, blockedUntil: Date }} DeniedDecision */

/**
 * Pure policy shared by the transactional database gate and exact-boundary
 * tests. The caller commits the returned bucket transition in its transaction.
 * @param {BucketState | null} current
 * @param {Date} now
 * @param {number} limit
 * @param {number} windowMs
 * @returns {AllowedDecision | DeniedDecision}
 */
export function decideOperatorRateLimit(current, now, limit = 5, windowMs = 60 * 60 * 1000) {
  const nowMs = now.getTime();
  const cutoff = nowMs - windowMs;
  let timestamps = [];
  if (current) {
    if (Array.isArray(current.attemptTimestamps)) {
      timestamps = current.attemptTimestamps.map((value) => Date.parse(String(value)));
      // A corrupt durable bucket must fail closed, not erase its history.
      if (timestamps.some((value) => !Number.isFinite(value))) timestamps = Array.from({ length: limit }, () => nowMs);
    } else {
      // Existing non-operator rate-limit buckets predate the rolling event
      // list. Preserve their count conservatively at the old window start.
      const legacyCount = Math.max(0, Math.min(limit, Number(current.attempts) || 0));
      timestamps = Array.from({ length: legacyCount }, () => current.windowStart.getTime());
    }
  }
  const active = timestamps.filter((timestamp) => timestamp > cutoff).sort((left, right) => left - right);
  if (active.length >= limit) {
    const blockedUntil = new Date(active[0] + windowMs);
    return {
      allowed: false,
      action: 'blocked',
      attempts: active.length,
      windowStart: new Date(active[0]),
      attemptTimestamps: active.map((timestamp) => new Date(timestamp).toISOString()),
      retryAfterMs: Math.max(1, blockedUntil.getTime() - nowMs),
      blockedUntil,
    };
  }
  const next = [...active, nowMs].sort((left, right) => left - right);
  return {
    allowed: true,
    action: current ? 'update' : 'create',
    attempts: next.length,
    windowStart: new Date(next[0]),
    attemptTimestamps: next.map((timestamp) => new Date(timestamp).toISOString()),
  };
}
