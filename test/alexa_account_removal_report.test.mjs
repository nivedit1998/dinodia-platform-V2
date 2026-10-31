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
const { queueAlexaRemovalReportsForAccount, retireAlexaLinksWithoutHomes, ALEXA_ACCOUNT_REMOVAL_AGGREGATE, ALEXA_ACCOUNT_REMOVAL_EVENT } = isolated.exports;

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

function retireTx({ homes, links }) {
  const log = [];
  const rec = (name) => async (args) => { log.push([name, args]); return { count: 0 }; };
  const tx = { log,
    $queryRaw: async (strings) => { log.push(['lock', String(strings[0]).includes('AlexaNativeLink') ? 'link' : 'account']); return []; },
    homeMembership: { count: async (args) => { log.push(['homes', args]); return homes; } },
    alexaNativeLink: { findMany: async (args) => { log.push(['findLinks', args]); return links; }, update: rec('linkUpdate') },
    nativeDomainOutbox: { upsert: rec('outbox') },
    alexaNativeAreaSelection: { updateMany: rec('selections') }, alexaNativeHomeScope: { updateMany: rec('scopes') },
    alexaNativeEndpointProjection: { updateMany: rec('endpoints') }, alexaOAuthTokenFamily: { updateMany: rec('families') },
    alexaOAuthAccessToken: { updateMany: rec('access') }, alexaOAuthRefreshToken: { updateMany: rec('refresh') } };
  return tx;
}

test('a tenant who still has a Home keeps their Alexa link', async () => {
  const tx = retireTx({ homes: 1, links: [{ id: 'l1' }] });
  assert.equal(await retireAlexaLinksWithoutHomes(tx, 'acct-1', now), false);
  assert.deepEqual(tx.log.find(([n]) => n === 'homes')[1].where, { customerAccountId: 'acct-1', role: 'TENANT', status: { in: ['ACTIVE', 'REMOVAL_PENDING'] } });
  assert.equal(tx.log.some(([n]) => n === 'linkUpdate' || n === 'outbox'), false);
});

test('no Home and no link does nothing', async () => {
  const tx = retireTx({ homes: 0, links: [] });
  assert.equal(await retireAlexaLinksWithoutHomes(tx, 'acct-1', now), false);
  assert.equal(tx.log.some(([n]) => n === 'linkUpdate'), false);
});

test('no Home retires the link: report parked first, then tokens wiped and everything revoked', async () => {
  const tx = retireTx({ homes: 0, links: [{ id: 'l1' }] });
  tx.alexaNativeLink.findMany = async (args) => { tx.log.push(['findLinks', args]); return args.select?.refreshTokenCiphertext ? [{ id: 'l1', refreshTokenCiphertext: '{"enc":"x"}', announcedEndpointIds: [ID_A] }] : [{ id: 'l1' }]; };
  assert.equal(await retireAlexaLinksWithoutHomes(tx, 'acct-1', now), true);
  const names = tx.log.map(([n]) => n);
  assert.ok(names.indexOf('outbox') > -1 && names.indexOf('outbox') < names.indexOf('linkUpdate'), 'parks the DeleteReport before wiping the token');
  const update = tx.log.find(([n]) => n === 'linkUpdate')[1];
  assert.equal(update.where.id, 'l1');
  assert.equal(update.data.status, 'REVOKED');
  assert.equal(update.data.accessTokenCiphertext, null);
  assert.equal(update.data.refreshTokenCiphertext, null);
  for (const n of ['selections', 'scopes', 'endpoints', 'families', 'access', 'refresh']) assert.ok(names.includes(n), `${n} revoked`);
});
