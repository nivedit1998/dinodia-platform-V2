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
const calendar = load('src/lib/analyticsHistoryCalendar.ts');
const contract = load('src/lib/dailyAnalyticsContract.ts');
const hubRoot = process.env.DINODIA_OS_ROOT || path.resolve('../hub-calendar-retention-20261025');
const hubCalendar = require(path.join(hubRoot, 'src/sync/analyticsCalendar.js'));
const daily = require(path.join(hubRoot, 'src/sync/dailyAnalytics.js'));
const source = { osDeviceId: 'device', osAreaId: 'area', category: 'RADIATOR', controlId: 'heat',
  sourceGeneration: 1, bindingRevision: 0, analyticsPolicyVersion: 2 };
const writerFrom = '2026-10-19T00:00:00.000Z';
function state() { const s = {}; daily.initialize(s, { version: 1, enabled: true, timezone: 'Europe/London', writerFrom }); return s; }

test('Hub and Platform agree on DST, fractional offsets, leap years and Monday cutoffs', () => {
  for (const zone of ['Europe/London', 'UTC', 'Asia/Kathmandu', 'Asia/Kolkata', 'Pacific/Kiritimati', 'America/New_York']) {
    for (const instant of ['2026-10-25T12:00:00Z', '2026-10-26T00:00:00Z', '2026-03-29T01:30:00Z', '2028-02-29T12:00:00Z']) {
      const ms = Date.parse(instant);
      assert.deepEqual(calendar.historyDay(ms, zone), hubCalendar.calendarDay(ms, zone));
      assert.deepEqual(calendar.historyWeek(ms, zone), hubCalendar.calendarWeek(ms, zone));
      assert.equal(calendar.historyYearCutoff(ms, zone), hubCalendar.annualDayCutoff(ms, zone));
    }
  }
});
test('actual Hub absolute usage snapshots satisfy the cloud contract and identity', () => {
  const s = state(), start = Date.parse('2026-10-25T12:00:00Z');
  daily.recordUsageInterval(s, source, start, start + 600000, 'on');
  const [event] = daily.dailyEvents(s);
  assert.equal(contract.validDailyPayload(event.payload), true);
  assert.equal(contract.dailyAggregateId(event.payload), event.aggregateId);
  assert.equal(contract.validDailyPayload({ ...event.payload, onSeconds: 601 }), false);
  assert.equal(contract.validDailyPayload({ ...event.payload, unauthorized: true }), false);
});
test('actual Hub temperature snapshot carries exact sufficient statistics, not an average of averages', () => {
  const s = state(), start = Date.parse('2026-10-25T12:00:00Z');
  daily.observeTemperature(s, { ...source, observedAt: new Date(start).toISOString(),
    validUntil: new Date(start + 600000).toISOString(), value: 20 }, start + 600000);
  const [event] = daily.dailyEvents(s);
  assert.equal(contract.validDailyPayload(event.payload), true);
  assert.equal(contract.dailyAggregateId(event.payload), event.aggregateId);
  assert.equal(event.payload.celsiusMilliseconds, 12000000);
  assert.equal(event.payload.knownMilliseconds, 600000);
  assert.equal(contract.validDailyPayload({ ...event.payload, knownMilliseconds: 600001 }), false);
});

test('connected ingestion replaces newer absolute counters, rejects private uploads and fences writer order', async () => {
  const oldFlag = process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;
  process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = 'true';
  try {
    const { ingestDailyAnalytics } = load('src/lib/dailyAnalyticsIngestion.ts');
    const s = state(), start = Date.parse('2026-10-25T12:00:00Z');
    daily.recordUsageInterval(s, source, start, start + 600000, 'on');
    let row = null, writes = 0;
    const retention = { homeId: 'home', writerEnabled: true, timezone: 'Europe/London', writerFrom: new Date(writerFrom),
      barrierStreamId: 'stream', barrierSequence: 10n };
    const device = { id: 'device-id', homeId: 'home', managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null,
      lifecycle: 'INSTALLED', analyticsCategory: 'RADIATOR', capabilitySummary: { controlCatalog: { controls: [
        { controlId: 'heat', semanticRole: 'active_heat_demand', observable: true, writable: false },
      ] } } };
    const tx = { $queryRaw: async () => [],
      nativeAnalyticsRetention: { findUnique: async () => retention },
      hubInstallation: { findUnique: async () => ({ homeId: 'home', analyticsWriterEnabled: true }) },
      nativeDevice: { findUnique: async () => device }, area: { findUnique: async () => ({ id: 'area-id', status: 'ACTIVE' }) },
      deviceAreaAssignment: { findFirst: async () => ({ validFrom: new Date('2026-10-01T00:00:00Z') }) },
      nativeAnalyticsInterval: { findMany: async () => [] },
      nativeAnalyticsDay: { findUnique: async () => row, findFirst: async () => null,
        create: async ({ data }) => { row = { ...data, id: 'day-id' }; writes++; },
        update: async ({ data }) => { row = { ...data, id: 'day-id' }; writes++; } },
    };
    const input = { homeId: 'home', hubInstallationId: 'hub', identityGeneration: 1, streamId: 'stream', now: new Date(start + 1200000),
      event: { type: 'analytics.day', sequence: 11, payload: daily.dailyEvents(s)[0].payload } };
    await ingestDailyAnalytics(tx, input);
    await ingestDailyAnalytics(tx, input);
    assert.equal(writes, 1, 'same revision/digest is idempotent');
    daily.recordUsageInterval(s, source, start + 600000, start + 1200000, 'off');
    input.event.payload = daily.dailyEvents(s)[0].payload;
    await ingestDailyAnalytics(tx, input);
    assert.equal(writes, 2);
    assert.equal(row.onSeconds, 600); assert.equal(row.offSeconds, 600);
    assert.equal(row.onSeconds + row.offSeconds, 1200, 'replacement does not add the previous snapshot twice');
    device.ownerMembershipId = 'tenant';
    await assert.rejects(ingestDailyAnalytics(tx, input), error => error.code === 'hub_sync_daily_device_invalid');
    device.ownerMembershipId = null; retention.barrierStreamId = null;
    await assert.rejects(ingestDailyAnalytics(tx, input), error => error.code === 'hub_sync_daily_barrier_missing');
  } finally {
    if (oldFlag === undefined) delete process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;
    else process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = oldFlag;
  }
});
