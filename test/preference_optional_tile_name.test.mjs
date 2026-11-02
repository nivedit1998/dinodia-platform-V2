import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file) {
  const m = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  new Function('require', 'module', 'exports', js + (file.endsWith('nativePreferences.ts') ? '\nmodule.exports.documentValid = documentValid;' : ''))(
    id => id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id), m, m.exports);
  return m.exports;
}
const { documentValid } = load(path.resolve('src/lib/nativePreferences.ts'));
const tile = { deviceId: '11111111-1111-4111-8111-111111111111', size: 'STANDARD', position: 0 };
const valid = t => documentValid('DASHBOARD_LAYOUT', { version: 1, tiles: [t] });
test('ordered tiles can omit a custom name as the existing contract permits', () => {
  assert.equal(valid(tile), true);
  assert.equal(valid({ ...tile, label: 'My radiator' }), true);
});
test('optional name does not relax position, label or unknown-field validation', () => {
  for (const patch of [{ position: -1 }, { position: 500 }, { label: null }, { label: '' }, { label: ' x ' }, { role: 'OWNER' }])
    assert.equal(valid({ ...tile, ...patch }), false);
});
