import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(path.join(root, 'src/lib/homeownerLifecycleAvailability.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const module = { exports: {} };
const localRequire = (specifier) => {
  if (specifier === './customerSelectedHome') return { requireCustomerSelectedHome: async () => null };
  if (specifier === './stage1Auth') return { Stage1AuthError: class Stage1AuthError extends Error {} };
  return require(specifier);
};
new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
const { homeownerLifecycleMutationsEnabled, homeownerDeregistrationEnabled } = module.exports;

test('ownership transfer remains globally off except explicit Stage 13 Production release or disposable rehearsal', () => {
  assert.equal(homeownerLifecycleMutationsEnabled({ V2_ENVIRONMENT: 'production' }), false);
  assert.equal(homeownerLifecycleMutationsEnabled({ V2_ENVIRONMENT: 'production', STAGE9_LIFECYCLE_REHEARSAL: 'true' }), false);
  assert.equal(homeownerLifecycleMutationsEnabled({ V2_ENVIRONMENT: 'local', STAGE13_HOME_TRANSFER_RELEASED: 'true' }), false);
  assert.equal(homeownerLifecycleMutationsEnabled({ V2_ENVIRONMENT: 'production', STAGE13_HOME_TRANSFER_RELEASED: 'true' }), true);
  assert.equal(homeownerLifecycleMutationsEnabled({ V2_ENVIRONMENT: 'test' }), false);
  assert.equal(homeownerLifecycleMutationsEnabled({ V2_ENVIRONMENT: 'test', STAGE9_LIFECYCLE_REHEARSAL: 'true' }), true);
});

test('full-home deregistration has its own independent Stage 13 release decision', () => {
  assert.equal(homeownerDeregistrationEnabled({ V2_ENVIRONMENT: 'production' }), false);
  assert.equal(homeownerDeregistrationEnabled({ V2_ENVIRONMENT: 'production', STAGE13_HOME_TRANSFER_RELEASED: 'true' }), false);
  assert.equal(homeownerDeregistrationEnabled({ V2_ENVIRONMENT: 'test', STAGE9_LIFECYCLE_REHEARSAL: 'true' }), false);
  assert.equal(homeownerDeregistrationEnabled({ V2_ENVIRONMENT: 'test', STAGE13_DEREGISTRATION_REHEARSAL: 'true' }), true);
  assert.equal(homeownerDeregistrationEnabled({ V2_ENVIRONMENT: 'production', STAGE13_HOME_DEREGISTRATION_RELEASED: 'true' }), true);
});
