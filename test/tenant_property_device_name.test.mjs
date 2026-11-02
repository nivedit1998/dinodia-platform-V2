import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), m = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('src/lib/tenantDeviceDashboard.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(id => id.startsWith('.') ? {} : require(id), m, m.exports);
const input = { accountId: 'account', sessionId: 'session', trustedDeviceId: 'phone', tokenHash: 'synthetic',
  credentialKind: 'account_access', homeId: 'home', membershipId: 'tenant', hubInstallationId: 'hub' };
function fixture(patch = {}, sessionActive = true) {
  const room = { id: 'room', originalName: 'Living Room', overrideName: null, revision: 1 };
  const device = { id: 'device', osDeviceId: 'radiator', originalName: 'Living Room Radiator', overrideName: null,
    customerLabel: 'Radiator', inventoryRevision: 3, descriptorRevision: 1, managementClass: 'PROPERTY_DEVICE',
    ownerMembershipId: null, lifecycle: 'INSTALLED', assignments: [{ area: room }], ...patch };
  const db = {
    homeMembership: { findFirst: async ({ where }) => {
      assert.equal(where.role, 'TENANT'); assert.equal(where.customerAccountId, input.accountId);
      return { id: 'tenant', homeId: 'home', accessRevision: 1, customerAccount: { id: 'account' },
        home: { id: 'home', managementRevision: 1 }, tenantAreaGrants: [{ areaId: 'room', area: room }] };
    } },
    customerSession: { findFirst: async ({ where }) => { assert.equal(where.accessTokenHash, 'synthetic'); return sessionActive ? { id: 'session' } : null; } },
    area: { findMany: async () => [room] }, tenantAreaGrant: { findMany: async () => [] },
    nativeDevice: { findMany: async ({ where }) => {
      if (where.lifecycle === 'REMOVAL_PENDING') return [];
      assert.equal(where.homeId, 'home'); assert.equal(where.hubInstallationId, 'hub');
      assert.deepEqual(where.OR[0].assignments.some.areaId.in, ['room']);
      return [device];
    } },
    memberPreferenceDocument: { findUnique: async () => null },
    nativeTenantDeviceRecovery: { findMany: async () => [] }, hubInstallation: { findFirst: async () => null },
  };
  return db;
}
test('actual tenant projection supplies the source name for a property device without an override', async () => {
  const view = await m.exports.readTenantDeviceDashboard(fixture(), input);
  const row = view.deviceOverrides[0];
  assert.equal(row.overrideName, 'Living Room Radiator');
  assert.equal(row.customerLabel, null); assert.equal(row.canRename, false);
  // The installed client reads this field first, then falls back to a generic descriptor label.
  assert.equal(row.overrideName ?? row.customerLabel ?? 'Device', 'Living Room Radiator');
});
test('property custom names are preserved', async () => {
  const view = await m.exports.readTenantDeviceDashboard(fixture({ overrideName: 'Sofa radiator' }), input);
  assert.equal(view.deviceOverrides[0].overrideName, 'Sofa radiator');
});
test('private-device reset semantics and ownership remain unchanged', async () => {
  const view = await m.exports.readTenantDeviceDashboard(fixture({ managementClass: 'TENANT_DEVICE', ownerMembershipId: 'tenant' }), input);
  assert.equal(view.deviceOverrides[0].overrideName, null); assert.equal(view.deviceOverrides[0].canRename, true);
  const foreign = await m.exports.readTenantDeviceDashboard(fixture({ managementClass: 'TENANT_DEVICE', ownerMembershipId: 'another-tenant' }), input);
  assert.equal(foreign.deviceOverrides.length, 0);
});
test('revoked session is still denied before disclosure', async () => {
  await assert.rejects(m.exports.readTenantDeviceDashboard(fixture({}, false), input), { code: 'SESSION_REVOKED' });
});
