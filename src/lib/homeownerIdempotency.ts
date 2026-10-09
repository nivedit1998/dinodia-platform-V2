import type { Prisma } from '@prisma/client';
import { sha256 } from './stage1Crypto';
import { Stage1AuthError } from './stage1Auth';

const keyPattern = /^[A-Za-z0-9._:-]{16,160}$/;

export function homeownerIdempotencyIdentity(actorId: string, key: string, namespace: string) {
  if (!keyPattern.test(key)) throw new Stage1AuthError(400, 'IDEMPOTENCY_KEY_INVALID', 'A valid request key is required');
  return { namespace, keyHash: sha256(`${actorId}:${key}`) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function homeownerRequestHash(value: unknown): string { return sha256(canonical(value)); }

/**
 * Serializes by idempotency key and stores the exact response in the same DB
 * transaction as the mutation. The callback must contain database effects
 * only; any email/push is queued through the owning outbox.
 */
export async function runIdempotentHomeMutation<T extends Record<string, unknown>>(db: Prisma.TransactionClient, input: {
  namespace: string; keyHash: string; actorId: string; homeId: string; requestHash: string; now?: Date;
  beforeLookup?: () => Promise<void>;
  operation: () => Promise<T>;
}): Promise<T> {
  // Project PostgreSQL's `void` lock result to a supported Prisma scalar.
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.namespace}:${input.keyHash}`}, 0)) IS NULL AS acquired`;
  // The caller acquires its shared Home lock and revalidates live authority
  // here, before an exact retry can read or disclose an old mutation receipt.
  await input.beforeLookup?.();
  const now = input.now ?? new Date();
  const prior = await db.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: input.namespace, keyHash: input.keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
  if (prior) {
    if (prior.actorId !== input.actorId || prior.homeId !== input.homeId || prior.requestHash !== input.requestHash
      || prior.expiresAt <= now || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)) {
      throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used');
    }
    return prior.responseBody as T;
  }
  const response = await input.operation();
  await db.idempotencyRecord.create({ data: {
    namespace: input.namespace, keyHash: input.keyHash, actorId: input.actorId, homeId: input.homeId,
    requestHash: input.requestHash, responseStatus: 200, responseBody: response as Prisma.InputJsonValue,
    responseDigest: sha256(canonical(response)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  } });
  return response;
}
