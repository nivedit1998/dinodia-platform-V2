import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; new Function('require', 'module', 'exports', output)(name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name+'.ts')):require(name), module, module.exports); return module.exports;
}
const { classifyUsageAuthority } = load('src/lib/analyticsIntervals.ts');
test('historical catalog power capability prevents brightness bypass and writable heat is excluded', () => {
  const { allowedAnalyticsControls } = load('src/lib/analyticsIntervals.ts');
  assert.deepEqual(allowedAnalyticsControls('LIGHT', [{ controlId: 'p', semanticRole: 'power', observable: true, surfaceId: 'one' }, { controlId: 'b', semanticRole: 'brightness', observable: true, surfaceId: 'one' }], null), ['p']);
  assert.deepEqual(allowedAnalyticsControls('RADIATOR', [{ controlId: 'mode', semanticRole: 'active_heat_demand', observable: true, writable: true, surfaceId: 'one' }], null), []);
});
const at = n => new Date(`2026-10-23T10:${String(n).padStart(2, '0')}:00Z`);
const intervals = [
  { id: 'a', revision: 1, analyticsCategory: 'LIGHT', selectedControlId: 'power', sourceGeneration: 1, validFrom: at(0), validUntil: at(10) },
  { id: 'b', revision: 2, analyticsCategory: 'RADIATOR', selectedControlId: 'heat', sourceGeneration: 1, validFrom: at(10), validUntil: at(20) },
  { id: 'c', revision: 3, analyticsCategory: 'LIGHT', selectedControlId: 'power', sourceGeneration: 1, validFrom: at(20), validUntil: null },
];
test('policy-3 epoch cannot accept a policy-2 writer even with matching control and interval', () => {
  const rows = [{ ...intervals[2], analyticsPolicyVersion: 3 }];
  const input = { intervals: rows, start: at(21), end: at(25), category: 'LIGHT', controlId: 'power', generation: 1,
    intervalId: 'c', bindingRevision: 3, analyticsPolicyVersion: 2 };
  assert.equal(classifyUsageAuthority(input).status, 'denied');
  assert.equal(classifyUsageAuthority({ ...input, analyticsPolicyVersion: 3 }).status, 'accepted');
});
test('immediate edits preserve ambiguous legacy coverage instead of guessing a split', () => {
  assert.equal(classifyUsageAuthority({ intervals, start: at(5), end: at(15), category: 'LIGHT', controlId: 'power', generation: 1 }).status, 'unallocated');
  assert.equal(classifyUsageAuthority({ intervals, start: at(1), end: at(9), category: 'LIGHT', controlId: 'power', generation: 1 }).status, 'accepted');
});
test('new writer requires the exact historical interval and source selection', () => {
  const input = { intervals, start: at(1), end: at(9), category: 'LIGHT', controlId: 'power', generation: 1, intervalId: 'a', bindingRevision: 1 };
  assert.equal(classifyUsageAuthority(input).status, 'accepted');
  assert.equal(classifyUsageAuthority({ ...input, intervalId: 'c' }).status, 'denied');
  assert.equal(classifyUsageAuthority({ ...input, controlId: 'other' }).status, 'denied');
  assert.equal(classifyUsageAuthority({ ...input, generation: 2 }).status, 'denied');
});
test('legacy rollback after new-writer coverage is preserved as unallocated', () => {
  assert.equal(classifyUsageAuthority({ intervals, start: at(20), end: at(25), category: 'LIGHT', controlId: 'power', generation: 1, newWriterFrom: at(20) }).status, 'unallocated');
});
test('new-format source switches back within the same hour remain separate', () => {
  assert.equal(classifyUsageAuthority({ intervals, start: at(20), end: at(25), category: 'LIGHT', controlId: 'power', generation: 1, intervalId: 'c', bindingRevision: 3 }).status, 'accepted');
});

test('new devices inherit enabled evidence-writer policy, never a fixed-window fallback', async () => {
  const { changeAnalyticsInterval } = load('src/lib/analyticsIntervals.ts');
  for (const [enabled, capable, expected] of [[true, true, 3], [true, false, 2], [false, true, 2]]) {
    const tx = { $queryRaw: async () => [], nativeDevice: { findFirst: async () => ({ capabilitySummary: { controlCatalog: { controls: [] } } }) },
      hubInstallation: { findUnique: async () => ({ analyticsWriterEnabled: enabled, capabilitySummary: { nativeStateEvidenceV2: capable } }) },
      nativeAnalyticsInterval: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), create: async ({ data }) => data } };
    const interval = await changeAnalyticsInterval(tx, { homeId: 'home', hubInstallationId: 'hub', deviceId: 'new',
      category: 'NONE', selectedControlId: null, generation: 3, at: at(0) });
    assert.equal(interval.analyticsPolicyVersion, expected);
  }
});
