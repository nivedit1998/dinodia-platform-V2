import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertMigrationDoesNotReferenceVolatileRuntimeTables, compareExistingTablePreservation } from '../scripts/native_migration_preservation.mjs';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const osRoot = process.env.DINODIA_OS_ROOT || path.resolve(root, '..', 'Dinodia OS');
const readOs = (file) => fs.readFileSync(path.join(osRoot, file), 'utf8');
const requireOsModule = (file) => createRequire(import.meta.url)(path.join(osRoot, file));

test('Stage 3 preservation proof isolates only volatile ReplayNonce runtime churn', () => {
  const before = {
    rowCounts: { Home: '2', ReplayNonce: '4' },
    rowContentDigests: { Home: 'home-digest', ReplayNonce: 'nonce-before' },
    columnContentDigests: { Home: { id: 'home-id', lifecycle: 'active' }, ReplayNonce: { id: 'nonce-id' } },
  };
  const after = {
    rowCounts: { Home: '2', ReplayNonce: '5', NewStage3Table: '0' },
    rowContentDigests: { Home: 'home-digest', ReplayNonce: 'nonce-after', NewStage3Table: '' },
    columnContentDigests: { Home: { id: 'home-id', lifecycle: 'active' }, ReplayNonce: { id: 'nonce-id' }, NewStage3Table: { id: '' } },
  };
  assert.doesNotThrow(() => assertMigrationDoesNotReferenceVolatileRuntimeTables('CREATE TABLE "NewStage3Table" ("id" text);'));
  assert.deepEqual(compareExistingTablePreservation(before, after), {
    changedExistingCounts: [],
    changedExistingRows: [],
    volatileChanges: [{ table: 'ReplayNonce', rowCountChanged: true, rowContentChanged: true }],
  });
  assert.throws(() => assertMigrationDoesNotReferenceVolatileRuntimeTables('DELETE FROM "ReplayNonce";'), /references the volatile/);
  assert.throws(() => compareExistingTablePreservation(before, { ...after, rowCounts: { ...after.rowCounts, Home: '3' } }), /nonvolatile.*row counts changed/);
  assert.throws(() => compareExistingTablePreservation(before, { ...after, rowContentDigests: { ...after.rowContentDigests, Home: 'changed' } }), /nonvolatile.*row content changed/);
  assert.throws(() => compareExistingTablePreservation(before, { rowCounts: { ReplayNonce: '4' }, rowContentDigests: { ReplayNonce: 'nonce-before' } }), /base-table inventory changed/);

  const hubBefore = {
    rowCounts: { HubInstallation: '1' },
    rowContentDigests: { HubInstallation: 'hub-before' },
    columnContentDigests: { HubInstallation: { id: 'id', lastSeenAt: 't1', onlineStateEvaluatedAt: 't1', updatedAt: 't1', lanEndpointReportedAt: 't1', lanTlsReportedAt: 't1', baseUrl: 'endpoint1' } },
  };
  const hubAfter = {
    rowCounts: { HubInstallation: '1' },
    rowContentDigests: { HubInstallation: 'hub-after' },
    columnContentDigests: { HubInstallation: { id: 'id', lastSeenAt: 't2', onlineStateEvaluatedAt: 't2', updatedAt: 't2', lanEndpointReportedAt: 't2', lanTlsReportedAt: 't2', baseUrl: 'endpoint1' } },
  };
  assert.deepEqual(compareExistingTablePreservation(hubBefore, hubAfter).volatileChanges, [{
    table: 'HubInstallation', rowCountChanged: false, rowContentChanged: true,
    changedColumns: ['lastSeenAt', 'onlineStateEvaluatedAt', 'updatedAt', 'lanEndpointReportedAt', 'lanTlsReportedAt'],
  }]);
  assert.throws(() => compareExistingTablePreservation(hubBefore, {
    ...hubAfter,
    columnContentDigests: { HubInstallation: { ...hubAfter.columnContentDigests.HubInstallation, baseUrl: 'endpoint2' } },
  }), /HubInstallation\.baseUrl/);
});

test('migration preservation permits live scheduler lease/cursor churn but protects task identity, owner and row count', () => {
  const before = {
    rowCounts: { NativeBackgroundTaskState: '2' },
    rowContentDigests: { NativeBackgroundTaskState: 'before' },
    columnContentDigests: { NativeBackgroundTaskState: {
      taskId: 'ids', dispatcher: 'owners', leaseOwner: 'old-lease', cursor: 'old-cursor', updatedAt: 't1',
    } },
  };
  const after = {
    rowCounts: { NativeBackgroundTaskState: '2' },
    rowContentDigests: { NativeBackgroundTaskState: 'after' },
    columnContentDigests: { NativeBackgroundTaskState: {
      taskId: 'ids', dispatcher: 'owners', leaseOwner: 'new-lease', cursor: 'new-cursor', updatedAt: 't2',
    } },
  };
  assert.deepEqual(compareExistingTablePreservation(before, after).volatileChanges, [{
    table: 'NativeBackgroundTaskState', rowCountChanged: false, rowContentChanged: true,
    changedColumns: ['leaseOwner', 'cursor', 'updatedAt'],
  }]);
  assert.throws(() => compareExistingTablePreservation(before, {
    ...after,
    columnContentDigests: { NativeBackgroundTaskState: { ...after.columnContentDigests.NativeBackgroundTaskState, dispatcher: 'different-owner' } },
  }), /NativeBackgroundTaskState\.dispatcher/);
  assert.throws(() => compareExistingTablePreservation(before, {
    ...after, rowCounts: { NativeBackgroundTaskState: '3' },
  }), /nonvolatile.*row counts changed/);
});

function loadTypeScriptModule(relativePath, overrides = {}) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = read(relativePath);
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => overrides[specifier] ?? require(specifier);
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
  return module.exports;
}

test('temporary internal day mode is disabled unless the exact opt-in is present', () => {
  const { internalOperatorDaySessionEnabled } = loadTypeScriptModule('src/lib/internalOperatorDaySession.ts');
  assert.equal(internalOperatorDaySessionEnabled({}), false);
  assert.equal(internalOperatorDaySessionEnabled({ STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'false' }), false);
  assert.equal(internalOperatorDaySessionEnabled({ STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'TRUE' }), false);
  assert.equal(internalOperatorDaySessionEnabled({ STAGE1_INTERNAL_OPERATOR_DAY_SESSION: ' true ' }), false);
  assert.equal(internalOperatorDaySessionEnabled({ STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'true' }), true);
});

test('native task registry dispatches business operations and daily lease cleanup to disjoint owners', async () => {
  const cleanupCalls = [];
  const receiptCleanupCalls = [];
  const { nativeTaskRegistry, runNativeOperations, runNativeMaintenance } = loadTypeScriptModule('src/lib/nativeOperations.ts', {
    './prisma': { prisma: {
      nativeBackgroundTaskState: { updateMany: async (input) => { cleanupCalls.push(input); return { count: 3 }; } },
      hubSyncReceipt: { deleteMany: async (input) => { receiptCleanupCalls.push(input); return { count: 2 }; } },
      $transaction: async (callback) => callback({ nativeBackgroundTaskState: { updateMany: async () => ({ count: 0 }) } }),
      supportSession: { findMany: async () => [] },
      supportAccessRequest: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
      homeClaimReservation: { findMany: async () => [] },
    } },
    './hubOperatorCredentials': { reconcileCredentialLifecycle: async () => ({ rotated: 0 }) },
    './stage1ClaimContract': { releaseExpiredClaim: async () => ({ released: false }) },
    './supportNotifications': { createPropertySupportNotifications: async () => undefined },
  });
  assert.deepEqual(nativeTaskRegistry.map(({ taskId, owner }) => [taskId, owner]), [
    ['operator_credential_lifecycle', 'supabase_pg_cron_two_minute'],
    ['support_expiry_and_revocation', 'supabase_pg_cron_two_minute'],
    ['claim_reservation_expiry', 'supabase_pg_cron_two_minute'],
    ['expired_dispatch_lease_cleanup', 'vercel_hobby_daily'],
  ]);
  const now = new Date('2026-09-27T12:00:00Z');
  const operations = await runNativeOperations(now);
  assert.deepEqual(operations.tasks, ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry']);
  assert.equal(cleanupCalls.length, 0);
  const maintenance = await runNativeMaintenance(now);
  assert.deepEqual(maintenance.tasks, ['expired_dispatch_lease_cleanup']);
  assert.equal(maintenance.expiredDispatcherLeases, 3);
  assert.equal(maintenance.expiredSyncReceipts, 2);
  assert.deepEqual(cleanupCalls, [{ where: { taskId: { not: 'expired_dispatch_lease_cleanup' }, leaseExpiresAt: { lte: now } }, data: { leaseOwner: null, leaseExpiresAt: null } }]);
  assert.deepEqual(receiptCleanupCalls, [{ where: { expiresAt: { lte: now } } }]);
});

test('native task registry rejects unknown tasks, duplicate tasks and dual-owner drift', () => {
  const { nativeTaskRegistry, validateNativeTaskRegistry } = loadTypeScriptModule('src/lib/nativeOperations.ts', {
    './prisma': { prisma: {} },
    './hubOperatorCredentials': { reconcileCredentialLifecycle: async () => ({}) },
    './stage1ClaimContract': { releaseExpiredClaim: async () => ({ released: false }) },
    './supportNotifications': { createPropertySupportNotifications: async () => undefined },
  });
  assert.equal(validateNativeTaskRegistry(nativeTaskRegistry), true);
  assert.throws(() => validateNativeTaskRegistry([...nativeTaskRegistry, { taskId: 'future_stage_task', owner: 'supabase_pg_cron_two_minute' }]), /unregistered/);
  assert.throws(() => validateNativeTaskRegistry([...nativeTaskRegistry, nativeTaskRegistry[0]]), /duplicate/);
  assert.throws(() => validateNativeTaskRegistry(nativeTaskRegistry.map((task) => task.taskId === 'claim_reservation_expiry' ? { ...task, owner: 'vercel_hobby_daily' } : task)), /misowned/);
  assert.throws(() => validateNativeTaskRegistry(nativeTaskRegistry.slice(0, -1)), /incomplete/);
});

test('native operations route rejects wrong scheduler secrets before lease or task dispatch', async () => {
  let leases = 0;
  let dispatched = 0;
  const routeModule = loadTypeScriptModule('src/app/api/cron/native-operations/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/nativeOperations': {
      acquireOperationsLease: async () => { leases += 1; return { owner: 'disposable-lease-owner', taskIds: ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'] }; },
      completeOperationsLease: async () => true,
      runNativeOperations: async () => { dispatched += 1; return { tasks: [], failedTasks: [] }; },
    },
  });
  const { POST } = routeModule;
  assert.deepEqual(Object.keys(routeModule).sort(), ['POST', 'dynamic'].sort(), 'Next.js route modules may export only framework route handlers/config');
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'disposable-stage2-cron-secret';
  try {
    const anonymous = await POST(new Request('http://127.0.0.1/api/cron/native-operations', { method: 'POST' }));
    const wrong = await POST(new Request('http://127.0.0.1/api/cron/native-operations', { method: 'POST', headers: { authorization: 'Bearer wrong' } }));
    assert.equal(anonymous.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(leases, 0, 'unauthorized schedule calls must not acquire a lease');
    assert.equal(dispatched, 0, 'unauthorized schedule calls must not reach registered tasks');
    const authorized = await POST(new Request('http://127.0.0.1/api/cron/native-operations', { method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(authorized.status, 200);
    assert.equal(leases, 1);
    assert.equal(dispatched, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test('daily maintenance route is the separate GET owner and rejects wrong scheduler secrets', async () => {
  let leases = 0;
  let cleanup = 0;
  const { GET } = loadTypeScriptModule('src/app/api/cron/native-maintenance/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/nativeOperations': {
      acquireOperationsLease: async (name) => { assert.equal(name, 'native-maintenance'); leases += 1; return { owner: 'disposable-lease-owner', taskIds: ['expired_dispatch_lease_cleanup'] }; },
      completeOperationsLease: async () => true,
      runNativeMaintenance: async () => { cleanup += 1; return { tasks: ['expired_dispatch_lease_cleanup'], expiredDispatcherLeases: 1 }; },
    },
  });
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'disposable-stage2-maintenance-secret';
  try {
    const anonymous = await GET(new Request('http://127.0.0.1/api/cron/native-maintenance'));
    const wrong = await GET(new Request('http://127.0.0.1/api/cron/native-maintenance', { headers: { authorization: 'Bearer wrong' } }));
    assert.equal(anonymous.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(leases, 0);
    assert.equal(cleanup, 0);
    const authorized = await GET(new Request('http://127.0.0.1/api/cron/native-maintenance', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(authorized.status, 200);
    assert.equal(leases, 1);
    assert.equal(cleanup, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test('native dispatcher uses one atomic bounded lease and isolates task failures', async () => {
  const dispatcherTasks = ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'];
  const taskRows = new Map(dispatcherTasks.map((taskId) => [taskId, { leaseOwner: 'already-running', leaseExpiresAt: new Date('2026-09-27T12:02:00Z') }]));
  const leaseCalls = [];
  let supportTaskReached = false;
  let claimTaskReached = false;
  const prisma = {
    nativeBackgroundTaskState: { updateMany: async (input) => {
      leaseCalls.push(input);
      const eligible = [...taskRows].filter(([taskId, row]) => input.where.taskId.in.includes(taskId)
        && row.leaseExpiresAt <= input.where.OR[1].leaseExpiresAt.lte);
      for (const [taskId] of eligible) taskRows.set(taskId, { leaseOwner: input.data.leaseOwner, leaseExpiresAt: input.data.leaseExpiresAt });
      return { count: eligible.length };
    } },
    $transaction: async (callback) => callback(prisma),
    supportSession: { findMany: async () => { supportTaskReached = true; throw new Error('isolated support database error'); } },
    supportAccessRequest: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    homeClaimReservation: { findMany: async () => { claimTaskReached = true; return []; } },
  };
  const { acquireOperationsLease, runNativeOperations } = loadTypeScriptModule('src/lib/nativeOperations.ts', {
    './prisma': { prisma },
    './hubOperatorCredentials': { reconcileCredentialLifecycle: async () => { throw new Error('credential task failure'); } },
    './stage1ClaimContract': { releaseExpiredClaim: async () => ({ released: false }) },
    './supportNotifications': { createPropertySupportNotifications: async () => undefined },
  });
  const start = new Date('2026-09-27T12:00:00Z');
  assert.equal(await acquireOperationsLease('native-operations', start), null, 'an existing live lease denies overlap');
  assert.deepEqual(leaseCalls[0].where.taskId.in, dispatcherTasks, 'lease ownership is stored on the three fixed operations task rows');
  assert.equal(leaseCalls[0].data.leaseExpiresAt.getTime() - start.getTime(), 120_000);

  const result = await runNativeOperations(start);
  assert.ok(supportTaskReached);
  assert.ok(claimTaskReached, 'claim cleanup continues after independent task failures');
  assert.deepEqual(result.failedTasks.sort(), ['operator_credential_lifecycle', 'support_expiry_and_revocation']);

  const concurrentRows = new Map(dispatcherTasks.map((taskId) => [taskId, { leaseOwner: null, leaseExpiresAt: null }]));
  const concurrentPrisma = {
    nativeBackgroundTaskState: { updateMany: async ({ where, data }) => {
      const eligible = [...concurrentRows].filter(([taskId, row]) => where.taskId.in.includes(taskId) && (row.leaseExpiresAt === null || row.leaseExpiresAt <= where.OR[1].leaseExpiresAt.lte));
      for (const [taskId] of eligible) concurrentRows.set(taskId, { leaseOwner: data.leaseOwner, leaseExpiresAt: data.leaseExpiresAt });
      return { count: eligible.length };
    } },
    $transaction: async (callback) => callback(concurrentPrisma),
  };
  const concurrentModule = loadTypeScriptModule('src/lib/nativeOperations.ts', {
    './prisma': { prisma: concurrentPrisma },
    './hubOperatorCredentials': { reconcileCredentialLifecycle: async () => ({}) },
    './stage1ClaimContract': { releaseExpiredClaim: async () => ({ released: false }) },
    './supportNotifications': { createPropertySupportNotifications: async () => undefined },
  });
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => concurrentModule.acquireOperationsLease('native-operations', start)));
  assert.equal(outcomes.filter(Boolean).length, 1, 'concurrent dispatchers must have one lease winner');
});

test('native dispatcher lease denies until the exact expiry and keeps the two owners isolated', async () => {
  const taskIds = ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry', 'expired_dispatch_lease_cleanup'];
  const taskRows = new Map(taskIds.map((taskId) => [taskId, { leaseOwner: null, leaseExpiresAt: null }]));
  const prisma = {
    nativeBackgroundTaskState: { updateMany: async ({ where, data }) => {
      const eligible = [...taskRows].filter(([taskId, row]) => where.taskId.in.includes(taskId)
        && taskId !== 'expired_dispatch_lease_cleanup' || where.taskId.in.includes(taskId) && taskId === 'expired_dispatch_lease_cleanup')
        .filter(([taskId, row]) => where.dispatcher === (taskId === 'expired_dispatch_lease_cleanup' ? 'MAINTENANCE' : 'OPERATIONS')
          && (row.leaseExpiresAt === null || where.OR?.some((condition) => condition.leaseExpiresAt?.lte && row.leaseExpiresAt <= condition.leaseExpiresAt.lte)));
      for (const [taskId] of eligible) taskRows.set(taskId, { leaseOwner: data.leaseOwner, leaseExpiresAt: data.leaseExpiresAt });
      return { count: eligible.length };
    } },
    $transaction: async (callback) => callback(prisma),
  };
  const { acquireOperationsLease } = loadTypeScriptModule('src/lib/nativeOperations.ts', {
    './prisma': { prisma },
    './hubOperatorCredentials': { reconcileCredentialLifecycle: async () => ({}) },
    './stage1ClaimContract': { releaseExpiredClaim: async () => ({ released: false }) },
    './supportNotifications': { createPropertySupportNotifications: async () => undefined },
  });
  const start = new Date('2026-09-30T12:00:00.000Z');
  const first = await acquireOperationsLease('native-operations', start);
  assert.ok(first);
  assert.equal(await acquireOperationsLease('native-operations', new Date(start.getTime() + 119_999)), null,
    'a lease remains occupied one millisecond before its deadline');
  const second = await acquireOperationsLease('native-operations', new Date(start.getTime() + 120_000));
  assert.ok(second,
    'the lease is replaceable at its exact inclusive expiry');
  assert.ok(await acquireOperationsLease('native-maintenance', new Date(start.getTime() + 120_000)),
    'the independent daily maintenance owner has its own lease key');
  assert.equal(await acquireOperationsLease('native-operations', new Date(start.getTime() + 120_000)), null,
    'the newly acquired operations lease is not confused with maintenance');
});

test('native expiry handlers use stable bounded oldest-first batches and conditional updates', async () => {
  const queries = [];
  const { NATIVE_OPERATION_BATCH_LIMIT, runNativeOperations } = loadTypeScriptModule('src/lib/nativeOperations.ts', {
    './prisma': { prisma: {
      supportSession: { findMany: async (query) => { queries.push(['support', query]); return []; } },
      supportAccessRequest: { findMany: async (query) => { queries.push(['request', query]); return [{ id: 'request:1' }]; }, updateMany: async (query) => { queries.push(['request-update', query]); return { count: 1 }; } },
      homeClaimReservation: { findMany: async (query) => { queries.push(['claim', query]); return []; } },
    } },
    './hubOperatorCredentials': { reconcileCredentialLifecycle: async () => ({ rotated: 0 }) },
    './stage1ClaimContract': { releaseExpiredClaim: async () => ({ released: false }) },
    './supportNotifications': { createPropertySupportNotifications: async () => undefined },
  });
  assert.equal(NATIVE_OPERATION_BATCH_LIMIT, 100);
  const result = await runNativeOperations(new Date('2026-09-29T12:00:00Z'));
  assert.deepEqual(result.failedTasks, []);
  assert.equal(result.expiredRequests, 1);
  for (const [task, query] of queries.filter(([, query]) => query?.take !== undefined)) {
    assert.equal(query.take, NATIVE_OPERATION_BATCH_LIMIT, `${task} must cap each dispatcher invocation`);
    assert.equal(query.orderBy?.expiresAt?.toLowerCase?.() ?? query.orderBy?.codeExpiresAt?.toLowerCase?.(), 'asc', `${task} must process oldest expiry first`);
  }
  const conditionalUpdate = queries.find(([task]) => task === 'request-update')?.[1];
  assert.deepEqual(conditionalUpdate?.where, { id: 'request:1', status: { in: ['REQUESTED', 'APPROVED', 'ISSUED'] }, codeExpiresAt: { lte: new Date('2026-09-29T12:00:00Z') } });
});

test('the signed one-day OS grant remains valid past recent-auth while flag-off grants keep the short cap', () => {
  const crypto = createRequire(import.meta.url)('node:crypto');
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const previousPrivateKey = process.env.OPERATOR_SESSION_PRIVATE_KEY;
  const previousFlag = process.env.STAGE1_INTERNAL_OPERATOR_DAY_SESSION;
  process.env.OPERATOR_SESSION_PRIVATE_KEY = privateKey;
  process.env.STAGE1_INTERNAL_OPERATOR_DAY_SESSION = 'true';
  try {
    const { createHubBoundOperatorGrant, verifyHubBoundOperatorGrant } = loadTypeScriptModule('src/lib/stage1Operator.ts', {
      './hubOperatorCredentials': { encryptToHubKey() { throw new Error('not used'); } },
      './internalOperatorDaySession': {
        DEFAULT_OPERATOR_SESSION_SECONDS: 900,
        INTERNAL_OPERATOR_DAY_SESSION_POLICY: 'STAGE1_INTERNAL_OPERATOR_DAY_SESSION',
        INTERNAL_OPERATOR_SESSION_SECONDS: 86400,
        internalOperatorDaySessionEnabled: () => process.env.STAGE1_INTERNAL_OPERATOR_DAY_SESSION === 'true',
        stage1NowMs: () => Date.now(),
      },
    });
    const issuedAt = Date.parse('2026-09-26T12:00:00.000Z');
    const grant = createHubBoundOperatorGrant({ employeeId: 'employee-1', hubId: 'serial-1', workflowId: 'work-1', scope: ['os:admin'], recentAuthAt: issuedAt, issuedAt, expiresAt: issuedAt + 86_400_000 });
    const verifyInput = { hubId: 'serial-1', workflowId: 'work-1', requiredScope: 'os:admin', employeeId: 'employee-1' };
    assert.ok(verifyHubBoundOperatorGrant(grant, verifyInput, issuedAt + 60 * 60 * 1000), 'enabled one-day grant must survive beyond the ordinary five-minute launch-auth window');
    process.env.STAGE1_INTERNAL_OPERATOR_DAY_SESSION = 'false';
    assert.equal(verifyHubBoundOperatorGrant(grant, verifyInput, issuedAt + 60 * 60 * 1000), null, 'flag-off verifier must reject an extended grant');
  } finally {
    if (previousPrivateKey === undefined) delete process.env.OPERATOR_SESSION_PRIVATE_KEY;
    else process.env.OPERATOR_SESSION_PRIVATE_KEY = previousPrivateKey;
    if (previousFlag === undefined) delete process.env.STAGE1_INTERNAL_OPERATOR_DAY_SESSION;
    else process.env.STAGE1_INTERNAL_OPERATOR_DAY_SESSION = previousFlag;
  }
});

test('Stage 1 checker passes against the active repositories', () => {
  const output = execFileSync(process.execPath, ['scripts/check_stage1_security.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /check:stage1\] OK/);
});

test('native provisioning cannot expose reusable browser credentials', () => {
  const route = read('src/app/api/hub-agent/operator-session/consume/route.ts');
  assert.match(route, /sessionGrant/);
  assert.doesNotMatch(route, /NextResponse\.json\([\s\S]{0,800}\btoken\s*:/);
  assert.match(read('src/app/api/installer/home-support/homes/[homeId]/os-access/launch/route.ts'), /handoffHash|handoff/);
});

test('LAN endpoint observations are exact, private-only, versioned, and expire at the configured freshness boundary', () => {
  class StubStage1AuthError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const canonical = loadTypeScriptModule('src/lib/contracts/dinodiaV1.ts');
  const { validateLanEndpointObservation, lanEndpointFresh } = loadTypeScriptModule('src/lib/lanEndpoint.ts', { './stage1Auth': { Stage1AuthError: StubStage1AuthError }, './contracts/dinodiaV1': canonical });
  const valid = { version: 1, revision: 7, state: 'CURRENT', baseUrl: 'http://192.168.0.110:8123', discoveryHost: 'dinodia-din-home-001.local' };
  assert.deepEqual(validateLanEndpointObservation(valid, 'DIN-HOME-001'), valid);
  assert.deepEqual(validateLanEndpointObservation({ version: 1, revision: 8, state: 'UNAVAILABLE', discoveryHost: 'dinodia-din-home-001.local' }, 'DIN-HOME-001'), { version: 1, revision: 8, state: 'UNAVAILABLE', discoveryHost: 'dinodia-din-home-001.local' });
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, baseUrl: 'http://8.8.8.8:8123' },
    { ...valid, baseUrl: 'http://172.17.0.1:8123' },
    { ...valid, baseUrl: 'http://192.168.0.110:8124' },
    { ...valid, baseUrl: 'http://192.168.0.110:8123/path' },
    { ...valid, baseUrl: 'https://192.168.0.110:8123' },
    { ...valid, discoveryHost: 'dinodia-other.local' },
    { ...valid, revision: 0 },
    { ...valid, version: 2 },
    { version: 1, revision: 8, state: 'UNAVAILABLE', baseUrl: valid.baseUrl, discoveryHost: valid.discoveryHost },
  ]) assert.throws(() => validateLanEndpointObservation(invalid, 'DIN-HOME-001'), StubStage1AuthError);
  const report = new Date('2026-09-27T12:00:00.000Z');
  assert.equal(lanEndpointFresh('CURRENT', report, report.getTime() + 420_000), true);
  assert.equal(lanEndpointFresh('CURRENT', report, report.getTime() + 420_001), false);
  assert.equal(lanEndpointFresh('CURRENT', new Date(report.getTime() + 1), report.getTime()), false, 'future receipts are not fresh');
  assert.equal(lanEndpointFresh('UNAVAILABLE', report, report.getTime()), false);
});

test('operator handoff proves a one-use secret inside the hub channel', () => {
  const launch = read('src/app/api/installer/home-support/homes/[homeId]/os-access/launch/route.ts');
  const consume = read('src/app/api/hub-agent/operator-session/consume/route.ts');
  assert.match(launch, /handoffSecret/);
  assert.match(launch, /handoffHash: sha256\(handoffSecret\)/);
  assert.match(launch, /handoffEnvelope/);
  assert.doesNotMatch(launch, /handoffSecret,.*NextResponse/);
  assert.match(consume, /phase === 'prepare'/);
  assert.match(consume, /sha256\(handoffSecret\) !== handoff\.handoffHash/);
  assert.match(consume, /handoff_secret_required/);
  assert.doesNotMatch(consume, /NextResponse\.json\([^\n]*handoffSecret,/);
  const osServer = readOs('src/server.js');
  assert.match(osServer, /phase: "prepare"/);
  assert.match(osServer, /phase: "consume"/);
  assert.match(osServer, /decryptCredentialDelivery\(.*operator-handoff/);
  assert.match(osServer, /handoffSecret = null/);
});

test('Stage 1 database migration includes durable privacy and authority objects', () => {
  const migration = read('prisma/migrations/20260922000000_stage1_security_authorities/migration.sql');
  for (const marker of ['SupportAccessRequest_scope_guard', 'HubCredentialVersion_hub_purpose_state_idx', 'REVOKE ALL PRIVILEGES']) assert.match(migration, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('readiness requires the exact Stage 3 schema plus reviewed additive Stage 4 and Stage 5 migrations', () => {
  assert.match(read('src/app/api/readiness/route.ts'), /isSchemaReady\(migration, Number\(modelCount\[0\]\?\.count \?\? 0\), expectedMigrationChecksum\)/);
  assert.match(read('src/lib/foundation.ts'), /20261003000000_native_v2_stage3_domain_schema/);
  assert.match(read('src/lib/foundation.ts'), /20261004050000_stage4_customer_lan_tls_identity/);
  assert.match(read('src/lib/foundation.ts'), /8b6f9a3ed68fb00805dbc54ba750fc339da3f375bb6c4a899e286c7b3844a5d1/);
  assert.match(read('src/lib/foundation.ts'), /20261004150000_stage5_hub_sync_v2/);
  assert.match(read('src/lib/foundation.ts'), /0043e8c7870c0afa7f4a5e5e4dd3d290387bc39514e4728f8c9a90fea8b33203/);
  assert.match(read('src/lib/foundation.ts'), /20261005070000_stage5_hub_incident_deadline/);
  assert.match(read('src/lib/foundation.ts'), /f6c5fed31a31184e4c2ae42a98be8a89fe1628415ae4cfc1bef61033ab95b44e/);
  assert.match(read('src/lib/foundation.ts'), /REQUIRED_MODEL_COUNT = 65/);
  assert.match(read('src/lib/foundation.ts'), /REQUIRED_MODEL_COUNT \+ \(hasStage5 \? 1 : 0\)/);
});

test('normal hub routes require the acknowledged machine credential', () => {
  const auth = read('src/lib/stage1HubAuth.ts');
  assert.match(auth, /machine_credential_required/);
  assert.match(auth, /allowIdentity\?\: boolean/);
  for (const route of [
    'src/app/api/hub-agent/v2/heartbeat/route.ts',
    'src/app/api/hub-agent/token-state/route.ts',
    'src/app/api/hub-agent/support/v2/status/route.ts',
    'src/app/api/hub-agent/operator-session/consume/route.ts',
    'src/app/api/hub-agent/v2/pairing/cloud-url/route.ts',
  ]) assert.doesNotMatch(read(route), /allowIdentity/);
  for (const route of [
    'src/app/api/hub-agent/v2/pairing/challenge/route.ts',
    'src/app/api/hub-agent/v2/pairing/prove/route.ts',
    'src/app/api/hub-agent/v2/pairing/acknowledge/route.ts',
  ]) assert.match(read(route), /allowIdentity: true/);
});

test('offline authority cannot replace the enrolled trusted-phone key', () => {
  const route = read('src/app/api/v2/offline-authorisations/route.ts');
  assert.match(route, /trustedDevicePublicKey/);
  assert.match(route, /offline_device_key_denied/);
  assert.match(route, /suppliedThumbprint/);
});

test('employee sessions use the employee lifetime while customer hub tokens remain five minutes', () => {
  const crypto = createRequire(import.meta.url)('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { signStage1Token, verifyStage1Token } = loadTypeScriptModule('src/lib/stage1Crypto.ts');
  const now = 1_900_000_000_000;
  const issuedAt = Math.floor(now / 1000);
  const employee = signStage1Token('employee', { id: 'employee-1', sessionId: 'session-1', areaIds: [], scopes: ['company:portal'], policyRevision: 0, issuedAt, expiresAt: issuedAt + 8 * 60 * 60 }, privateKey);
  assert.equal(verifyStage1Token(employee, 'employee', [publicKey], now)?.id, 'employee-1');
  const customer = signStage1Token('customer', { id: 'customer-1', sessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', trustedDeviceId: 'device-1', hubInstallationId: 'hub-1', role: 'TENANT', areaIds: ['area-1'], scopes: ['tenant:device-command'], policyRevision: 1, issuedAt, expiresAt: issuedAt + 300 }, privateKey);
  assert.equal(verifyStage1Token(customer, 'customer', [publicKey], now)?.id, 'customer-1');
  const overlongCustomer = signStage1Token('customer', { id: 'customer-1', sessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', trustedDeviceId: 'device-1', hubInstallationId: 'hub-1', role: 'TENANT', areaIds: [], scopes: [], policyRevision: 1, issuedAt, expiresAt: issuedAt + 301 }, privateKey);
  assert.equal(verifyStage1Token(overlongCustomer, 'customer', [publicKey], now), null);
});

test('step-up target digests use one canonical representation for issue and consume', () => {
  const { targetDigest } = loadTypeScriptModule('src/lib/sensitiveOperationStepUp.ts', {
    './prisma': { prisma: {} },
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error {} },
    './stepUpProofCodec': loadTypeScriptModule('src/lib/stepUpProofCodec.ts'),
  });
  assert.equal(targetDigest(['device-1', 'entity-1']), targetDigest(['entity-1', 'device-1']));
  assert.equal(targetDigest(['device-1', 'device-1']), targetDigest(['device-1']));
  assert.notEqual(targetDigest(['device-1']), targetDigest(['device-2']));
});

test('every real step-up consumer remains bound to the selected hub installation', () => {
  const primitive = read('src/lib/sensitiveOperationStepUp.ts');
  assert.match(primitive, /hubInstallationId: string/);
  for (const route of [
    'src/app/api/v2/support/tickets/[ticketId]/route.ts',
    'src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts',
    'src/app/api/v2/trusted-devices/[trustedDeviceId]/route.ts',
    'src/app/api/v2/security/step-up/consume/route.ts',
  ]) {
    const source = read(route);
    assert.match(source, /consumeStepUp\(/);
    assert.match(source, /hubInstallationId:\s*customer\.hubInstallationId/);
  }
});

test('Platform step-up operation digest matches the published cross-runtime vector', () => {
  const { operationDigest, descriptorBoundValue } = loadTypeScriptModule('src/lib/sensitiveOperationStepUp.ts', {
    './prisma': { prisma: {} },
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error {} },
    './stepUpProofCodec': loadTypeScriptModule('src/lib/stepUpProofCodec.ts'),
  });
  const digest = operationDigest({
    actorId: 'account-1', trustedDeviceId: 'phone-1', customerSessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', hubInstallationId: 'hub-1',
    operationKind: 'device_sensitive_command', targetIds: ['device-1'],
    value: descriptorBoundValue({ controlId: 'control-1', temperature: 21 }, { 'device-1': 'descriptor-7' }),
  });
  assert.equal(digest, '0b7b31bd4b18558b5650808cc96c4127bff9ef43c3a2982083fb2c0402603997');
  const osVerifier = requireOsModule('src/auth/stepUpProofVerifier.js');
  assert.equal(osVerifier.digestOperation({ actorId: 'account-1', trustedDeviceId: 'phone-1', trustedSessionId: 'session-1', homeId: 'home-1', membershipId: 'membership-1', hubInstallId: 'hub-1', operation: 'device_sensitive_command', targetIds: ['device-1'], value: osVerifier.descriptorBoundValue({ controlId: 'control-1', temperature: 21 }, { 'device-1': 'descriptor-7' }) }), digest);
});

test('support proof requires possession of the decrypted ephemeral signing key and binds its full context', () => {
  const { supportProofRequestDigest, verifySupportProofSignature } = loadTypeScriptModule('src/lib/stage1Operator.ts', {
    './hubOperatorCredentials': { encryptToHubKey: () => ({}) },
    './internalOperatorDaySession': { DEFAULT_OPERATOR_SESSION_SECONDS: 900, INTERNAL_OPERATOR_SESSION_SECONDS: 86400, INTERNAL_OPERATOR_DAY_SESSION_POLICY: 'STAGE1_INTERNAL_OPERATOR_DAY_SESSION', internalOperatorDaySessionEnabled: () => false, stage1NowMs: () => Date.now() },
  });
  const keys = createRequire(import.meta.url)('node:crypto').generateKeyPairSync('ed25519');
  const otherKeys = createRequire(import.meta.url)('node:crypto').generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const otherPublicKey = otherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const input = { serial: 'din-home-001', ticketId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', employeeId: 'employee-1', homeId: 'home-1', codeHash: 'b'.repeat(64), identityGeneration: 1, nonce: 'n'.repeat(32), proofExpiresAt: 1790000000 };
  const osProof = requireOsModule('src/auth/supportProofOfPossession.js');
  const signed = osProof.createSupportProofOfPossession({ ...input, privateKeyPem: privateKey });
  assert.equal(signed.requestBodyDigest, supportProofRequestDigest(input));
  assert.equal(verifySupportProofSignature({ ...input, requestBodyDigest: signed.requestBodyDigest, signature: signed.signature, publicKey }), true);
  assert.equal(verifySupportProofSignature({ ...input, homeId: 'different-home', requestBodyDigest: signed.requestBodyDigest, signature: signed.signature, publicKey }), false);
  assert.equal(verifySupportProofSignature({ ...input, requestBodyDigest: signed.requestBodyDigest, signature: signed.signature, publicKey: otherPublicKey }), false);
});

test('Platform and Dinodia OS use the same ten-field CloudURL challenge vector', () => {
  const nodeCrypto = createRequire(import.meta.url)('node:crypto');
  const { canonicalCloudUrlChallenge, canonicalCloudUrlUnsignedBody } = loadTypeScriptModule('src/lib/stage1HubAuth.ts', {
    './prisma': { prisma: {} },
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error {} },
    './stage1Crypto': { canonicalHubRequest: () => '', sha256: (value) => nodeCrypto.createHash('sha256').update(String(value), 'utf8').digest('hex'), verifyHubSignature: () => false },
    './manufacturingEnrollment': { manufacturingIdentityPayload: () => '' },
  });
  const osIdentity = requireOsModule('src/auth/identityBroker.js');
  const input = { version: 1, serial: 'din-home-001', cloudUrl: 'https://dinodia-din-home-001.dinodiasmartliving.com', challenge: 'challenge-012345678901234567890', tunnelId: '11111111-1111-4111-8111-111111111111', tunnelName: 'dinodia-din-home-001', timestamp: 1790000000000, identityFingerprint: 'a'.repeat(64), identityGeneration: 1 };
  const platformUnsigned = canonicalCloudUrlUnsignedBody(input);
  const bodyHash = nodeCrypto.createHash('sha256').update(platformUnsigned, 'utf8').digest('hex');
  const complete = { ...input, bodyHash };
  assert.equal(canonicalCloudUrlChallenge(complete), osIdentity.canonicalCloudChallenge(complete));
  assert.equal(canonicalCloudUrlUnsignedBody(input), osIdentity.canonicalCloudChallengeUnsigned(input));
});

test('trusted-phone assertions interoperate with Secure Enclave P-256 and preserve Ed25519 compatibility', () => {
  const crypto = createRequire(import.meta.url)('node:crypto');
  const { verifyTrustedDeviceAssertion } = loadTypeScriptModule('src/lib/sensitiveOperationStepUp.ts', {
    './prisma': { prisma: {} },
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } } },
    './stepUpProofCodec': loadTypeScriptModule('src/lib/stepUpProofCodec.ts'),
  });
  const input = { nonce: 'nonce-1', challengeId: 'challenge-1', operationDigest: 'digest-1' };
  const message = Buffer.from('DINODIA_STEP_UP_CHALLENGE_V1\nchallenge-1\nnonce-1\ndigest-1', 'utf8');
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p256Signature = crypto.sign('sha256', message, p256.privateKey).toString('base64url');
  assert.doesNotThrow(() => verifyTrustedDeviceAssertion({ ...input, publicKey: p256.publicKey.export({ type: 'spki', format: 'pem' }).toString(), signature: p256Signature }));
  const corruptedSignature = `${p256Signature[0] === 'A' ? 'B' : 'A'}${p256Signature.slice(1)}`;
  assert.throws(() => verifyTrustedDeviceAssertion({ ...input, publicKey: p256.publicKey.export({ type: 'spki', format: 'pem' }).toString(), signature: corruptedSignature }));
  const ed25519 = crypto.generateKeyPairSync('ed25519');
  const edSignature = crypto.sign(null, message, ed25519.privateKey).toString('base64url');
  assert.doesNotThrow(() => verifyTrustedDeviceAssertion({ ...input, publicKey: ed25519.publicKey.export({ type: 'spki', format: 'pem' }).toString(), signature: edSignature }));
});

test('operator handoff expiry accepts only timestamps strictly before the bound deadline', () => {
  const { isStrictlyUnexpired } = loadTypeScriptModule('src/lib/stage1Operator.ts', {
    './hubOperatorCredentials': { encryptToHubKey: () => ({}) },
    './internalOperatorDaySession': { DEFAULT_OPERATOR_SESSION_SECONDS: 900, INTERNAL_OPERATOR_SESSION_SECONDS: 86400, INTERNAL_OPERATOR_DAY_SESSION_POLICY: 'STAGE1_INTERNAL_OPERATOR_DAY_SESSION', internalOperatorDaySessionEnabled: () => false, stage1NowMs: () => Date.now() },
  });
  const now = new Date('2026-09-25T12:00:00.000Z');
  const deadline = new Date(now.getTime() + 60_000);
  assert.equal(isStrictlyUnexpired(deadline, new Date(deadline.getTime() - 1)), true);
  assert.equal(isStrictlyUnexpired(deadline, deadline), false);
  assert.equal(isStrictlyUnexpired(deadline, new Date(deadline.getTime() + 1)), false);
});

test('manufacturing certificates sign only stable identity material and use separate key types', () => {
  const crypto = createRequire(import.meta.url)('node:crypto');
  const { publicKey: rootPublicKey, privateKey: rootPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: signingPublicKey } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: encryptionPublicKey } = crypto.generateKeyPairSync('x25519');
  const pem = (key) => key.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = (key) => crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  const identity = { serial: 'DIN-ROOT-001', identityGeneration: 1, publicKeyPem: pem(signingPublicKey), encryptionPublicKeyPem: pem(encryptionPublicKey), publicKeyFingerprint: fingerprint(signingPublicKey), encryptionKeyFingerprint: fingerprint(encryptionPublicKey) };
  const { manufacturingIdentityPayload, validateManufacturingIdentity } = loadTypeScriptModule('src/lib/manufacturingEnrollment.ts', {
    './stage1Auth': { Stage1AuthError: class Stage1AuthError extends Error { constructor(_status, code, message = code) { super(message); } } },
    './stage1Crypto': { parsePublicKeys: () => [], sha256: () => '' },
  });
  const signature = crypto.sign(null, Buffer.from(manufacturingIdentityPayload(identity), 'utf8'), rootPrivateKey).toString('base64url');
  const verified = validateManufacturingIdentity({ ...identity, manufacturingRootSignature: signature }, [rootPublicKey]);
  assert.equal(verified.serial, identity.serial);
  assert.equal(verified.generation, 1);
  // Transient provisioning fields are deliberately outside the stable factory
  // certificate. They cannot change its bytes or invalidate a valid identity;
  // the separate hub-attempt signature authenticates those fields.
  assert.equal(validateManufacturingIdentity({ ...identity, manufacturingRootSignature: signature, attemptId: 'different-attempt' }, [rootPublicKey]).serial, identity.serial);
  assert.notEqual(manufacturingIdentityPayload(identity), manufacturingIdentityPayload({ ...identity, identityGeneration: 2 }));
  const osIdentity = createRequire(import.meta.url)(path.join(osRoot, 'src/auth/manufacturingIdentity.js'));
  assert.equal(osIdentity.stableManufacturingIdentityPayload(identity), manufacturingIdentityPayload(identity));
  const rootAuth = read('src/lib/stage1HubAuth.ts');
  assert.match(rootAuth, /manufacturingIdentityPayload/);
  assert.match(rootAuth, /stable manufacturing certificate/);
});

test('R4 production paths use opaque browser-bound handoffs, committed claim cleanup and reserved tunnel identity', () => {
  const launch = read('src/app/api/installer/home-support/homes/[homeId]/os-access/launch/route.ts');
  const consume = read('src/app/api/hub-agent/operator-session/consume/route.ts');
  const claim = read('src/lib/stage1ClaimContract.ts');
  const cloud = read('src/app/api/hub-agent/v2/pairing/cloud-url/route.ts');
  const support = read('src/app/api/hub-agent/support/v2/redeem/route.ts');
  const supportProof = read('src/app/api/hub-agent/support/v2/proof/route.ts');
  const supportIssue = read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/issue/route.ts');
  const cloudflareReserve = read('src/app/api/installer/hubs/[hubInstallationId]/cloudflare/reserve/route.ts');
  const supportPortal = read('src/app/installer/home-support/page.tsx');
  assert.match(launch, /browserBinding/);
  assert.match(launch, /handoffId/);
  assert.match(launch, /handoffSecret/);
  assert.match(launch, /handoffEnvelope/);
  assert.match(consume, /where: \{ id: handoffId \}/);
  assert.match(consume, /browserBindingHash/);
  assert.match(consume, /setupAttemptId/);
  assert.match(consume, /handoff\.consumedAt/);
  assert.match(claim, /const result = await prisma\.\$transaction/);
  assert.match(claim, /if \(result\.expired\) throw/);
  assert.match(claim, /pendingSetupCount/);
  assert.match(cloud, /reservedTunnelName/);
  assert.match(cloud, /cloudflareReservationToken/);
  assert.match(cloud, /reservationToken/);
  assert.doesNotMatch(support, /hub\.body\.employeeProofEnvelope/);
  assert.match(supportProof, /employeeHandoffEnvelope/);
  assert.match(supportProof, /requestId/);
  assert.match(supportProof, /identityGeneration/);
  assert.doesNotMatch(supportProof, /employeeProofHash/);
  assert.match(support, /employeeProofSignature/);
  assert.match(support, /verifySupportProofSignature/);
  assert.doesNotMatch(support, /employeeProof\s*:/);
  assert.doesNotMatch(support, /verifyHubBoundOperatorGrant/);
  assert.doesNotMatch(support, /employeeHandoffHash/);
  assert.match(supportIssue, /employeeHandoffEnvelope/);
  assert.doesNotMatch(supportIssue, /NextResponse\.json\(\{[^\n]*employeeProofEnvelope/);
  assert.doesNotMatch(supportPortal, /employeeProofEnvelope/);
  assert.doesNotMatch(supportPortal, /issuedCode|body\.code/);
  assert.doesNotMatch(supportIssue, /NextResponse\.json\([\s\S]{0,500}\bcode\s*[,}]/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts'), /oneUseCode/);
  assert.doesNotMatch(readOs('public/setup.js'), /supportProof|employeeProofEnvelope/);
  assert.doesNotMatch(support, /employeeHandoff\s*\}\)/);
  assert.match(support, /employeeHandoffConsumedAt/);
  assert.doesNotMatch(support, /requireEmployeeToken/);
  assert.match(support, /targetMembershipId/);
  assert.match(read('src/app/api/hub-agent/support/v2/status/route.ts'), /targetMembershipId/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts'), /support_access_(approved|denied)/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/issue/route.ts'), /support_access_issued/);
  assert.match(read('src/app/api/v2/support/tickets/[ticketId]/route.ts'), /support_ticket_closed/);
  assert.match(support, /support_access_redeemed/);
  assert.doesNotMatch(cloudflareReserve, /return \{[^\n]*reservationToken/);
  const resolver = read('src/app/api/hub-agent/v2/claim/resolver/challenge/route.ts');
  assert.match(resolver, /authenticateHub\(request, raw\)/);
  assert.match(resolver, /permanentResolverHash/);
  assert.match(resolver, /homeClaimChallenge\.create/);
  assert.match(resolver, /state: \{ in: \['AVAILABLE', 'RESERVED'\] \}/);
  assert.match(readOs('src/server.js'), /\/_dinodia\/setup\/claim-challenge/);
  assert.match(readOs('src/platformPairing.js'), /requestPermanentClaimChallenge/);
  const resolverHarness = read('src/app/api/internal/stage1/claim/route.ts');
  assert.match(resolverHarness, /action === 'resolve'/);
  assert.match(resolverHarness, /signedResponseDigest/);
  assert.match(resolverHarness, /resolver_challenge_replayed/);
  assert.match(resolverHarness, /constantTimeEqual/);
});

test('installer UI separates verified secure launch from fresh local endpoint launch', () => {
  const installer = read('src/app/installer/page.tsx');
  const launch = read('src/app/api/installer/home-support/homes/[homeId]/os-access/launch/route.ts');
  const attempt = read('src/app/api/hub-agent/operator-session/attempt/route.ts');
  const consume = read('src/app/api/hub-agent/operator-session/consume/route.ts');
  assert.match(installer, /cloudflare\/reserve/);
  assert.match(installer, /Reserve secure endpoint/);
  assert.match(installer, /work\.hubInstallation\?\.secureVerified && <button[\s\S]*openHub\(work, "secure"\)/);
  assert.match(installer, /work\.hubInstallation\?\.localUrl && <button[\s\S]*openHub\(work, "local"\)/);
  assert.match(installer, /currently unreachable by its signed heartbeat/);
  assert.match(installer, /did not confirm an authenticated operator session/);
  assert.match(installer, /Open secure Dinodia OS/);
  assert.match(launch, /accessMode === 'secure'/);
  assert.match(launch, /local_endpoint_stale/);
  assert.match(launch, /hub\.cloudUrlVerifiedAt/);
  assert.match(launch, /lanEndpointFresh\(hub\.lanEndpointState/);
  assert.match(launch, /endpointOrigin: operatorOrigin, endpointRevision/);
  assert.match(attempt, /endpointOrigin !== secureOrigin/);
  assert.match(attempt, /endpointOrigin !== installation\.baseUrl/);
  assert.match(attempt, /lanEndpointIdentityGeneration !== installation\.manufacturingIdentity\.identityGeneration/);
  assert.match(attempt, /lanEndpointFresh\(installation\.lanEndpointState/);
  assert.match(consume, /handoffScope\.accessMode/);
  assert.match(consume, /handoffScope\.endpointRevision/);
});

test('R3 tenant-device and device step-up paths use current membership and descriptor authority', () => {
  const osServer = readOs('src/server.js');
  const osConfig = readOs('src/config.js');
  const osExample = readOs('.env.example');
  const osStepUp = readOs('src/auth/stepUpProofVerifier.js');
  assert.match(osServer, /ownerMembershipId/);
  assert.doesNotMatch(osServer, /const ownerId = String\(device\.tenantOwnerId/);
  assert.match(osServer, /descriptorBoundValue\(\{/);
  assert.match(osServer, /targetIds: \[item\.device\.id\]/);
  assert.match(osServer, /step_up_descriptor_stale/);
  assert.match(osStepUp, /descriptorBoundValue/);
  assert.match(osConfig, /platformHeartbeatUrl: developmentCompatibility/);
  assert.match(osConfig, /platformToken: developmentCompatibility/);
  assert.doesNotMatch(osExample, /DINODIA_PLATFORM_HEARTBEAT_URL|DINODIA_PLATFORM_TOKEN/);
});

test('R3 provisioning retries are durable, request-bound and never replay the Home QR secret', () => {
  const route = read('src/app/api/installer/hubs/provision/route.ts');
  assert.match(route, /idempotencyRecord/);
  assert.match(route, /namespace_keyHash/);
  assert.match(route, /requestHash/);
  assert.match(route, /TransactionIsolationLevel\.Serializable/);
  assert.match(route, /idempotentReplay: true/);
  assert.match(route, /claimPresentation: null/);
  assert.match(route, /P2002|P2034/);
});

test('R3 authentication failures create redacted durable security evidence', () => {
  const auth = read('src/lib/stage1Auth.ts');
  assert.match(auth, /recordFailedAuthentication/);
  assert.match(auth, /identifierHash/);
  assert.match(auth, /actorType: 'SYSTEM'/);
  assert.doesNotMatch(auth, /metadata: \{[^}]*password/);
  assert.match(read('src/app/api/company/auth/session/route.ts'), /employee_login_failed/);
  assert.match(read('src/app/api/v2/auth/session/route.ts'), /customer_login_failed/);
});

test('R3 persistent rate limits serialize concurrent bucket updates', () => {
  const limiter = read('src/lib/rateLimit.ts');
  assert.match(limiter, /TransactionIsolationLevel\.Serializable/);
  assert.match(limiter, /P2002|P2034/);
  assert.match(limiter, /rate_limit_retry_exhausted/);
});

test('R11 signed CloudURL re-verification is challenge-bound and compare-and-set', () => {
  const cloud = read('src/app/api/hub-agent/v2/pairing/cloud-url/route.ts');
  const pairing = readOs('src/platformPairing.js');
  const server = readOs('src/server.js');
  const dashboard = readOs('public/app.js');
  const setup = readOs('public/setup.js');
  const installer = read('src/app/installer/page.tsx');
  const nextConfig = read('next.config.ts');
  assert.match(cloud, /hub\.body\.reverifyChallenge !== undefined && typeof hub\.body\.reverifyChallenge !== 'boolean'/);
  assert.match(cloud, /existing\?\.status === 'VERIFIED' && !reverifyChallenge/);
  assert.match(cloud, /challengeHash, status: 'PENDING', expiresAt: \{ gt: new Date\(\) \}/);
  assert.match(cloud, /cloudUrlVerification\.updateMany/);
  assert.match(cloud, /cloudflare_challenge_replaced/);
  assert.match(pairing, /metadata\.reverifyChallenge === true \? \{ reverifyChallenge: true \}/);
  assert.match(server, /reportCloudflareVerification\(result, \{ reverifyChallenge: true \}\)/);
  assert.match(dashboard, /verified && localConnected/);
  assert.match(dashboard, /action: "reverify"/);
  assert.match(setup, /sessionCheck\.ok/);
  assert.match(setup, /dinodia-operator-session-established/);
  assert.match(setup, /action: "start"/);
  assert.match(setup, /action: "status"/);
  assert.match(setup, /operator_handoff_non_json_response/);
  assert.match(server, /operatorHandoffJobs = new Map\(\)/);
  assert.match(server, /state: "pending"/);
  assert.match(server, /operatorHandoffJobKey\(setupAttemptId, browserBinding\)/);
  assert.match(server, /phase=\$\{job\.phase\} code=\$\{job\.errorCode\}/);
  assert.match(setup, /"https:\/\/dinodia-platform-v2\.vercel\.app"/);
  assert.match(installer, /event\.source !== popup \|\| event\.origin !== operatorOrigin/);
  assert.match(installer, /dinodia-operator-handoff-failed/);
  assert.match(installer, /could not complete the operator handoff during \$\{phase\}/);
  assert.match(installer, /correlationId\.slice\(0, 8\)/);
  assert.doesNotMatch(installer, /window\.setInterval\(\(\) => \{ if \(popup\?\.closed\)/);
  assert.match(installer, /The hub did not confirm an authenticated operator session/);
  assert.match(installer, /operator session was verified by the hub/);
  assert.match(installer, /window\.open\(operatorUrl, "_blank", "popup,width=860,height=760"\)/);
  assert.doesNotMatch(installer, /window\.open\(operatorUrl, "dinodia-os-operator"/);
  assert.doesNotMatch(installer, /The secure Dinodia OS window opened/);
  assert.match(nextConfig, /source: '\/installer',[\s\S]*?key: 'Cross-Origin-Opener-Policy',[\s\S]*?value: 'same-origin-allow-popups'/);
});

test('R11 CloudURL route issues a fresh signed challenge and rejects a replayed remote response', async () => {
  const crypto = createRequire(import.meta.url)('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signingPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
  const identity = { id: 'identity-test', serialNumber: 'DINODIA-CLOUD-TEST', identityGeneration: 1, signingPublicKey, encryptionPublicKey: 'test-encryption-key', signingKeyFingerprint: fingerprint, encryptionKeyFingerprint: 'test-encryption-fingerprint', status: 'ACTIVE' };
  const installation = { id: 'installation-test', homeId: 'home-test', serialNumberSnapshot: identity.serialNumber, accessPolicyRevision: 1, state: 'PAIRED', reservedHostname: 'dinodia-test.dinodiasmartliving.com', reservedTunnelName: 'dinodia-test', cloudflareTunnelId: 'tunnel-test', cloudflareReservationToken: 'reservation-test' };
  const record = { id: 'verification-test', hubInstallationId: installation.id, homeId: installation.homeId, reservedHostname: installation.reservedHostname, tunnelId: installation.cloudflareTunnelId, tunnelName: installation.reservedTunnelName, cloudUrl: `https://${installation.reservedHostname}`, challengeHash: sha256('previous-challenge'), status: 'VERIFIED', expiresAt: new Date(Date.now() + 60_000), verifiedAt: new Date(Date.now() - 60_000), failedAt: null, signedResponseDigest: 'previous-digest' };
  const hubUpdates = [];
  const prisma = {
    cloudUrlVerification: {
      findUnique: async () => structuredClone(record),
      updateMany: async ({ where, data }) => {
        if (where.id !== record.id || where.status !== record.status || where.challengeHash !== record.challengeHash) return { count: 0 };
        if (where.expiresAt?.gt && record.expiresAt <= where.expiresAt.gt) return { count: 0 };
        Object.assign(record, data);
        return { count: 1 };
      },
      create: async () => { throw new Error('unexpected create for existing installation'); },
    },
    hubInstallation: { update: async ({ data }) => { hubUpdates.push(data); return data; } },
    $transaction: async (callback) => callback(prisma),
  };
  const authErrorResponse = (error) => new Response(JSON.stringify({ error: error.message, errorCode: error.code }), { status: error.statusCode || 500, headers: { 'content-type': 'application/json' } });
  class Stage1AuthError extends Error { constructor(statusCode, code, message) { super(message); this.statusCode = statusCode; this.code = code; } }
  const hubAuth = loadTypeScriptModule('src/lib/stage1HubAuth.ts', {
    './prisma': { prisma },
    './stage1Crypto': { sha256, canonicalHubRequest: () => '', verifyHubSignature: () => false },
    './stage1Auth': { Stage1AuthError },
    './manufacturingEnrollment': { manufacturingIdentityPayload: () => '' },
  });
  let replayPreviousResponse = false;
  let previousSignedResponse;
  const observedChallenges = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const challenge = parsed.searchParams.get('challenge') || '';
    observedChallenges.push(challenge);
    if (replayPreviousResponse && previousSignedResponse) return new Response(JSON.stringify(previousSignedResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    const unsigned = { version: 1, serial: identity.serialNumber, cloudUrl: `https://${installation.reservedHostname}`, challenge, tunnelId: installation.cloudflareTunnelId, tunnelName: installation.reservedTunnelName, timestamp: Date.now(), identityFingerprint: fingerprint, identityGeneration: 1 };
    const bodyHash = sha256(hubAuth.canonicalCloudUrlUnsignedBody(unsigned));
    const signedBody = { ...unsigned, bodyHash };
    previousSignedResponse = { ok: true, ...signedBody, hubSignature: crypto.sign(null, Buffer.from(hubAuth.canonicalCloudUrlChallenge(signedBody)), privateKey).toString('base64url') };
    return new Response(JSON.stringify(previousSignedResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const route = loadTypeScriptModule('src/app/api/hub-agent/v2/pairing/cloud-url/route.ts', {
    'next/server': { NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }) } },
    '@/lib/prisma': { prisma },
    '@/lib/stage1Auth': { authErrorResponse, Stage1AuthError },
    '@/lib/stage1HubAuth': { authenticateHub: async (_request, _raw) => ({ installation, identity, body: JSON.parse(_raw) }), canonicalCloudUrlChallenge: hubAuth.canonicalCloudUrlChallenge, canonicalCloudUrlUnsignedBody: hubAuth.canonicalCloudUrlUnsignedBody },
    '@/lib/stage1Crypto': { randomSecret: (bytes = 32) => crypto.randomBytes(bytes).toString('base64url'), sha256 },
  });
  const call = (reverifyChallenge) => route.POST(new Request('https://platform.test/api/hub-agent/v2/pairing/cloud-url', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serial: identity.serialNumber, identityGeneration: 1, cloudUrl: `https://${installation.reservedHostname}`, hostname: installation.reservedHostname, tunnelId: installation.cloudflareTunnelId, tunnelName: installation.reservedTunnelName, reservationToken: installation.cloudflareReservationToken, ...(reverifyChallenge ? { reverifyChallenge: true } : {}) }),
  }));
  try {
    const first = await call(true);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).verified, true);
    assert.equal(record.status, 'VERIFIED');
    assert.equal(record.challengeHash, sha256(observedChallenges[0]));
    assert.ok(record.issuedAt instanceof Date);
    assert.ok(Date.now() - record.issuedAt.getTime() < 5_000, 'verification row records this challenge issuance');
    assert.equal(hubUpdates.filter((update) => update.remoteChallengeAt instanceof Date).length, 1, 'HubInstallation durably records challenge issuance');
    assert.equal(hubUpdates.filter((update) => update.remoteVerificationAt instanceof Date).length, 1, 'HubInstallation durably records successful verification');
    assert.notEqual(record.challengeHash, sha256('previous-challenge'));
    replayPreviousResponse = true;
    const replay = await call(true);
    assert.equal(replay.status, 502);
    assert.equal(record.status, 'FAILED');
    assert.equal(hubUpdates.filter((update) => update.remoteChallengeAt instanceof Date).length, 2, 'the failed retry is recorded as a new challenge attempt');
    assert.equal(hubUpdates.filter((update) => update.remoteVerificationAt instanceof Date).length, 1, 'replayed response must not update HubInstallation verification evidence');
    assert.notEqual(observedChallenges[0], observedChallenges[1], 're-verification must use a fresh challenge');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Stage 1 integration and clean-clone harnesses do not inherit operator secrets', () => {
  const integration = fs.readFileSync(path.join(root, 'scripts', 'stage1_integration_harness.mjs'), 'utf8');
  const cleanClone = fs.readFileSync(path.join(root, 'scripts', 'check_clean_clone.mjs'), 'utf8');
  assert.match(integration, /function safeProcessEnvironment\(source = process\.env\)/);
  assert.match(cleanClone, /function safeProcessEnvironment\(\)/);
  assert.doesNotMatch(integration, /return \{\s*\.\.\.process\.env/);
  assert.doesNotMatch(cleanClone, /env:\s*\{\s*\.\.\.process\.env/);
  assert.match(integration, /assertLoopbackTestEndpoint/);
});

test('R3 credential lifecycle uses the durable unique version and atomic revoke boundary', () => {
  const source = read('src/lib/hubOperatorCredentials.ts');
  assert.match(source, /HubCredentialVersion_hub_purpose_version_key/);
  assert.match(source, /purpose: 'operator-credential'/);
  assert.match(source, /PrismaClientKnownRequestError/);
  assert.match(source, /error\.code !== 'P2002'/);
  assert.match(source, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(source, /accessPolicyRevision: \{ increment: 1 \}/);
});
