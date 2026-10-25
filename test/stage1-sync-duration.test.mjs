import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  assert.ok(/delayedSignedSync\s*=\s*hub\.pairing\.requestWithHubIdentity\(['"]\/api\/hub-agent\/v2\/sync['"]/.test(harness),
    'the delayed route test must exercise Native OS signing, timeout and response parsing rather than a direct test-only fetch');
  assert.match(harness, /delayed sync regression[\s\S]{0,1500}sleep\(16000\)/,
    'the actual signed-route regression must cross the current 15-second hub request deadline');
  assert.ok(/telemetryAccepted\s*=\s*await\s+hub\.pairing\.requestWithHubIdentity\(['"]\/api\/hub-agent\/v2\/sync['"]/.test(harness),
    'the mixed device/catalogue/usage/temperature batch must travel through the actual Native OS request owner');
});

test('oversized signed sync batches are explicitly rejected before opening the Prisma transaction', () => {
  const route = fs.readFileSync(routePath, 'utf8');
  const authentication = route.indexOf('authenticateHub(request, raw');
  const rejection = route.indexOf('hub_sync_batch_too_large');
  const transaction = route.indexOf('prisma.$transaction');
  const validation = route.indexOf('validateHubSyncEnvelope(envelope, raw)');

  assert.ok(authentication >= 0 && validation > authentication && rejection > validation,
    'batch-size negotiation must follow authentication and full envelope validation');
  assert.ok(transaction > rejection,
    'the server must reject the legacy oversized range before starting any database transaction');
  const envelope = fs.readFileSync(new URL('../src/lib/hubSyncEnvelope.ts', import.meta.url), 'utf8');
  const processingLimit = Number(envelope.match(/HUB_SYNC_PROCESSING_MAX_EVENTS\s*=\s*(\d+)/)?.[1] || 0);
  assert.equal(processingLimit, 40);
  const osRoot = process.env.DINODIA_OS_ROOT || fileURLToPath(new URL('../../Dinodia%20OS', import.meta.url));
  const osOutbox = fs.readFileSync(path.join(osRoot, 'src/sync/syncOutbox.js'), 'utf8');
  const osLimit = Number(osOutbox.match(/SYNC_BATCH_MAX_EVENTS\s*=\s*(\d+)/)?.[1] || 0);
  assert.equal(osLimit, processingLimit, 'the Producer and authenticated receiver must enforce the same event cap');
});
