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
const { queueRoomAccessRequestNotices, queueRoomAccessApprovedNotice, roomAccessEmail, ROOM_ACCESS_NOTICE_CONTENT, ROOM_ACCESS_NOTICE_TYPES } = notices;
const now = new Date('2026-10-31T12:00:00Z');

function fakeTx({ deciders = [], accounts = {}, devices = {} }) {
  const created = [];
  return { created,
    homeMembership: { findMany: async (args) => { created.push(['deciders', args.where]); return deciders; } },
    customerAccount: { findUnique: async ({ where }) => accounts[where.id] ?? null },
    trustedDevice: { findMany: async ({ where }) => devices[where.customerAccountId] ?? [] },
    nativeDomainOutbox: { createMany: async (args) => { created.push(['createMany', args]); } } };
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

test('banner and email wording is short, friendly, names nobody, and the email links into the app', () => {
  for (const type of ROOM_ACCESS_NOTICE_TYPES) {
    const content = ROOM_ACCESS_NOTICE_CONTENT[type];
    assert.ok(content.pushTitle.length <= 30 && content.pushBody.length <= 90, `${type} banner fits a lock screen`);
    const email = roomAccessEmail(type);
    assert.ok(email.text.includes('https://dinodia-platform-v2.vercel.app/app') && email.html.includes('href="https://dinodia-platform-v2.vercel.app/app"'));
    assert.ok(email.html.startsWith('<!doctype html>') && email.html.includes(content.button));
    assert.ok(!/postcode|@|password|code/i.test(email.text.replace('https://dinodia-platform-v2.vercel.app/app', '')), `${type} email carries no personal data or credentials`);
  }
});
