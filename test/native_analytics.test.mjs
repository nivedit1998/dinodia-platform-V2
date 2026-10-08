import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function loadTypeScript(relative) {
  const output = ts.transpileModule(readFileSync(path.resolve(relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(require, module, module.exports);
  return module.exports;
}
const { aggregateNativeUsage, aggregateNativeTemperature, parseAnalyticsWindow, retentionStart } = loadTypeScript('src/lib/nativeAnalytics.ts');

function hourlyRows(start, count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => {
    const bucketStart = new Date(Date.parse(start) + index * 3_600_000);
    return { deviceId: 'property-device-a', areaId: 'canonical-area-a', bucketStart,
      closedAt: new Date(bucketStart.getTime() + 3_600_000), onSeconds: 3600, offSeconds: 0, unknownSeconds: 0, ...overrides };
  });
}

test('daily local grouping preserves the real 23-hour and 25-hour Europe/London DST days', () => {
  const spring = aggregateNativeUsage(hourlyRows('2026-03-29T00:00:00.000Z', 23), 'day', 'Europe/London');
  assert.equal(spring.length, 1);
  assert.equal(spring[0].id, '2026-03-29');
  assert.equal(spring[0].start, '2026-03-29T00:00:00.000Z');
  assert.equal(spring[0].end, '2026-03-29T23:00:00.000Z');
  assert.equal(spring[0].coverageSeconds, 23 * 3600);
  assert.equal(spring[0].onMinutes, 1380);

  const autumn = aggregateNativeUsage(hourlyRows('2026-10-24T23:00:00.000Z', 25), 'day', 'Europe/London');
  assert.equal(autumn.length, 1);
  assert.equal(autumn[0].id, '2026-10-25');
  assert.equal(autumn[0].start, '2026-10-24T23:00:00.000Z');
  assert.equal(autumn[0].end, '2026-10-26T00:00:00.000Z');
  assert.equal(autumn[0].coverageSeconds, 25 * 3600);
  assert.equal(autumn[0].onMinutes, 1500);
});

test('larger usage buckets average device-local-day samples, hourly buckets sum devices, and gaps stay absent', () => {
  const rows = [
    ...hourlyRows('2026-10-05T10:00:00.000Z', 1),
    ...hourlyRows('2026-10-05T10:00:00.000Z', 1, { deviceId: 'property-device-b', onSeconds: 0, offSeconds: 1800, unknownSeconds: 1800 }),
  ];
  const hourly = aggregateNativeUsage(rows, 'hour', 'Europe/London');
  assert.equal(hourly.length, 1);
  assert.equal(hourly[0].onMinutes, 60);
  assert.equal(hourly[0].offMinutes, 30);
  assert.equal(hourly[0].unknownMinutes, 30);
  assert.equal(hourly[0].contributingDeviceDays, 2);

  const daily = aggregateNativeUsage(rows, 'day', 'Europe/London');
  assert.equal(daily.length, 1);
  assert.equal(daily[0].onMinutes, 30);
  assert.equal(daily[0].offMinutes, 15);
  assert.equal(daily[0].unknownMinutes, 15);
  assert.deepEqual(aggregateNativeUsage([], 'day', 'Europe/London'), []);
});

test('temperature aggregation keeps point timestamps and reports current freshness without fabricating samples', () => {
  const rows = [{ deviceId: 'radiator-a', areaId: 'area-a', sourceObservedAt: '2026-10-08T10:00:00.000Z',
    validUntil: '2026-10-08T10:20:00.000Z', temperature: '20.25' }];
  const data = aggregateNativeTemperature(rows, 'hour', 'Europe/London', new Date('2026-10-08T10:10:00.000Z'));
  assert.equal(data.length, 1);
  assert.equal(data[0].celsius, 20.25);
  assert.equal(data[0].currentFresh, true);
  assert.equal(aggregateNativeTemperature(rows, 'hour', 'Europe/London', new Date('2026-10-08T10:20:00.000Z'))[0].currentFresh, false);
  assert.equal(aggregateNativeTemperature([], 'hour', 'Europe/London', new Date()).length, 0);
});

test('analytics request windows are canonical, bounded to retained data, and use a calendar-year cutoff', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  assert.equal(retentionStart(now).toISOString(), '2025-10-08T12:00:00.000Z');
  assert.deepEqual(parseAnalyticsWindow({ from: '2025-10-08T12:00:00.000Z', to: '2026-10-08T12:00:00.000Z' }, now), {
    from: new Date('2025-10-08T12:00:00.000Z'), to: now, retentionStart: new Date('2025-10-08T12:00:00.000Z'),
  });
  assert.throws(() => parseAnalyticsWindow({ from: '2025-10-07T12:00:00.000Z', to: '2026-10-08T12:00:00.000Z' }, now), /retained history/);
  assert.throws(() => parseAnalyticsWindow({ from: '2026-10-08T12:00:00Z' }, now), /valid analytics window/);
  assert.throws(() => aggregateNativeUsage([], 'day', 'not-a-timezone'), /Invalid analytics period/);
});
