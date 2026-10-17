import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const require = createRequire(import.meta.url);

function loadTypeScript(relativePath, overrides = {}) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => overrides[specifier] ?? require(specifier);
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

const keyModule = loadTypeScript('src/lib/platformDataEncryptionKey.ts');

test('Platform encryption key accepts only canonical standard-base64 encoding of exactly 32 bytes', () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(keyModule.getPlatformDataEncryptionKey(key.toString('base64')), key);
  for (const value of [undefined, null, '', 42]) {
    assert.throws(() => keyModule.getPlatformDataEncryptionKey(value), (error) => {
      assert.equal(error.name, 'PlatformDataEncryptionKeyError');
      assert.equal(error.failureCode, 'PLATFORM_ENCRYPTION_KEY_MISSING');
      assert.equal(error.status, 503);
      assert.equal(error.code, 'INTERNAL_ERROR');
      return true;
    });
  }
  for (const value of [
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    key.toString('hex'),
    key.toString('base64') + '\n',
    ` ${key.toString('base64')}`,
    `${key.toString('base64')} `,
    key.toString('base64').replace(/=$/, '=='),
    Buffer.alloc(32, 255).toString('base64').replaceAll('+', '-').replaceAll('/', '_'),
    'not*base64',
  ]) {
    assert.throws(() => keyModule.getPlatformDataEncryptionKey(value), (error) => {
      assert.equal(error.name, 'PlatformDataEncryptionKeyError');
      assert.ok([
        'PLATFORM_ENCRYPTION_KEY_INVALID_ENCODING',
        'PLATFORM_ENCRYPTION_KEY_INVALID_SIZE',
      ].includes(error.failureCode));
      assert.equal(error.message.includes(value), false, 'configuration errors must not reveal the configured secret');
      return true;
    });
  }
});

test('AES-GCM envelopes use the validated key and round-trip under the canonical representation', () => {
  const key = crypto.randomBytes(32);
  const configured = key.toString('base64');
  const previous = process.env.PLATFORM_DATA_ENCRYPTION_KEY;
  process.env.PLATFORM_DATA_ENCRYPTION_KEY = configured;
  try {
    const hubModule = loadTypeScript('src/lib/hubOperatorCredentials.ts', {
      './prisma': { prisma: {} },
      './stage1Crypto': { randomSecret: () => '', sha256: () => '' },
      './platformDataEncryptionKey': keyModule,
      '@prisma/client': { Prisma: {} },
    });
    const cleartext = 'synthetic-removal-notice-payload';
    const encrypted = hubModule.encryptPlatformEnvelope(cleartext);
    assert.equal(hubModule.decryptPlatformEnvelope(JSON.stringify(encrypted)), cleartext);
    assert.throws(() => hubModule.decryptPlatformEnvelope(JSON.stringify({ ...encrypted, extra: 'field' })), /encrypted envelope invalid/);
    process.env.PLATFORM_DATA_ENCRYPTION_KEY = key.toString('hex');
    assert.throws(() => hubModule.encryptPlatformEnvelope(cleartext), (error) => error.name === 'PlatformDataEncryptionKeyError');
    assert.throws(() => hubModule.decryptPlatformEnvelope(JSON.stringify(encrypted)), (error) => error.name === 'PlatformDataEncryptionKeyError');
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_DATA_ENCRYPTION_KEY;
    else process.env.PLATFORM_DATA_ENCRYPTION_KEY = previous;
  }
});

test('APNs digest retains its exact HMAC contract for the same preserved 32 key bytes', () => {
  const key = crypto.randomBytes(32);
  const originalHex = key.toString('hex');
  const canonicalBase64 = Buffer.from(originalHex, 'hex').toString('base64');
  assert.deepEqual(Buffer.from(canonicalBase64, 'base64'), key);
  const previous = process.env.PLATFORM_DATA_ENCRYPTION_KEY;
  process.env.PLATFORM_DATA_ENCRYPTION_KEY = canonicalBase64;
  try {
    const token = 'ab'.repeat(32);
    const expected = crypto.createHmac('sha256', key)
      .update('dinodia-v2-apns-token-v1\0').update(token).digest('hex');
    assert.equal(keyModule.platformDataEncryptionTokenDigest(token), expected);
    assert.equal(keyModule.platformDataEncryptionTokenDigest(token).length, 64);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_DATA_ENCRYPTION_KEY;
    else process.env.PLATFORM_DATA_ENCRYPTION_KEY = previous;
  }
});

test('Production configuration readiness validates the exact helper without printing secret material', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-key-readiness-'));
  fs.chmodSync(directory, 0o700);
  const envPath = path.join(directory, 'production.env');
  const key = crypto.randomBytes(32).toString('base64');
  const source = [
    'V2_ENVIRONMENT=production',
    'VERCEL_PROJECT_ID=prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y',
    'SUPABASE_PROJECT_REF=fppzzesvukjbsfmxmfxe',
    `PLATFORM_DATA_ENCRYPTION_KEY=${key}`,
  ].join('\n');
  fs.writeFileSync(envPath, source, { mode: 0o600 });
  try {
    const script = path.join(root, 'scripts/check_platform_data_encryption_key.mjs');
    const valid = spawnSync(process.execPath, [script, '--env', envPath,
      '--project-id', 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y', '--supabase-ref', 'fppzzesvukjbsfmxmfxe'], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), {
      ok: true, target: 'production', keyEncoding: 'canonical-base64', keySizeValid: true,
      envelopeRoundTrip: true, tokenDigestContract: true,
    });
    assert.equal(valid.stdout.includes(key), false);

    fs.writeFileSync(envPath, source.replace(key, crypto.randomBytes(32).toString('hex')), { mode: 0o600 });
    const invalid = spawnSync(process.execPath, [script, '--env', envPath,
      '--project-id', 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y', '--supabase-ref', 'fppzzesvukjbsfmxmfxe'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.deepEqual(JSON.parse(invalid.stdout), { ok: false, code: 'PLATFORM_ENCRYPTION_KEY_INVALID_SIZE' });
    assert.equal(invalid.stdout.includes(key), false);
  } finally {
    fs.unlinkSync(envPath);
    fs.rmdirSync(directory);
  }
});
