import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
class AuthError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function load(name) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(`src/lib/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', js)(id => id === './stage1Auth' ? { Stage1AuthError: AuthError } : require(id), module, module.exports);
  return module.exports;
}
const { logicalOsId, validateLogicalBindings, bindLogicalChildren } = load('logicalDeviceIdentity');
const binding = key => ({ physicalDeviceId: 'zigbee:abc', channelKey: key, channelGeneration: 1,
  mappingRevision: 1, manifestDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), sourceEntityIds: [`zigbee:abc:${key}:state`] });

test('erasure removes attributable payload records without discarding unrelated Home preferences', () => {
  const { pruneDeletedReferences } = load('areaDeletionPayloadPurge');
  const input = { selectedAreaId: 'deleted-room', theme: 'dark', tiles: [
    { deviceId: 'deleted-device', reading: 21, name: 'Private erased name' },
    { deviceId: 'surviving-device', reading: 19 }], rooms: { 'deleted-room': { name: 'Erased room' },
      'surviving-room': { name: 'Kept room' } } };
  assert.deepEqual(pruneDeletedReferences(input, new Set(['deleted-room', 'deleted-device'])), {
    theme: 'dark', tiles: [{ deviceId: 'surviving-device', reading: 19 }],
    rooms: { 'surviving-room': { name: 'Kept room' } } });
});

test('logical identity is stable and exact source overlaps/forged fields are rejected', () => {
  const first = binding('l1'), second = binding('l2');
  assert.equal(validateLogicalBindings('zigbee:abc', [first, second]), true);
  assert.equal(logicalOsId('zigbee:abc', 'l1'), logicalOsId('zigbee:abc', 'l1', 1));
  assert.notEqual(logicalOsId('zigbee:abc', 'l1'), logicalOsId('zigbee:abc', 'l1', 2));
  for (const changed of [
    { ...second, sourceEntityIds: first.sourceEntityIds }, { ...second, physicalDeviceId: 'another' },
    { ...second, channelKey: 'l1' }, { ...second, ownerMembershipId: 'forged' },
    { ...second, sourceEntityIds: ['other:state'] }, { ...second, manifestDigest: 'c'.repeat(64) },
  ]) assert.equal(validateLogicalBindings('zigbee:abc', [first, changed]), false);
});

test('parent identity, owner and lifecycle are rechecked before any child attachment', async () => {
  const input = { homeId: 'home', hubInstallationId: 'hub', physicalId: 'zigbee:abc', protocol: 'zigbee',
    protocolIdentityHash: 'c'.repeat(64), managementClass: 'TENANT_DEVICE', ownerMembershipId: 'tenant',
    children: [{ deviceId: 'child-row', osDeviceId: logicalOsId('zigbee:abc', 'l1'), binding: binding('l1') }] };
  const parent = { id: 'parent', homeId: 'home', managementClass: 'TENANT_DEVICE', ownerMembershipId: 'tenant',
    protocol: 'zigbee', protocolIdentityHash: input.protocolIdentityHash, manifestDigest: 'a'.repeat(64), lifecycle: 'ACTIVE' };
  for (const change of [{ homeId: 'other-home' }, { ownerMembershipId: 'another' }, { managementClass: 'PROPERTY_DEVICE' },
    { protocolIdentityHash: 'd'.repeat(64) }, { manifestDigest: 'e'.repeat(64) }, { lifecycle: 'RETIRED' }]) {
    let writes = 0;
    await assert.rejects(bindLogicalChildren({ $queryRaw: async () => [{ ...parent, ...change }],
      $executeRaw: async () => { writes++; return 1; } }, input), error => error.code === 'logical_parent_owner_conflict');
    assert.equal(writes, 0);
  }
  let writes = 0;
  assert.equal(await bindLogicalChildren({ $queryRaw: async () => [parent], $executeRaw: async () => { writes++; return 1; } }, input), 'parent');
  assert.equal(writes, 1);
});

test('one indexed deletion-fence lookup suppresses only the exact Hub targets', async () => {
  const { suppressedSyncEvents, deletedTargetReference } = load('deletionReferences');
  let reads = 0;
  const erased = deletedTargetReference('hub', 'device', 'erased');
  const tx = { deletionSecurityReceipt: { findMany: async ({ where }) => {
    reads++; assert.ok(where.anonymousReference.in.includes(erased)); return [{ anonymousReference: erased }];
  } } };
  const events = ['erased', 'survivor', 'erased'].map((osDeviceId, i) => ({ id: `e${i}`, type: 'device.upsert', payload: { osDeviceId, areaId: 'room' } }));
  assert.deepEqual([...await suppressedSyncEvents(tx, 'hub', events)], ['e0', 'e2']);
  assert.equal(reads, 1);
  assert.notEqual(erased, deletedTargetReference('another-hub', 'device', 'erased'));
  assert.ok(erased.length <= 80);
  await assert.rejects(suppressedSyncEvents({ deletionSecurityReceipt: { findMany: async () => { throw new Error('database unavailable'); } } }, 'hub', events), /database unavailable/);
});

function loadAreaDeletion() {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync('src/lib/areaDeletion.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const stubs = { './stage1Auth': { Stage1AuthError: AuthError }, '@prisma/client': { Prisma: { JsonNull: null, join: values => values } },
    './nativeAutomations/lifecycle': { retireNativeAutomations: async () => {} },
    './nativeAutomations/delivery': { refreshNativeAutomationCloudRevision: async () => {} },
    './deletionReferences': load('deletionReferences') };
  stubs['./areaDeletionPayloadPurge'] = { purgeAreaPayloads: async () => {} };
  stubs['./dailyAnalyticsErasure'] = load('dailyAnalyticsErasure');
  new Function('require', 'module', 'exports', js)(id => stubs[id] ?? require(id), module, module.exports);
  return module.exports;
}
function fakeTx(state) {
  const calls = [];
  const outbox = new Map();
  const generic = model => new Proxy({}, { get: (_, op) => async args => { calls.push(`${model}.${op}`); state.mutations?.(model, op, args);
    return op === 'count' ? 0 : op.startsWith('find') ? [] : { count: 0 }; } });
  const tx = new Proxy({
    $queryRaw: async () => [],
    area: { findFirst: async () => state.area, findUniqueOrThrow: async () => ({ originalName: 'Room 1' }),
      update: async () => { calls.push('area.update'); }, deleteMany: async () => { calls.push('area.deleteMany'); } },
    home: { findFirst: async () => ({ managementRevision: 4 }), update: async () => { calls.push('home.update'); } },
    nativeDevice: { findMany: async ({ where }) => where.lifecycle === 'RETIRED' ? (state.legacyDevices || []) : state.devices, updateMany: async () => { calls.push('nativeDevice.updateMany'); },
      deleteMany: async () => { calls.push('nativeDevice.deleteMany'); } },
    tenantAreaGrant: { findMany: async () => [{ membershipId: 'm1' }], updateMany: async a => { calls.push('tenantAreaGrant.updateMany'); state.revoked = a; } },
    nativeDomainOutbox: {
      findUnique: async ({ where }) => outbox.get(where.idempotencyKey) ?? null,
      create: async ({ data }) => outbox.set(data.idempotencyKey, { id: data.idempotencyKey, ...data }),
      update: async ({ where, data }) => Object.assign(outbox.get(where.id), data) },
  }, { get: (target, key) => target[key] ?? generic(key) });
  return { tx, calls };
}

test('LD09 Area deletion contract: preview, exact reserve, commit revokes, finish purges once', async () => {
  const { previewAreaDeletion, reserveAreaDeletion, commitAreaDeletion, finishAreaDeletion } = loadAreaDeletion();
  const state = { area: { id: 'a1', osAreaId: 'r1', revision: 2 }, devices: [{ id: 'd1', osDeviceId: 'logical:v1:x', assignments: [{ areaId: 'a1' }] }] };
  const { tx, calls } = fakeTx(state);
  const scope = { homeId: 'h', hubInstallationId: 'hub', employeeId: 'e' };
  const operationId = '00000000-0000-4000-8000-000000000001';
  const preview = await previewAreaDeletion(tx, scope, { operationId, areaId: 'a1' });
  assert.equal(preview.deviceCount, 1);
  assert.deepEqual(preview.osDeviceIds, ['logical:v1:x']);
  await assert.rejects(commitAreaDeletion(tx, scope, { operationId, digest: preview.digest, localFenceDigest: 'f'.repeat(64), confirmationName: 'Room 1' }), /Reserve/);
  await assert.rejects(reserveAreaDeletion(tx, scope, { operationId, digest: preview.digest, confirmationName: 'room 1' }), /changed/);
  await assert.rejects(reserveAreaDeletion(tx, { ...scope, employeeId: 'other' }, { operationId, digest: preview.digest, confirmationName: 'Room 1' }), /does not match/);
  assert.equal((await reserveAreaDeletion(tx, scope, { operationId, digest: preview.digest, confirmationName: 'Room 1' })).state, 'RESERVED');
  assert.ok(!calls.includes('tenantAreaGrant.updateMany'), 'reservation changes no grant or data');
  await assert.rejects(finishAreaDeletion(tx, scope, { operationId, localFenceDigest: 'f'.repeat(64) }), /does not match/);
  assert.equal((await commitAreaDeletion(tx, scope, { operationId, digest: preview.digest, localFenceDigest: 'f'.repeat(64), confirmationName: 'Room 1' })).state, 'WAITING_HUB');
  assert.equal(state.revoked.data.revokeReason, 'area_deleted');
  assert.ok(calls.includes('deletionSecurityReceipt.upsert') && calls.includes('alexaNativeAreaSelection.updateMany'));
  await assert.rejects(finishAreaDeletion(tx, scope, { operationId, localFenceDigest: 'a'.repeat(64) }), /does not match/);
  assert.equal((await finishAreaDeletion(tx, scope, { operationId, localFenceDigest: 'f'.repeat(64) })).state, 'COMPLETE');
  for (const purge of ['nativeDeviceUsageBucket.deleteMany', 'nativeTemperatureSample.deleteMany', 'nativeAnalyticsInterval.deleteMany',
    'alexaNativeEndpointProjection.deleteMany', 'nativeDevice.deleteMany', 'area.deleteMany', 'auditEvent.create'])
    assert.ok(calls.includes(purge), purge);
  assert.ok(calls.indexOf('nativeDeviceUsageBucket.deleteMany') < calls.indexOf('nativeDevice.deleteMany'), 'Restrict-FK rows purge before devices');
  const before = calls.length;
  assert.equal((await finishAreaDeletion(tx, scope, { operationId, localFenceDigest: 'f'.repeat(64) })).state, 'COMPLETE');
  assert.equal(calls.length, before, 'exact retry is idempotent');
});

test('LD09 shared legacy assignment blocks deletion preview', async () => {
  const { previewAreaDeletion } = loadAreaDeletion();
  const { tx } = fakeTx({ area: { id: 'a1', osAreaId: 'r1', revision: 1 }, devices: [{ id: 'd1', osDeviceId: 'x', assignments: [{ areaId: 'a1' }, { areaId: 'a2' }] }] });
  await assert.rejects(previewAreaDeletion(tx, { homeId: 'h', hubInstallationId: 'hub', employeeId: 'e' },
    { operationId: '00000000-0000-4000-8000-000000000002', areaId: 'a1' }), /shared/);
});
