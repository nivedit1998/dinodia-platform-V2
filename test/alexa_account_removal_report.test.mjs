import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/alexa/accountRemovalReport.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const isolated = { exports: {} };
new Function('module', 'exports', 'require', compiled)(isolated, isolated.exports, require);
const { queueAlexaRemovalReportsForAccount, ALEXA_ACCOUNT_REMOVAL_AGGREGATE, ALEXA_ACCOUNT_REMOVAL_EVENT } = isolated.exports;

const ID_A = 'dos_aaaaaaaaaaaaaaaaaaaa';
const ID_B = 'dos_bbbbbbbbbbbbbbbbbbbb';
function fakeTx(links) {
  const calls = { find: [], upsert: [] };
  return { calls, alexaNativeLink: { findMany: async (args) => { calls.find.push(args); return links; } },
    nativeDomainOutbox: { upsert: async (args) => { calls.upsert.push(args); return {}; } } };
}
const now = new Date('2026-10-31T12:00:00Z');

test('only ACTIVE links of the deleted account are looked up', async () => {
  const tx = fakeTx([]);
  assert.equal(await queueAlexaRemovalReportsForAccount(tx, 'acct-1', now), 0);
  assert.deepEqual(tx.calls.find[0].where, { customerAccountId: 'acct-1', status: 'ACTIVE', revokedAt: null, refreshTokenCiphertext: { not: null } });
  assert.equal(tx.calls.upsert.length, 0);
});

test('a link Alexa knows endpoints for is parked as one outbox row carrying the encrypted token and valid ids only', async () => {
  const tx = fakeTx([{ id: 'link-1', refreshTokenCiphertext: '{"enc":"x"}', announcedEndpointIds: [ID_A, 'not-an-endpoint', 42, ID_B] }]);
  assert.equal(await queueAlexaRemovalReportsForAccount(tx, 'acct-1', now), 1);
  const call = tx.calls.upsert[0];
  assert.equal(call.where.idempotencyKey, 'alexa-account-removal:link-1');
  assert.equal(call.create.aggregateType, ALEXA_ACCOUNT_REMOVAL_AGGREGATE);
  assert.equal(call.create.eventType, ALEXA_ACCOUNT_REMOVAL_EVENT);
  assert.equal(call.create.homeId, null);
  assert.equal(call.create.hubInstallationId, null);
  assert.deepEqual(call.create.payload, { refreshTokenCiphertext: '{"enc":"x"}', endpointIds: [ID_A, ID_B] });
  assert.equal(call.create.expiresAt.getTime() - now.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(call.update, {});
});

test('links with nothing announced, no token, or non-array endpoint data queue nothing', async () => {
  const tx = fakeTx([
    { id: 'l1', refreshTokenCiphertext: '{"enc":"x"}', announcedEndpointIds: [] },
    { id: 'l2', refreshTokenCiphertext: '{"enc":"x"}', announcedEndpointIds: null },
    { id: 'l3', refreshTokenCiphertext: null, announcedEndpointIds: [ID_A] },
    { id: 'l4', refreshTokenCiphertext: '{"enc":"x"}', announcedEndpointIds: ['bad'] },
  ]);
  assert.equal(await queueAlexaRemovalReportsForAccount(tx, 'acct-1', now), 0);
  assert.equal(tx.calls.upsert.length, 0);
});

test('every link of the account is queued under its own key', async () => {
  const tx = fakeTx([
    { id: 'l1', refreshTokenCiphertext: '{"enc":"1"}', announcedEndpointIds: [ID_A] },
    { id: 'l2', refreshTokenCiphertext: '{"enc":"2"}', announcedEndpointIds: [ID_B] },
  ]);
  assert.equal(await queueAlexaRemovalReportsForAccount(tx, 'acct-1', now), 2);
  assert.deepEqual(tx.calls.upsert.map((c) => c.where.idempotencyKey), ['alexa-account-removal:l1', 'alexa-account-removal:l2']);
});
