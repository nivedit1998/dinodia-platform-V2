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

test('daily usage fragments retain the distinct device-day divisor for larger periods', () => {
  const { aggregateDailyUsage } = load('src/lib/dailyAnalyticsAggregation.ts');
  const day = calendar.historyDay(Date.parse('2026-10-25T12:00:00Z'), 'Europe/London');
  const base = { deviceId: 'a', areaId: 'room', timezone: 'Europe/London', dayStartAt: new Date(day.start), dayEndAt: new Date(day.end),
    onSeconds: 3600, offSeconds: 0, unknownSeconds: 0, coverageStartAt: new Date(day.start), coverageEndAt: new Date(day.start + 3600000) };
  const rows = [base, { ...base, onSeconds: 0, offSeconds: 3600, coverageStartAt: new Date(day.start + 3600000), coverageEndAt: new Date(day.start + 7200000) },
    { ...base, deviceId: 'b', onSeconds: 0, offSeconds: 1800, coverageEndAt: new Date(day.start + 1800000) }];
  const [bucket] = aggregateDailyUsage(rows, 'week', 'Europe/London', new Date('2026-10-25T12:00:00Z'));
  assert.equal(bucket.contributingDeviceDays, 2);
  assert.equal(bucket.onMinutes, 30); assert.equal(bucket.offMinutes, 45);
  assert.equal(bucket.coverageSeconds, 9000);
  assert.throws(() => aggregateDailyUsage(rows, 'hour', 'Europe/London', new Date()), /cannot reconstruct hourly/);
});

test('approved temperature mean weights genuine device-duration, without inventing continuous segments', () => {
  const { aggregateDailyTemperature } = load('src/lib/dailyAnalyticsAggregation.ts');
  const day = calendar.historyDay(Date.parse('2026-10-25T12:00:00Z'), 'Europe/London');
  const base = { deviceId: 'a', areaId: 'room', timezone: 'Europe/London', dayStartAt: new Date(day.start), dayEndAt: new Date(day.end),
    knownMilliseconds: 600000n, celsiusMilliseconds: 12000000, minimumCelsius: 20, maximumCelsius: 20, sampleCount: 1,
    lastCelsius: 20, lastObservedAt: new Date(day.start), lastValidUntil: new Date(day.start + 600000) };
  const [point] = aggregateDailyTemperature([base, { ...base, deviceId: 'b', knownMilliseconds: 300000n,
    celsiusMilliseconds: 9000000, minimumCelsius: 30, maximumCelsius: 30, lastCelsius: 30 }], 'month', 'Europe/London');
  assert.equal(point.celsius, 23.33);
  assert.equal(point.knownDeviceSeconds, 900);
  assert.equal(point.coverageBasis, 'device_time');
  assert.equal(point.currentFresh, false);
  assert.deepEqual(point.segments, []);
});

test('legacy backfill keeps exact counters and replaces overlapping temperature validity with the later genuine report', () => {
  const { buildLegacyDays } = load('src/lib/dailyAnalyticsBackfill.ts');
  const start = Date.parse('2026-10-24T10:00:00Z'), day = calendar.historyDay(start, 'Europe/London');
  const input = { homeId: 'home', timezone: 'Europe/London', writerFrom: new Date('2026-10-25T00:00:00Z'), day,
    usage: [{ id: 'hour', deviceId: 'a', areaId: 'room', bucketStart: new Date(start), closedAt: new Date(start + 3600000),
      onSeconds: 1800, offSeconds: 1800, unknownSeconds: 0, controlId: 'power', analyticsCategory: 'LIGHT',
      sourceGeneration: 1, bindingRevision: 0, analyticsIntervalId: null, analyticsPolicyVersion: 1 }],
    temperature: [0, 300000].map((delta, i) => ({ id: `sample-${i}`, deviceId: 'a', areaId: 'room', sourceGeneration: 1,
      temperature: i ? 24 : 20, sourceObservedAt: new Date(start + delta), validUntil: new Date(start + delta + 600000),
      currentnessEndedAt: null, analyticsPolicyVersion: 2 })),
    assignments: [{ deviceId: 'a', areaId: 'room', validFrom: new Date(day.start), validUntil: null }], intervals: [] };
  const rows = buildLegacyDays(input);
  const usage = rows.find(r => r.kind === 'USAGE'), temp = rows.find(r => r.kind === 'TEMPERATURE');
  assert.equal(usage.onSeconds, 1800); assert.equal(usage.offSeconds, 1800);
  assert.equal(temp.knownMilliseconds, 900000n);
  assert.equal(temp.celsiusMilliseconds, 20400000);
  assert.equal(temp.minimumCelsius, 20); assert.equal(temp.maximumCelsius, 24);
  assert.equal(temp.payloadDigest, buildLegacyDays(input).find(r => r.kind === 'TEMPERATURE').payloadDigest);
});

test('mixed legacy UTC hour crossing fractional-offset midnight is retained, never prorated as a measurement', () => {
  const { buildLegacyDays } = load('src/lib/dailyAnalyticsBackfill.ts');
  const start = Date.parse('2026-10-24T18:00:00Z'), day = calendar.historyDay(start, 'Asia/Kolkata');
  assert.throws(() => buildLegacyDays({ homeId: 'home', timezone: 'Asia/Kolkata', writerFrom: new Date('2026-10-25T00:00:00Z'), day,
    usage: [{ id: 'hour', deviceId: 'a', areaId: 'room', bucketStart: new Date(start), closedAt: new Date(start + 3600000),
      onSeconds: 1800, offSeconds: 1800, unknownSeconds: 0, analyticsCategory: 'LIGHT', controlId: 'power', sourceGeneration: 1,
      bindingRevision: 0, analyticsIntervalId: null, analyticsPolicyVersion: 1 }], temperature: [], assignments: [], intervals: [] }),
  /legacy_usage_boundary_requires_detail/);
});

test('daily expiry uses local calendar years and safely clamps leap days', () => {
  assert.equal(new Date(calendar.historyDayExpiry(Date.parse('2028-02-29T12:00:00Z'), 'UTC')).toISOString(), '2029-03-01T00:00:00.000Z');
  assert.equal(new Date(calendar.historyDayExpiry(Date.parse('2028-02-28T12:00:00Z'), 'UTC')).toISOString(), '2029-03-01T00:00:00.000Z');
});

test('both writers resolve a skipped midnight to the first actual instant of that local date', () => {
  const time = Date.parse('2026-09-06T16:00:00Z');
  const day = calendar.historyDay(time, 'America/Santiago');
  assert.deepEqual(day, hubCalendar.calendarDay(time, 'America/Santiago'));
  assert.equal(new Date(day.start).toISOString(), '2026-09-06T04:00:00.000Z');
  assert.equal(day.end - day.start, 23 * 3600000);
});

test('compaction verifies temporal attribution, extrema and latest evidence as well as integral totals', () => {
  const { buildLegacyDays } = load('src/lib/dailyAnalyticsBackfill.ts');
  const { dailyStatisticsAgree } = load('src/lib/dailyAnalyticsMaintenance.ts');
  const start = Date.parse('2026-10-24T10:00:00Z'), day = calendar.historyDay(start, 'Europe/London');
  const assignments = [{ deviceId: 'a', areaId: 'room', validFrom: new Date(day.start), validUntil: null }];
  const rows = buildLegacyDays({ homeId: 'home', timezone: 'Europe/London', writerFrom: new Date(day.end), day,
    usage: [], assignments, intervals: [], temperature: [{ id: 'sample', deviceId: 'a', areaId: 'room', sourceGeneration: 1,
      temperature: 20, sourceObservedAt: new Date(start), validUntil: new Date(start + 600000), currentnessEndedAt: null, analyticsPolicyVersion: 2 }] });
  assert.equal(dailyStatisticsAgree(rows, rows, assignments), true);
  for (const mutation of [ { minimumCelsius: 19 }, { maximumCelsius: 21 }, { lastCelsius: 21 },
    { sampleCount: 2 }, { lastObservedAt: new Date(start + 1) }, { lastValidUntil: new Date(start + 600001) },
    { coverageEndAt: new Date(start + 600001) }, { assignmentEpochAt: new Date(start + 1) } ])
    assert.equal(dailyStatisticsAgree(rows, [{ ...rows[0], ...mutation }], assignments), false, JSON.stringify(mutation));
});

test('bounded scheduled maintenance rotates past the first twenty installations', async () => {
  const { maintainDailyAnalytics } = load('src/lib/dailyAnalyticsMaintenance.ts');
  const states = Array.from({ length: 21 }, (_, i) => ({ hubInstallationId: String(i).padStart(3, '0'), updatedAt: new Date(i),
    writerEnabled: true, legacySealedThrough: null, timezone: 'UTC' }));
  const visited = new Set();
  const tx = { $queryRaw: async () => [], nativeAnalyticsRetention: {
    findUniqueOrThrow: async ({ where }) => { visited.add(where.hubInstallationId); return states.find(s => s.hubInstallationId === where.hubInstallationId); } } };
  const db = { $transaction: async callback => callback(tx), $executeRaw: async () => 0, nativeAnalyticsRetention: {
    findMany: async ({ orderBy, take }) => { assert.deepEqual(orderBy, [{ updatedAt: 'asc' }, { hubInstallationId: 'asc' }]);
      return [...states].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, take); },
    update: async ({ where, data }) => Object.assign(states.find(s => s.hubInstallationId === where.hubInstallationId), data) } };
  const previous = process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED; process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = 'true';
  try { await maintainDailyAnalytics(db, new Date(100000)); await maintainDailyAnalytics(db, new Date(200000));
    assert.equal(visited.size, 21); } finally {
    if (previous === undefined) delete process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED; else process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = previous;
  }
});

test('annual expiry still runs when legacy conversion cannot proceed', async () => {
  const { maintainDailyAnalytics } = load('src/lib/dailyAnalyticsMaintenance.ts');
  let expired = false, recorded = null;
  const db = { $executeRaw: async () => { expired = true; return 1; },
    $transaction: async () => { assert.equal(expired, true); throw new Error('legacy_usage_boundary_requires_detail'); },
    nativeAnalyticsRetention: { findMany: async () => [{ hubInstallationId: 'hub', homeId: 'home', timezone: 'UTC' }],
      update: async ({ data }) => { recorded = data.backlogReason; } } };
  const prior = process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;
  process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = 'true';
  try { await maintainDailyAnalytics(db, new Date('2026-10-25T12:00:00Z'));
    assert.equal(expired, true); assert.equal(recorded, 'legacy_usage_boundary_requires_detail');
  } finally { if (prior === undefined) delete process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;
    else process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = prior; }
});
