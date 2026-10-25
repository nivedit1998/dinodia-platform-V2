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
