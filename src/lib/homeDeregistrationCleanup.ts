import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { cleanupCustomerAccountIfOrphaned } from './customerRelationshipCleanup';
import { serializableTransaction } from './serializableTransaction';

const AGGREGATE = 'FullHomeDeregistrationAccountCleanup';
const EVENT = 'FULL_HOME_ACCOUNT_CLEANUP';
const MAX_ATTEMPTS = 8;
const STALE_PROCESSING_MS = 5 * 60_000;

export type HomeDeregistrationCleanupResult = {
  evaluated: number;
  deferred: number;
  failed: number;
  pending: number;
};

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Queue one private, idempotent account-cleanup checkpoint per removed Home
 * relationship. The Home's authority and private data are already committed
 * before this runs. Each account is processed in its own short transaction, so
 * a process restart cannot roll the whole Home reset back or strand a long
 * serializable transaction. These internal rows are not customer notifications.
 */
export async function queueHomeDeregistrationAccountCleanup(
  tx: Prisma.TransactionClient,
  input: { homeId: string; accountIds: string[]; now: Date },
) {
  const accountIds = [...new Set(input.accountIds)].filter(validUuid).sort();
  if (!accountIds.length) return 0;
  const expiresAt = new Date(input.now.getTime() + 29 * 24 * 60 * 60_000);
  const inserted = await tx.nativeDomainOutbox.createMany({
    data: accountIds.map((accountId) => ({
      homeId: input.homeId,
      aggregateType: AGGREGATE,
      aggregateId: accountId,
      eventType: EVENT,
      idempotencyKey: `full-home-deregistration-account:${input.homeId}:${accountId}`,
      payload: { version: 1, action: 'ORPHAN_ACCOUNT_CLEANUP' },
      expiresAt,
    })),
    skipDuplicates: true,
  });
  return inserted.count;
}

/**
 * Resume a bounded number of checkpoints. The existing two-minute operations
 * dispatch calls this function; the homeowner commit also runs a small bounded
 * slice immediately for prompt completion. No new scheduler is introduced.
 */
export async function resumeHomeDeregistrationAccountCleanup(
  now = new Date(),
  options: { homeId?: string; limit?: number } = {},
): Promise<HomeDeregistrationCleanupResult> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 24)));
  const scope = options.homeId ? { homeId: options.homeId } : {};
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  await prisma.nativeDomainOutbox.updateMany({
    where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: 'PROCESSING', attempts: { lt: MAX_ATTEMPTS }, updatedAt: { lt: staleBefore } },
    data: { state: 'PENDING', nextAttemptAt: now },
  });
  await prisma.nativeDomainOutbox.updateMany({
    where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: 'PROCESSING', attempts: { gte: MAX_ATTEMPTS } },
    data: { state: 'FAILED' },
  });
  await prisma.nativeDomainOutbox.updateMany({
    where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: 'PENDING', attempts: { gte: MAX_ATTEMPTS } },
    data: { state: 'FAILED' },
  });
  await prisma.nativeDomainOutbox.updateMany({
    where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: { in: ['PENDING', 'PROCESSING'] }, expiresAt: { lte: now } },
    data: { state: 'FAILED' },
  });

  const rows = await prisma.nativeDomainOutbox.findMany({
    where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: 'PENDING', nextAttemptAt: { lte: now }, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit,
    select: { id: true, homeId: true, aggregateId: true, attempts: true },
  });
  let evaluated = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of rows) {
    const nextAttempt = row.attempts + 1;
    let cleanupPhase = 'begin_checkpoint';
    try {
      const claimed = await serializableTransaction(async (tx) => {
        if (!validUuid(row.aggregateId) || !row.homeId) throw new Error('Invalid internal cleanup checkpoint');
        // Keep the account lock first, matching relationship creation/removal
        // authorities and preventing a final-membership race.
        cleanupPhase = 'lock_customer_account';
        await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${row.aggregateId}::uuid FOR UPDATE`;
        cleanupPhase = 'claim_checkpoint';
        const claim = await tx.nativeDomainOutbox.updateMany({
          where: { id: row.id, aggregateType: AGGREGATE, eventType: EVENT, state: 'PENDING', attempts: row.attempts, expiresAt: { gt: now } },
          data: { state: 'PROCESSING', attempts: { increment: 1 } },
        });
        if (claim.count !== 1) return false;
        cleanupPhase = 'cleanup_orphaned_account';
        await cleanupCustomerAccountIfOrphaned(tx, row.aggregateId, now,
          'full_home_deregistration', 'FULL_HOME_DEREGISTRATION_ACCOUNT_CLEANUP');
        cleanupPhase = 'complete_checkpoint';
        const completed = await tx.nativeDomainOutbox.updateMany({
          where: { id: row.id, state: 'PROCESSING', attempts: nextAttempt },
          data: { state: 'DELIVERED' },
        });
        if (completed.count !== 1) throw new Error('Cleanup checkpoint changed during processing');
        return true;
      }, 3, { maxWaitMs: 2_000, timeoutMs: 8_000 });
      if (claimed) evaluated += 1;
    } catch (error) {
      const terminal = nextAttempt >= MAX_ATTEMPTS;
      const delayMs = Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, row.attempts)));
      const failure = error && typeof error === 'object'
        ? error as { name?: unknown; code?: unknown; message?: unknown; customerCleanupPhase?: unknown; meta?: { code?: unknown; sqlState?: unknown; sqlstate?: unknown; field_name?: unknown; constraint?: unknown } }
        : {};
      const safe = (value: unknown) => /^[A-Za-z0-9_.-]{1,120}$/.test(String(value ?? '')) ? String(value) : 'unknown';
      // Some Prisma request errors keep the formatted failure on Error's
      // string conversion rather than an enumerable message field. Sanitize
      // either form before allowing even a bounded token into test/operator logs.
      const message = typeof failure.message === 'string' && failure.message.trim()
        ? failure.message : String(error ?? '')
      const detail = message
        .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, 'db-url')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'email')
        .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, 'uuid')
        .replace(/\b[0-9a-f_-]{24,}\b/gi, 'opaque')
        .replace(/(['"`])(?:(?!\1).)*\1/g, 'literal')
        .replace(/\b\d+\b/g, 'n').replace(/\s+/g, ' ').trim().slice(0, 110)
        .replace(/[^A-Za-z0-9_.-]/g, '_');
      console.error(`[stage9:dereg-cleanup] retryable-failure phase=${safe(failure.customerCleanupPhase ?? cleanupPhase)} name=${safe(failure.name)} code=${safe(failure.code)} sqlstate=${safe(failure.meta?.code ?? failure.meta?.sqlState ?? failure.meta?.sqlstate)} constraint=${safe(failure.meta?.constraint ?? failure.meta?.field_name)} detail=${safe(detail)}`);
      const recorded = await prisma.nativeDomainOutbox.updateMany({
        where: { id: row.id, aggregateType: AGGREGATE, eventType: EVENT, state: 'PENDING', attempts: row.attempts },
        data: { state: terminal ? 'FAILED' : 'PENDING', attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + delayMs) },
      }).catch(() => ({ count: 0 }));
      if (recorded.count === 1) {
        if (terminal) failed += 1;
        else deferred += 1;
      }
    }
  }

  const [pending, processing, failedRows] = await Promise.all([
    prisma.nativeDomainOutbox.count({ where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: 'PENDING' } }),
    prisma.nativeDomainOutbox.count({ where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: 'PROCESSING' } }),
    prisma.nativeDomainOutbox.count({ where: { ...scope, aggregateType: AGGREGATE, eventType: EVENT, state: 'FAILED' } }),
  ]);
  return { evaluated, deferred, failed: failed + failedRows, pending: pending + processing };
}
