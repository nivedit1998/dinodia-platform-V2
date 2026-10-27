import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(path.resolve('src/lib/analyticsContractAcknowledgement.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', js)(require, module, module.exports);
const { hasCurrentAnalyticsContract: valid } = module.exports;
const now = new Date('2026-10-27T12:00:00.000Z');
const current = { homeId: 'home', hubInstallationId: 'hub', manufacturingIdentityId: 'identity', identityGeneration: 3,
  identityActive: true, installationActive: true, currentCloudRevision: 12 };
const proof = { homeId: 'home', hubInstallationId: 'hub', manufacturingIdentityId: 'identity', identityGeneration: 3,
  analyticsContractVersion: 1, appliedCloudRevision: 12, receivedAt: new Date(now.getTime() - 60_000), invalidatedAt: null };
const check = (p = proof, c = current, version = 1, time = now, age = 120_000) => valid(p, c, version, time, age);

test('only exact active Home, installation, identity, revision and version pass', () => {
  assert.equal(check(), true);
  for (const change of [{ homeId: 'another' }, { hubInstallationId: 'another' }, { manufacturingIdentityId: 'another' },
    { identityGeneration: 4 }, { identityActive: false }, { installationActive: false }, { currentCloudRevision: 13 }])
    assert.equal(check(proof, { ...current, ...change }), false, JSON.stringify(change));
  for (const change of [{ homeId: 'another' }, { hubInstallationId: 'another' }, { manufacturingIdentityId: 'another' },
    { identityGeneration: 2 }, { analyticsContractVersion: 2 }, { appliedCloudRevision: 11 }, { invalidatedAt: now }])
    assert.equal(check({ ...proof, ...change }), false, JSON.stringify(change));
});

test('expired, future, malformed and explicitly invalidated proofs fail closed', () => {
  assert.equal(check({ ...proof, receivedAt: new Date(now.getTime() - 120_001) }), false);
  assert.equal(check({ ...proof, receivedAt: new Date(now.getTime() + 1) }), false);
  assert.equal(check({ ...proof, receivedAt: new Date('invalid') }), false);
  assert.equal(check({ ...proof, invalidatedAt: undefined }), false);
  assert.equal(check(null), false);
  assert.equal(check(proof, current, 1, now, 0), false);
  assert.equal(check(proof, { ...current, identityGeneration: 0 }), false);
  assert.equal(check(proof, { ...current, currentCloudRevision: 3_000_000_000 }), false);
});
