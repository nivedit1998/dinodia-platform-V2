import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', js)(name => name.startsWith('.')
    ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name), module, module.exports);
  return module.exports;
}
const { validMultiStateDailyPayload: valid, multiStateDailyAggregateId: id, MULTISTATE_STATES } = load('src/lib/multiStateAnalyticsContract.ts');
const iso = ms => new Date(ms).toISOString();
function payload(category = 'AC', instant = '2026-10-25T12:00:00.000Z') {
  const { historyDay } = load('src/lib/analyticsHistoryCalendar.ts');
  const day = historyDay(Date.parse(instant), 'Europe/London');
  const policy = MULTISTATE_STATES[category];
  const durationsSeconds = Object.fromEntries(policy.states.map(state => [state, 0]));
  durationsSeconds.unknown = (day.end - day.start) / 1000;
  return { contractVersion: 1, osDeviceId: 'device:synthetic', osAreaId: 'area:synthetic',
    analyticsCategory: category, dimension: policy.dimension, controlId: 'control:synthetic', sourceGeneration: 1,
    bindingRevision: 1, analyticsIntervalId: '11111111-1111-4111-8111-111111111111', analyticsPolicyVersion: 4,
    timezone: 'Europe/London', writerFrom: '2026-01-01T00:00:00.000Z', dayStartAt: iso(day.start), dayEndAt: iso(day.end),
    assignmentEpochAt: '2026-01-01T00:00:00.000Z', revision: 1, coverageStartAt: iso(day.start), coverageEndAt: iso(day.end),
    closedAt: iso(day.end), durationsSeconds };
}

test('each allowed category conserves exactly its own fixed dimension and states', () => {
  for (const category of Object.keys(MULTISTATE_STATES)) {
    const p = payload(category);
    assert.equal(valid(p), true, category);
    assert.equal(valid({ ...p, dimension: 'other' }), false);
    assert.equal(valid({ ...p, durationsSeconds: { ...p.durationsSeconds, invented: 0 } }), false);
    assert.equal(valid({ ...p, durationsSeconds: { ...p.durationsSeconds, unknown: p.durationsSeconds.unknown - 1 } }), false);
    assert.equal(valid({ ...p, unrecognized: true }), false);
  }
});

test('calendar boundaries and full-day accounting support both DST transitions', () => {
  for (const [instant, seconds] of [['2026-03-29T12:00:00.000Z', 23 * 3600], ['2026-10-25T12:00:00.000Z', 25 * 3600]]) {
    const p = payload('BLIND', instant);
    assert.equal(p.durationsSeconds.unknown, seconds);
    assert.equal(valid(p), true);
    assert.equal(valid({ ...p, dayEndAt: iso(Date.parse(p.dayEndAt) + 3600000) }), false);
  }
});

test('partial coverage permits mixed activity only when every second is accounted for', () => {
  const p = payload('AC');
  const start = Date.parse(p.dayStartAt) + 3600 * 1000;
  const mixed = { ...p, coverageStartAt: iso(start), coverageEndAt: iso(start + 300 * 1000), closedAt: null,
    durationsSeconds: { heating: 60, cooling: 70, idle: 80, unknown: 90 } };
  assert.equal(valid(mixed), true);
  assert.equal(valid({ ...mixed, durationsSeconds: { ...mixed.durationsSeconds, unknown: 91 } }), false);
});

test('bad durations, epochs, dimensions and contract versions fail closed', () => {
  const p = payload();
  for (const change of [
    { analyticsCategory: 'LIGHT' }, { contractVersion: 2 }, { analyticsPolicyVersion: 3 },
    { sourceGeneration: 0 }, { revision: 0 }, { analyticsIntervalId: null },
    { sourceGeneration: 3_000_000_000 }, { bindingRevision: 3_000_000_000 }, { revision: 3_000_000_000 },
    { coverageStartAt: iso(Date.parse(p.coverageStartAt) - 1000) },
    { assignmentEpochAt: iso(Date.parse(p.coverageStartAt) + 1000) },
    { durationsSeconds: { ...p.durationsSeconds, unknown: -1 } },
    { durationsSeconds: { ...p.durationsSeconds, unknown: 1.5 } },
    { durationsSeconds: { ...p.durationsSeconds, heating: Number.MAX_SAFE_INTEGER } },
    { timezone: 'invalid/zone' },
  ]) assert.equal(valid({ ...p, ...change }), false, JSON.stringify(change));
});

test('exact state and top-level keys cannot be smuggled with separators or coerced categories', () => {
  const p = payload('AC');
  const joinedStates = { 'cooling\nheating': 0, idle: 0, unknown: p.durationsSeconds.unknown };
  assert.equal(valid({ ...p, durationsSeconds: joinedStates }), false);
  const joinedKeys = { ...p };
  delete joinedKeys.analyticsCategory;
  delete joinedKeys.analyticsIntervalId;
  joinedKeys['analyticsCategory\nanalyticsIntervalId'] = 'AC';
  assert.equal(valid(joinedKeys), false);
  assert.equal(valid({ ...p, analyticsCategory: ['AC'] }), false);
});

test('aggregate identity separates assignments, channels and unambiguous string components', () => {
  const p = payload('TV');
  assert.equal(id(p), id({ ...p, revision: 2, durationsSeconds: { on: 5, off: 0, unknown: p.durationsSeconds.unknown - 5 } }));
  for (const change of [{ osAreaId: 'another-area' }, { controlId: 'another-control' }, { sourceGeneration: 2 },
    { assignmentEpochAt: '2026-01-02T00:00:00.000Z' }]) assert.notEqual(id(p), id({ ...p, ...change }));
  assert.notEqual(id({ ...p, osDeviceId: 'a|b', osAreaId: 'c' }), id({ ...p, osDeviceId: 'a', osAreaId: 'b|c' }));
});

test('hourly detail exactly partitions daily coverage without duplicate hours or state substitution', () => {
  const p = payload('TV');
  p.coverageEndAt = iso(Date.parse(p.coverageStartAt) + 7200000);
  p.closedAt = null;
  p.durationsSeconds = {on: 3600, off: 0, unknown: 3600};
  p.hourly = [0, 1].map(i => ({hourStartAt: iso(Date.parse(p.coverageStartAt) + i*3600000),
    coverageStartAt: iso(Date.parse(p.coverageStartAt) + i*3600000),
    coverageEndAt: iso(Date.parse(p.coverageStartAt) + (i+1)*3600000),
    durationsSeconds: {on: i ? 0 : 3600, off: 0, unknown: i ? 3600 : 0}}));
  assert.equal(valid(p), true);
  assert.equal(valid({...p, hourly: []}), true);
  assert.equal(valid({...p, hourly: [p.hourly[0], p.hourly[0]]}), false);
  assert.equal(valid({...p, hourly: [p.hourly[0]]}), false);
  assert.equal(valid({...p, hourly: p.hourly.map(h => ({...h, durationsSeconds: {on:0, off:0, unknown:3600}}))}), false);
  assert.equal(valid({...p, bindingRevision:0}), false);
});
