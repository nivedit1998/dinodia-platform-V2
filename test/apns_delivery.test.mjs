import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../src/lib/apnsDelivery.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, loaded, loaded.exports);
const { createApnsProviderToken, readApnsConfig, sendInstallationCompletePush } = loaded.exports;

function testKey() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

test('APNs provider token is a cached ES256 JWT with the approved V2 app identity', () => {
  const pair = testKey();
  const config = { teamId: 'ABCDEFGHIJ', keyId: 'KLMNOPQRST', privateKey: pair.privateKey };
  const first = createApnsProviderToken(config, 1_800_000_000);
  const second = createApnsProviderToken(config, 1_800_000_010);
  assert.equal(first, second, 'APNs provider token should be reused instead of signing every notification');
  const [headerPart, payloadPart, signaturePart] = first.split('.');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'ES256', kid: 'KLMNOPQRST' });
  assert.deepEqual(payload, { iss: 'ABCDEFGHIJ', iat: 1_800_000_000 });
  assert.equal(crypto.verify('sha256', Buffer.from(`${headerPart}.${payloadPart}`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signaturePart, 'base64url')), true);
});

test('APNs configuration fails closed unless a valid P-256 key and team/key IDs exist', () => {
  assert.equal(readApnsConfig({ APNS_TEAM_ID: 'ABCDEFGHIJ', APNS_KEY_ID: 'KLMNOPQRST', APNS_AUTH_KEY_P8: 'not-a-private-key' }), null);
  assert.equal(readApnsConfig({ APNS_TEAM_ID: 'short', APNS_KEY_ID: 'KLMNOPQRST', APNS_AUTH_KEY_P8: 'not-a-private-key' }), null);
  const pair = testKey();
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.equal(readApnsConfig({ APNS_TEAM_ID: 'ABCDEFGHIJ', APNS_KEY_ID: 'KLMNOPQRST', APNS_AUTH_KEY_P8: pem })?.teamId, 'ABCDEFGHIJ');
});

test('completion push uses only the generic V2 alert, environment-specific host and bounded idempotency headers', async () => {
  const pair = testKey();
  const requestId = '1b5701f4-e4ef-4a11-a62a-8a912ad10f19';
  const token = 'ab'.repeat(32);
  const expiresAt = new Date('2026-10-08T00:00:00.000Z');
  let captured;
  const result = await sendInstallationCompletePush({
    config: { teamId: 'ABCDEFGHIJ', keyId: 'KLMNOPQRST', privateKey: pair.privateKey },
    environment: 'DEVELOPMENT', deviceToken: token, requestId, expiresAt,
  }, async (request) => { captured = request; return { status: 200 }; });
  assert.deepEqual(result, { outcome: 'ACCEPTED' });
  assert.equal(captured.host, 'api.sandbox.push.apple.com');
  assert.equal(captured.path, `/3/device/${token}`);
  assert.equal(captured.headers['apns-topic'], 'com.dinodia.DinodiaV2');
  assert.equal(captured.headers['apns-push-type'], 'alert');
  assert.equal(captured.headers['apns-collapse-id'], requestId);
  assert.equal(captured.headers['apns-expiration'], String(Math.floor(expiresAt.getTime() / 1000)));
  assert.deepEqual(JSON.parse(captured.body), { aps: { alert: { title: 'Installation update', body: 'A permanent-device installation request is complete.' }, sound: 'default' } });
  assert.equal(captured.body.includes(token), false);
  assert.equal(captured.body.includes(requestId), false);
  assert.match(captured.headers.authorization, /^bearer [A-Za-z0-9_.-]+$/);
});

test('APNs unregistered, transient and rejected responses remain distinct', async () => {
  const pair = testKey();
  const input = { config: { teamId: 'ABCDEFGHIJ', keyId: 'KLMNOPQRST', privateKey: pair.privateKey }, environment: 'PRODUCTION', deviceToken: 'cd'.repeat(32), requestId: '1b5701f4-e4ef-4a11-a62a-8a912ad10f19', expiresAt: new Date('2026-10-08T00:00:00.000Z') };
  assert.deepEqual(await sendInstallationCompletePush(input, async () => ({ status: 410 })), { outcome: 'INVALID_TOKEN' });
  assert.deepEqual(await sendInstallationCompletePush(input, async () => ({ status: 503 })), { outcome: 'RETRY' });
  assert.deepEqual(await sendInstallationCompletePush(input, async () => ({ status: 403 })), { outcome: 'FAILED' });
  assert.deepEqual(await sendInstallationCompletePush({ ...input, deviceToken: 'not-a-device-token' }, async () => ({ status: 200 })), { outcome: 'FAILED' });
});
