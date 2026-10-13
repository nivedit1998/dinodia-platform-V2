import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const routePath = new URL('../src/app/api/hub-agent/v2/sync/route.ts', import.meta.url);
const harnessPath = new URL('../scripts/stage1_integration_harness.mjs', import.meta.url);

test('native sync route deadline contains its bounded Prisma wait and transaction', () => {
  const route = fs.readFileSync(routePath, 'utf8');
  const maxDuration = Number(route.match(/export const maxDuration\s*=\s*(\d+)/)?.[1] || 0);
  const maxWait = Number(route.match(/maxWait:\s*(\d+)_000/)?.[1] || 0);
  const transactionTimeout = Number(route.match(/timeout:\s*(\d+)_000/)?.[1] || 0);

  assert.equal(maxDuration, 60, 'Vercel must allow the sync handler to finish beyond its default request window');
  assert.ok(maxWait > 0 && transactionTimeout > 0, 'the database wait and transaction need explicit bounds');
  assert.ok(maxWait + transactionTimeout < maxDuration * 1000,
    'database acquisition plus transaction must leave time for authentication and response serialization');

  const harness = fs.readFileSync(harnessPath, 'utf8');
  assert.match(harness, /delayed sync regression[\s\S]{0,1500}sleep\(16000\)/,
    'the actual signed-route regression must cross the current 15-second hub request deadline');
});
