import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/contracts/analyticsV1.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/category-analytics-next-policy.json', import.meta.url), 'utf8'));
for (const row of fixture.cases) test('next category policy: ' + row.id, () => {
  assert.equal(module.exports.classifyActivityV1({ ...row, quality: 'fresh',
    validUntil: fixture.validUntil }, Date.parse(fixture.now)), row.expected);
});
