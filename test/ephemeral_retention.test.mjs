import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/nativeEphemeralRetention.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const isolated = { exports: {} };
new Function('module', 'exports', compiled)(isolated, isolated.exports);
const { cleanEphemeralRecords, cleanExpiredHubSyncReceipts } = isolated.exports;
const now = new Date('2026-10-25T12:00:00Z');
function database({ execute = async () => 0, available = false, remaining = false } = {}) {
  return { $executeRaw: execute, $queryRaw: async (sql) => sql.join('').includes('to_regclass')
    ? [{ available }] : [{ present: remaining }] };
}

test('expired nonce cleanup is parameterized and missing pg_cron is explicitly skipped', async () => {
  const calls = [];
  const result = await cleanEphemeralRecords(database({ execute: async (sql, ...values) => {
    calls.push({ sql: sql.join(''), values }); return 7;
  } }), now);
  assert.equal(result.expiredReplayNonces, 7);
  assert.equal(result.cronHistoryAvailable, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /"expiresAt" <=/);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(calls[0].values, [now, 1000]);
});

test('completed cron runs use strict seven-day cutoff; live runs are excluded', async () => {
  const calls = [];
  const result = await cleanEphemeralRecords(database({ available: true, execute: async (sql, ...values) => {
    calls.push({ sql: sql.join(''), values }); return calls.length === 1 ? 2 : 3;
  } }), now);
  assert.equal(result.cronRunsDeleted, 3);
  assert.match(calls[1].sql, /end_time </);
  assert.match(calls[1].sql, /status IN \('succeeded', 'failed'\)/);
  assert.deepEqual(calls[1].values, [new Date('2026-10-18T12:00:00Z'), 1000]);
});

test('batch ceiling records remaining backlog instead of running without a bound', async () => {
  let calls = 0;
  const result = await cleanEphemeralRecords(database({ remaining: true, execute: async () => { calls++; return 1000; } }), now, () => 0);
  assert.equal(calls, 100);
  assert.equal(result.expiredReplayNonces, 100000);
  assert.equal(result.replayBacklogRemains, true);
});

test('elapsed time stops further deletes while preserving backlog visibility', async () => {
  let ticks = 0; let deletes = 0;
  const result = await cleanEphemeralRecords(database({ available: true, remaining: true, execute: async () => { deletes++; return 1000; } }), now, () => (ticks++ === 0 ? 0 : 16000));
  assert.equal(deletes, 0);
  assert.equal(result.replayBacklogRemains, true);
  assert.equal(result.cronBacklogRemains, true);
});

test('unexpected database errors and invalid cutoffs are surfaced', async () => {
  await assert.rejects(cleanEphemeralRecords(database({ execute: async () => { throw new Error('permission denied'); } }), now), /permission denied/);
  await assert.rejects(cleanEphemeralRecords(database(), new Date('invalid')), /Invalid retention cutoff/);
  await assert.rejects(cleanExpiredHubSyncReceipts(database(), new Date('invalid')), /Invalid receipt retention cutoff/);
});

test('expired Hub sync receipts are deleted in bounded, retry-safe batches while live retry receipts remain', async () => {
  const calls = [];
  const db = {
    $executeRaw: async (sql, ...values) => { calls.push({ sql: sql.join(''), values }); return 23; },
    $queryRaw: async () => [{ present: false }],
  };
  const result = await cleanExpiredHubSyncReceipts(db, now);
  assert.equal(result.deleted, 23);
  assert.equal(result.backlogRemains, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM public\."HubSyncReceipt" WHERE "expiresAt" <=/);
  assert.match(calls[0].sql, /LIMIT/);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(calls[0].values, [now, 1000]);
});

test('expired receipt cleanup caps work and reports backlog for the next normal maintenance run', async () => {
  let calls = 0;
  const result = await cleanExpiredHubSyncReceipts({
    $executeRaw: async () => { calls += 1; return 1000; },
    $queryRaw: async () => [{ present: true }],
  }, now, () => 0);
  assert.equal(calls, 100);
  assert.equal(result.deleted, 100000);
  assert.equal(result.backlogRemains, true);
  assert.equal(result.batchSize, 1000);
  assert.equal(result.maxRowsPerRun, 100000);
  assert.equal(result.timeBudgetMs, 15000);
});

test('real PostgreSQL preserves unexpired nonces, recent/active cron logs and retries safely', {
  skip: !process.env.DINODIA_RETENTION_TEST_DATABASE_URL,
}, async () => {
  const url = new URL(process.env.DINODIA_RETENTION_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/dinodia_retention_test');
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    await db.$executeRawUnsafe('CREATE TABLE "ReplayNonce" (id uuid PRIMARY KEY, "expiresAt" timestamptz NOT NULL)');
    await db.$executeRawUnsafe('CREATE TABLE "HubSyncReceipt" (id uuid PRIMARY KEY, "expiresAt" timestamptz NOT NULL)');
    await db.$executeRawUnsafe('CREATE INDEX "HubSyncReceipt_expiresAt_idx" ON "HubSyncReceipt"("expiresAt")');
    await db.$executeRawUnsafe('CREATE SCHEMA cron');
    await db.$executeRawUnsafe('CREATE TABLE cron.job_run_details (runid bigint PRIMARY KEY, status text NOT NULL, end_time timestamptz)');
    await db.$executeRaw`INSERT INTO "ReplayNonce" SELECT gen_random_uuid(), ${now}::timestamptz - interval '1 second' FROM generate_series(1,1005)`;
    await db.$executeRaw`INSERT INTO "ReplayNonce" VALUES (gen_random_uuid(), ${now}), (gen_random_uuid(), ${now}::timestamptz + interval '1 second')`;
    await db.$executeRawUnsafe(`INSERT INTO cron.job_run_details VALUES
      (1,'succeeded','2026-10-18T11:59:59Z'), (2,'failed','2026-10-17T12:00:00Z'),
      (3,'succeeded','2026-10-18T12:00:00Z'), (4,'succeeded','2026-10-25T11:00:00Z'),
      (5,'running',NULL), (6,'running','2026-10-17T12:00:00Z')`);
    await db.$executeRaw`INSERT INTO "HubSyncReceipt" SELECT gen_random_uuid(), ${now}::timestamptz - interval '1 second' FROM generate_series(1,1005)`;
    await db.$executeRaw`INSERT INTO "HubSyncReceipt" VALUES (gen_random_uuid(), ${now}), (gen_random_uuid(), ${now}::timestamptz + interval '1 second')`;
    const result = await cleanEphemeralRecords(db, now);
    assert.equal(result.expiredReplayNonces, 1006);
    assert.equal(result.cronRunsDeleted, 2);
    assert.equal(result.replayBacklogRemains, false);
    assert.equal(result.cronBacklogRemains, false);
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM "ReplayNonce"`)[0].n, 1);
    assert.deepEqual((await db.$queryRaw`SELECT runid::int AS id FROM cron.job_run_details ORDER BY runid`).map(x => x.id), [3,4,5,6]);
    const receipts = await cleanExpiredHubSyncReceipts(db, now);
    assert.equal(receipts.deleted, 1006, 'the exact expiry boundary is eligible while later expiries survive');
    assert.equal(receipts.backlogRemains, false);
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM "HubSyncReceipt"`)[0].n, 1);
    assert.equal((await cleanExpiredHubSyncReceipts(db, now)).deleted, 0, 'cleanup is idempotent after the eligible range is drained');

    const lockedId = '00000000-0000-4000-8000-000000000001';
    const unlockedId = '00000000-0000-4000-8000-000000000002';
    await db.$executeRaw`INSERT INTO "HubSyncReceipt" VALUES (${lockedId}::uuid, ${now}::timestamptz - interval '1 second'), (${unlockedId}::uuid, ${now}::timestamptz - interval '1 second')`;
    let releaseLock;
    const holdLock = new Promise((resolve) => { releaseLock = resolve; });
    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    const lockTransaction = db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT id FROM "HubSyncReceipt" WHERE id = ${lockedId}::uuid FOR UPDATE`;
      assert.equal(rows.length, 1);
      signalLocked();
      await holdLock;
    }, { timeout: 15_000 });
    await locked;
    try {
      const concurrent = await cleanExpiredHubSyncReceipts(db, now);
      assert.equal(concurrent.deleted, 1, 'SKIP LOCKED lets cleanup make progress around an in-flight receipt');
      assert.equal(concurrent.backlogRemains, true, 'a locked eligible row remains visible as backlog');
    } finally {
      releaseLock();
      await lockTransaction;
    }
    const resumed = await cleanExpiredHubSyncReceipts(db, now);
    assert.equal(resumed.deleted, 1, 'the next normal cleanup can safely remove the formerly locked receipt');
    assert.equal(resumed.backlogRemains, false);
    const retry = await cleanEphemeralRecords(db, now);
    assert.equal(retry.expiredReplayNonces, 0);
    assert.equal(retry.cronRunsDeleted, 0);
    await db.$executeRawUnsafe('DROP SCHEMA cron CASCADE');
    assert.equal((await cleanEphemeralRecords(db, now)).cronHistoryAvailable, false);
  } finally { await db.$disconnect(); }
});
