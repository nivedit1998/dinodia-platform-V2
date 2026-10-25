import type { PrismaClient } from '@prisma/client';

export const EPHEMERAL_RETENTION_BATCH_SIZE = 1000;
export const EPHEMERAL_RETENTION_MAX_BATCHES = 100;
export const CRON_RUN_RETENTION_DAYS = 7;
const MAX_RUNTIME_MS = 15_000;

// Reuse the daily maintenance dispatcher. These are transport security receipts
// and completed scheduler logs, never household history or deletion tombstones.
export async function cleanEphemeralRecords(
  db: Pick<PrismaClient, '$executeRaw' | '$queryRaw'>,
  now: Date,
  monotonicNow: () => number = () => performance.now(),
) {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid retention cutoff');
  const deadline = monotonicNow() + MAX_RUNTIME_MS;
  let expiredReplayNonces = 0;
  let cronRunsDeleted = 0;
  let replayBacklogRemains = false;
  let cronBacklogRemains = false;
  for (let batch = 0; batch < EPHEMERAL_RETENTION_MAX_BATCHES; batch += 1) {
    if (monotonicNow() >= deadline) break;
    const deleted = Number(await db.$executeRaw`
      WITH doomed AS (
        SELECT "id" FROM "ReplayNonce" WHERE "expiresAt" <= ${now}
        ORDER BY "expiresAt", "id" LIMIT ${EPHEMERAL_RETENTION_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ) DELETE FROM "ReplayNonce" AS target USING doomed WHERE target."id" = doomed."id"`);
    expiredReplayNonces += deleted;
    if (deleted < EPHEMERAL_RETENTION_BATCH_SIZE) break;
  }
  const replayRemaining = await db.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM "ReplayNonce" WHERE "expiresAt" <= ${now}) AS present`;
  replayBacklogRemains = replayRemaining[0]?.present === true;

  // pg_cron is not installed in ordinary Postgres test/development environments.
  // A missing extension is explicit; permission or SQL errors still fail the task.
  const cron = await db.$queryRaw<{ available: boolean }[]>`
    SELECT to_regclass('cron.job_run_details') IS NOT NULL AS available`;
  const cronHistoryAvailable = cron[0]?.available === true;
  const cronCutoff = new Date(now.getTime() - CRON_RUN_RETENTION_DAYS * 86_400_000);
  if (cronHistoryAvailable) {
    for (let batch = 0; batch < EPHEMERAL_RETENTION_MAX_BATCHES; batch += 1) {
      if (monotonicNow() >= deadline) break;
      const deleted = Number(await db.$executeRaw`
        WITH doomed AS (
          SELECT runid FROM cron.job_run_details
          WHERE end_time < ${cronCutoff} AND status IN ('succeeded', 'failed')
          ORDER BY end_time, runid LIMIT ${EPHEMERAL_RETENTION_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        ) DELETE FROM cron.job_run_details AS target USING doomed WHERE target.runid = doomed.runid`);
      cronRunsDeleted += deleted;
      if (deleted < EPHEMERAL_RETENTION_BATCH_SIZE) break;
    }
    const remaining = await db.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM cron.job_run_details
        WHERE end_time < ${cronCutoff} AND status IN ('succeeded', 'failed')) AS present`;
    cronBacklogRemains = remaining[0]?.present === true;
  }
  return { checkedThrough: now.toISOString(), expiredReplayNonces, cronRunsDeleted,
    cronHistoryAvailable, cronRetentionDays: CRON_RUN_RETENTION_DAYS,
    replayBacklogRemains, cronBacklogRemains,
    batchSize: EPHEMERAL_RETENTION_BATCH_SIZE, maximumRowsPerTable: EPHEMERAL_RETENTION_BATCH_SIZE * EPHEMERAL_RETENTION_MAX_BATCHES,
    timeBudgetMs: MAX_RUNTIME_MS };
}
