// Isolated route tests use the same transpile-and-inject pattern as stage1_security.
// No provider, database, HTTP listener or real scheduler secrets are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function loadRoute(operations) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync('src/app/api/cron/native-operations/route.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', 'require', compiled)(module, module.exports, (name) => {
    if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
    if (name === '@/lib/nativeOperations') return operations;
    throw new Error(`Unexpected route dependency ${name}`);
  });
  return module.exports.POST;
}
async function syntheticSecret(run) {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'synthetic-stage4-only';
  try { await run(); } finally {
    if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
  }
}
const request = () => new Request('http://127.0.0.1/api/cron/native-operations', { method: 'POST', headers: { authorization: 'Bearer synthetic-stage4-only' } });

test('due dispatch under occupied lease preserves endpoint 202 without running/completing workers', async () => syntheticSecret(async () => {
  const POST = loadRoute({ acquireOperationsLease: async () => null,
    runNativeOperations: () => assert.fail('occupied lease must not run workers'),
    completeOperationsLease: () => assert.fail('occupied lease must not complete another owner') });
  const result = await POST(request());
  assert.equal(result.status, 202);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await result.json(), { ok: true, skipped: 'already_running' });
}));
test('overlapping due dispatches respect endpoint lease and execute once', async () => syntheticSecret(async () => {
  let occupied = false, runs = 0, completed = 0, release;
  const pause = new Promise((resolve) => { release = resolve; });
  const lease = { owner: 'synthetic-owner', taskIds: ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'] };
  const POST = loadRoute({ acquireOperationsLease: async () => { if (occupied) return null; occupied = true; return lease; },
    runNativeOperations: async () => { runs += 1; await pause; return { tasks: lease.taskIds, failedTasks: [] }; },
    completeOperationsLease: async (_, actual) => { assert.equal(actual, lease); completed += 1; return true; } });
  const winner = POST(request());
  const otherResponses = await Promise.all(Array.from({ length: 7 }, () => POST(request())));
  assert.deepEqual(otherResponses.map((response) => response.status), Array(7).fill(202));
  release(); assert.equal((await winner).status, 200);
  assert.equal(runs, 1); assert.equal(completed, 1);
}));
test('worker exception completes lease with failures; completion exception leaves bounded recovery', async () => syntheticSecret(async () => {
  const lease = { owner: 'synthetic-owner', taskIds: ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'] };
  let completed = 0;
  const POST = loadRoute({ acquireOperationsLease: async () => lease,
    runNativeOperations: async () => { throw new Error('synthetic failure'); },
    completeOperationsLease: async (_, actual, outcome) => { completed += 1; assert.equal(actual, lease); assert.deepEqual(outcome.failedTasks, lease.taskIds); throw new Error('synthetic recording failure'); } });
  const result = await POST(request());
  assert.equal(result.status, 500); assert.equal(completed, 1);
  assert.deepEqual(await result.json(), { ok: false, error: 'Native operations failed' });
}));
