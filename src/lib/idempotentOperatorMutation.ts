import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { sha256 } from './stage1Crypto';
import { decideOperatorRateLimit } from './operatorRateLimitPolicy.mjs';

type Transaction = Prisma.TransactionClient;
type SafeBody = Record<string, string | number | boolean | null>;

type RateResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Consume one operation attempt inside the same serializable transaction as
 * the idempotency record and protected mutation. Tests can supply a fixed UTC
 * clock; production callers use the server clock.
 */
export async function consumeOperatorMutationRateLimit(
  tx: Transaction,
  bucketKey: string,
  now: Date,
  limit = 5,
  windowMs = 60 * 60 * 1000,
): Promise<RateResult> {
  const current = await tx.authRateLimitBucket.findUnique({
    where: { bucketKey },
    select: { id: true, windowStart: true, attempts: true, attemptTimestamps: true, blockedUntil: true },
  });
  const decision = decideOperatorRateLimit(current, now, limit, windowMs);
  const rateState = {
    windowStart: decision.windowStart,
    attempts: decision.attempts,
    attemptTimestamps: decision.attemptTimestamps as Prisma.InputJsonValue,
  };
  if (decision.action === 'create') {
    await tx.authRateLimitBucket.create({ data: { bucketKey, ...rateState } });
    return { allowed: true };
  }
  if (!current) throw new Error('Operator rate-limit policy returned an invalid bucket transition');
  if (decision.action === 'blocked') {
    if (decision.blockedUntil && (!current.blockedUntil || decision.blockedUntil.getTime() !== current.blockedUntil.getTime())) {
      await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { ...rateState, blockedUntil: decision.blockedUntil } });
    }
    return { allowed: false, retryAfterMs: decision.retryAfterMs };
  }
  await tx.authRateLimitBucket.update({ where: { id: current.id }, data: { ...rateState, blockedUntil: null } });
  return { allowed: true };
}

export async function runIdempotentOperatorMutation<TContext>(input: {
  operation: 'operator-rotate' | 'operator-revoke';
  actorId: string;
  homeId: string;
  idempotencyKey: string;
  requestIdentity: Record<string, string | number | boolean | null>;
  resolve: (tx: Transaction) => Promise<TContext>;
  mutate: (tx: Transaction, context: TContext, now: Date) => Promise<SafeBody>;
  now?: () => Date;
}): Promise<{ status: number; body: SafeBody; replayed: boolean }> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) {
    throw new Stage1AuthError(400, 'idempotency_key_invalid', 'A valid idempotency key is required');
  }
  const namespace = `${input.operation}:v1`;
  const keyHash = sha256(`${input.actorId}:${idempotencyKey}`);
  const requestHash = sha256(JSON.stringify({
    operation: input.operation,
    actorId: input.actorId,
    homeId: input.homeId,
    request: input.requestIdentity,
  }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = input.now?.() ?? new Date();
    try {
      const result = await prisma.$transaction(async (tx) => {
        const prior = await tx.idempotencyRecord.findUnique({
          where: { namespace_keyHash: { namespace, keyHash } },
          select: { actorId: true, homeId: true, hubInstallationId: true, requestHash: true, responseStatus: true, responseBody: true, expiresAt: true },
        });
        if (prior) {
          if (prior.actorId !== input.actorId || prior.homeId !== input.homeId || !prior.hubInstallationId || prior.requestHash !== requestHash) {
            throw new Stage1AuthError(409, 'idempotency_key_reused', 'The idempotency key was already used for a different request');
          }
          if (prior.expiresAt <= now || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)) {
            throw new Stage1AuthError(409, 'idempotency_result_expired', 'The original operation result is no longer available');
          }
          return { kind: 'complete' as const, status: prior.responseStatus, body: prior.responseBody as SafeBody, replayed: true };
        }

        const context = await input.resolve(tx);
        const rate = await consumeOperatorMutationRateLimit(
          tx,
          `${input.operation}:${input.actorId}:${contextHubId(context)}`,
          now,
        );
        if (!rate.allowed) return { kind: 'limited' as const, retryAfterMs: rate.retryAfterMs };

        const idempotency = await tx.idempotencyRecord.create({
          data: {
            namespace,
            keyHash,
            actorId: input.actorId,
            homeId: input.homeId,
            hubInstallationId: contextHubId(context),
            requestHash,
            responseStatus: 200,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
          select: { id: true },
        });
        const body = await input.mutate(tx, context, now);
        await tx.idempotencyRecord.update({
          where: { id: idempotency.id },
          data: {
            responseDigest: sha256(JSON.stringify(body)),
            responseBody: body as Prisma.InputJsonValue,
          },
        });
        return { kind: 'complete' as const, status: 200, body, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      if (result.kind === 'limited') {
        throw new Stage1AuthError(429, 'rate_limited', `Too many attempts. Retry in ${Math.ceil(result.retryAfterMs / 1000)} seconds`);
      }
      return { status: result.status, body: result.body, replayed: result.replayed };
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      if ((code === 'P2002' || code === 'P2034') && attempt < 4) continue;
      if (code === 'P2002' || code === 'P2034') {
        throw new Stage1AuthError(503, 'operator_operation_retry_exhausted', 'The operation could not be completed safely; retry with the same idempotency key');
      }
      throw error;
    }
  }
  throw new Stage1AuthError(503, 'operator_operation_retry_exhausted', 'The operation could not be completed safely; retry with the same idempotency key');
}

// Resolve callbacks must return this property so each operator+hub gets its
// own bucket, independent of home identifiers supplied by the caller.
function contextHubId(context: unknown): string {
  if (!context || typeof context !== 'object' || !('hubInstallationId' in context)) {
    throw new Error('Operator mutation context is missing its resolved hub');
  }
  const hubInstallationId = String((context as { hubInstallationId: unknown }).hubInstallationId ?? '');
  if (!hubInstallationId) throw new Error('Operator mutation context is missing its resolved hub');
  return hubInstallationId;
}

export type { Transaction as OperatorMutationTransaction };
