import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
class AuthError extends Error { constructor(status, code) { super(code); this.code = code; } }
const module = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('src/lib/hubSyncIngestion.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(id => id === './stage1Auth' ? { Stage1AuthError: AuthError }
  : id === './dailyAnalyticsIngestion' ? { sealedLegacyEvent: async () => false }
  : id.startsWith('.') ? {} : require(id), module, module.exports);
const apply = module.exports.applyHubSyncEvent;
async function rename(overrides = {}, payload = {}) {
  const writes = [];
  const device = { id: 'device', homeId: 'home', managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED',
    originalName: 'Room 1 Radiator', overrideName: 'Room 1 Radiator', inventoryRevision: 7,
    descriptorRevision: 3, descriptorDigest: 'digest', capabilitySummary: {}, assignments: [{ areaId: 'room' }], ...overrides };
  const tx = { nativeDevice: { findUnique: async () => device, update: async args => { writes.push(args.data); return device; } },
    area: { findUnique: async () => ({ id: 'room', status: 'ACTIVE' }) } };
  const promise = apply(tx, { homeId: 'home', hubInstallationId: 'hub', now: new Date('2026-11-02T02:00:00Z'),
    suppressedEventIds: new Set(), identityGeneration: 1, event: { id: 'event', type: 'device.upsert',
      occurredAt: '2026-11-02T01:50:15Z', payload: { osDeviceId: 'radiator', name: 'Living Room Radiator',
        areaId: 'room', descriptorRevision: 3, descriptorDigest: 'digest', observedAt: null, available: true,
        protocol: 'zigbee', technicalLabel: 'Radiator', deviceType: 'climate', ...payload } } });
  return { promise, writes };
}
test('real inventory ingestion clears an override mirroring the old source name on rename', async () => {
  const { promise, writes } = await rename(); await promise;
  assert.equal(writes[0].originalName, 'Living Room Radiator');
  assert.equal(writes[0].overrideName, null);
  assert.deepEqual(writes[0].inventoryRevision, { increment: 1 });
});
test('a deliberate customer alias is preserved across an OS rename', async () => {
  const { promise, writes } = await rename({ overrideName: 'My favourite radiator' }); await promise;
  assert.equal(writes[0].originalName, 'Living Room Radiator');
  assert.equal(Object.hasOwn(writes[0], 'overrideName'), false);
});
test('unchanged source inventory does not erase an alias or bump its presentation revision', async () => {
  const { promise, writes } = await rename({}, { name: 'Room 1 Radiator' }); await promise;
  assert.equal(Object.hasOwn(writes[0], 'overrideName'), false);
  assert.equal(Object.hasOwn(writes[0], 'inventoryRevision'), false);
});
test('source rename with no override does not manufacture an override', async () => {
  const { promise, writes } = await rename({ overrideName: null }); await promise;
  assert.equal(writes[0].originalName, 'Living Room Radiator');
  assert.equal(Object.hasOwn(writes[0], 'overrideName'), false);
});
test('foreign Home and stale descriptor remain rejected before name writes', async () => {
  for (const [device, payload, code] of [[{ homeId: 'other' }, {}, 'hub_sync_device_uncommissioned'],
    [{}, { descriptorRevision: 2 }, 'hub_sync_descriptor_stale']]) {
    const { promise, writes } = await rename(device, payload);
    await assert.rejects(promise, { code }); assert.equal(writes.length, 0);
  }
});
