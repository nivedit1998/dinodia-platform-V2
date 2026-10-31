import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(file, stubs = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const isolated = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(isolated, isolated.exports, (name) => (name in stubs ? stubs[name] : require(name)));
  return isolated.exports;
}
const sealedCalls = [];
const notices = load('src/lib/roomAccessNotices.ts', {
  './hubOperatorCredentials': { encryptPlatformEnvelope: (value) => { sealedCalls.push(value); return { sealed: true }; }, decryptPlatformEnvelope: () => 'ab'.repeat(32) },
  './platformDataEncryptionKey': { PlatformDataEncryptionKeyError: class extends Error {} },
});
const { queueRoomAccessRequestNotices, queueRoomAccessApprovedNotice, queueRoomAccessDeclinedNotice, queueAlexaLinkedNotice, queueNewDevicesTenantNotices } = notices;
const now = new Date('2026-10-31T12:00:00Z');

function fakeTx({ deciders = [], accounts = {}, devices = {}, prefs = {}, installed = [] }) {
  const created = [];
  return { created,
    homeMembership: { findMany: async (args) => { created.push(['deciders', args.where]); return deciders; } },
    customerAccount: { findUnique: async ({ where }) => accounts[where.id] ?? null },
    trustedDevice: { findMany: async ({ where }) => devices[where.customerAccountId] ?? [] },
    nativeDomainOutbox: { createMany: async (args) => { created.push(['createMany', args]); } },
    home: { findUnique: async () => ({ addressLine1: '12 High Street', city: 'London' }) },
    areaAccessRequest: { findUnique: async () => ({ createdAt: now, requesterAccountId: 'tenant', requesterEmailNormalized: 'priya@example.com',
      area: { originalName: 'Living Room', overrideName: null }, requester: { displayName: 'Priya Shah', email: 'priya@example.com' } }) },
    memberPreferenceDocument: { findUnique: async ({ where }) => prefs[where.membershipId_kind.membershipId] ?? null },
    nativeDevice: { findMany: async () => installed } };
}
const goodAccount = (email) => ({ email, emailVerifiedAt: now, status: 'ACTIVE' });

test('a new request notifies every active owner and property manager by email and by push, sealed, with stable keys', async () => {
  const tx = fakeTx({ deciders: [{ customerAccountId: 'owner' }, { customerAccountId: 'manager' }],
    accounts: { owner: goodAccount('owner@example.com'), manager: goodAccount('manager@example.com') },
    devices: { owner: [{ id: 'dev-1', apnsTokenCiphertext: '{"x":1}', apnsEnvironment: 'PRODUCTION' }], manager: [] } });
  const result = await queueRoomAccessRequestNotices(tx, { homeId: 'home', requestId: 'req', now });
  assert.equal(result.queued, 3);
  const where = tx.created.find(([n]) => n === 'deciders')[1];
  assert.deepEqual(where.role, { in: ['OWNER', 'PROPERTY_MANAGER'] });
  assert.equal(where.status, 'ACTIVE');
  const rows = tx.created.find(([n]) => n === 'createMany')[1].data;
  assert.deepEqual(rows.map((row) => row.idempotencyKey).sort(), ['room-access-request:req:manager:email', 'room-access-request:req:owner:email', 'room-access-request:req:owner:push:dev-1']);
  assert.ok(rows.every((row) => row.eventType === 'ROOM_ACCESS_REQUEST_NOTICE' && row.aggregateType === 'HomeownerAccessRemovalNotice' && row.payload.sealed));
  assert.ok(rows.every((row) => !JSON.stringify(row).includes('example.com')), 'no plaintext address in the outbox row');
  assert.equal(rows[0].expiresAt.getTime() - now.getTime(), 2 * 24 * 60 * 60 * 1000);
});

test('an approval notifies only the requester, and unverified or inactive accounts get nothing', async () => {
  const tx = fakeTx({ accounts: { tenant: goodAccount('tenant@example.com') }, devices: { tenant: [{ id: 'd1', apnsTokenCiphertext: '{}', apnsEnvironment: 'DEVELOPMENT' }] } });
  assert.equal((await queueRoomAccessApprovedNotice(tx, { homeId: 'home', requestId: 'req', requesterAccountId: 'tenant', now })).queued, 2);
  const rows = tx.created.find(([n]) => n === 'createMany')[1].data;
  assert.ok(rows.every((row) => row.eventType === 'ROOM_ACCESS_APPROVED_NOTICE'));
  const none = fakeTx({ accounts: { u: { email: 'u@example.com', emailVerifiedAt: null, status: 'ACTIVE' }, s: { email: 's@example.com', emailVerifiedAt: now, status: 'SUSPENDED' } } });
  assert.equal((await queueRoomAccessApprovedNotice(none, { homeId: 'home', requestId: 'req', requesterAccountId: 'u', now })).queued, 0);
  assert.equal((await queueRoomAccessApprovedNotice(none, { homeId: 'home', requestId: 'req', requesterAccountId: 's', now })).queued, 0);
});

test('the sealed envelope carries the details, and the outbox row itself shows none of them', async () => {
  const tx = fakeTx({ deciders: [{ customerAccountId: 'owner' }], accounts: { owner: goodAccount('owner@example.com') } });
  sealedCalls.length = 0;
  await queueRoomAccessRequestNotices(tx, { homeId: 'home', requestId: 'req', now });
  const sealed = JSON.parse(sealedCalls[0]);
  assert.deepEqual(sealed.details, { homeLabel: '12 High Street, London', roomName: 'Living Room', requesterName: 'Priya Shah', requesterEmail: 'priya@example.com', at: now.toISOString() });
  const row = tx.created.find(([n]) => n === 'createMany')[1].data[0];
  assert.ok(!JSON.stringify(row).includes('Priya') && !JSON.stringify(row).includes('Living Room'));
});

test('a declined request tells the requester; Alexa linking tells the account holder', async () => {
  const tx = fakeTx({ accounts: { tenant: goodAccount('tenant@example.com') }, devices: { tenant: [{ id: 'd1', apnsTokenCiphertext: '{}', apnsEnvironment: 'DEVELOPMENT' }] } });
  assert.equal((await queueRoomAccessDeclinedNotice(tx, { homeId: 'home', requestId: 'req', requesterAccountId: 'tenant', now })).queued, 2);
  assert.ok(tx.created.find(([n]) => n === 'createMany')[1].data.every((row) => row.eventType === 'ROOM_ACCESS_DECLINED_NOTICE'));
  const alexa = fakeTx({ accounts: { tenant: goodAccount('tenant@example.com') } });
  assert.equal((await queueAlexaLinkedNotice(alexa, { accountId: 'tenant', linkId: 'link-1', now })).queued, 1);
  const row = alexa.created.find(([n]) => n === 'createMany')[1].data[0];
  assert.equal(row.idempotencyKey, 'alexa-linked:link-1:email');
  assert.equal(row.homeId, null);
});

test('new devices: a tenant hears only about Dinodia devices in a room they can use, and only if the optional notice is on', async () => {
  const installed = [
    { customerLabel: 'Ceiling light', originalName: 'x', overrideName: null, assignments: [{ areaId: 'kitchen', area: { originalName: 'Kitchen', overrideName: null } }] },
    { customerLabel: null, originalName: 'Heater', overrideName: 'Bathroom heater', assignments: [{ areaId: 'bath', area: { originalName: 'Bathroom', overrideName: null } }] },
  ];
  const tenants = [
    { id: 'm-kitchen', customerAccountId: 'a-kitchen', tenantAreaGrants: [{ areaId: 'kitchen' }] },
    { id: 'm-none', customerAccountId: 'a-none', tenantAreaGrants: [{ areaId: 'garden' }] },
    { id: 'm-off', customerAccountId: 'a-off', tenantAreaGrants: [{ areaId: 'kitchen' }] },
  ];
  const tx = fakeTx({ accounts: { 'a-kitchen': goodAccount('k@example.com'), 'a-none': goodAccount('n@example.com'), 'a-off': goodAccount('o@example.com') },
    prefs: { 'm-off': { document: { version: 1, enabledFamilies: ['access_request_decisions'] } } }, installed });
  tx.homeMembership.findMany = async () => tenants;
  sealedCalls.length = 0;
  const result = await queueNewDevicesTenantNotices(tx, { homeId: 'home', requestId: 'req', reference: 'DIN-1', now });
  assert.equal(result.queued, 1);
  const sealed = JSON.parse(sealedCalls[0]);
  assert.deepEqual(sealed.details.devices, [{ name: 'Ceiling light', room: 'Kitchen' }]);
  assert.equal(sealed.details.audience, 'TENANT');
  const rows = tx.created.find(([n]) => n === 'createMany')[1].data;
  assert.deepEqual(rows.map((row) => row.idempotencyKey), ['new-devices:req:a-kitchen:email']);
});
