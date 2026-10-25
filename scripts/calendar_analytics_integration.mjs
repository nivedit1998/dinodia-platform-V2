import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
const require = createRequire(import.meta.url), ts = require('typescript');

export async function calendarAnalyticsDatabaseChecks({ prisma, fixture: f, osRoot, databaseUrl, base, machineRequest, fetchJson }) {
  const url = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback database only');
  // Isolate the calendar matrix from earlier disposable analytics fixtures;
  // authentication/authority fixtures and their tested membership paths remain.
  await prisma.nativeDeviceUsageBucket.deleteMany({ where: { homeId: f.homeOneId } });
  await prisma.nativeTemperatureSample.deleteMany({ where: { homeId: f.homeOneId } });
  await prisma.nativeAnalyticsUnallocated.deleteMany({ where: { homeId: f.homeOneId } });
  const cache = new Map();
  function load(name) {
    const file = path.resolve('src/lib', name + '.ts');
    if (cache.has(file)) return cache.get(file);
    const loaded = { exports: {} }; cache.set(file, loaded.exports);
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', js)(id => id === './prisma' ? { prisma }
      : id === './stage1Auth' ? { Stage1AuthError: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } } }
      : id.startsWith('.') ? load(path.relative(path.resolve('src/lib'), path.resolve(path.dirname(file), id))) : require(id), loaded, loaded.exports);
    cache.set(file, loaded.exports); return loaded.exports;
  }
  const { historyDay, historyWeek } = load('analyticsHistoryCalendar');
  const { backfillLegacyDay, compactDailyHistory, maintainDailyAnalytics } = load('dailyAnalyticsMaintenance');
  const daily = require(path.join(osRoot, 'src/sync/dailyAnalytics.js'));
  const now = new Date(), week = historyWeek(now.getTime(), 'Europe/London');
  const legacyDay = historyDay(week.start - 1, 'Europe/London');
  const writerFrom = new Date(Math.floor(now.getTime() / 3600000) * 3600000 - 3600000);
  const oldStart = Math.ceil((legacyDay.start + 3600000) / 3600000) * 3600000;
  const osDeviceId = `calendar-light-${randomUUID()}`, controlId = 'power';
  const device = await prisma.nativeDevice.create({ data: { homeId: f.homeOneId, hubInstallationId: f.hubOneId,
    osDeviceId, originalName: 'Disposable calendar light', technicalLabel: 'property_device', managementClass: 'PROPERTY_DEVICE',
    analyticsCategory: 'LIGHT', deviceType: 'light', protocol: 'zigbee', lifecycle: 'INSTALLED', descriptorRevision: 1,
    capabilitySummary: { controlCatalog: { revision: 1, controls: [{ controlId, semanticRole: 'power', observable: true, writable: true, surfaceId: 'light' }] } } } });
  await prisma.deviceAreaAssignment.create({ data: { homeId: f.homeOneId, deviceId: device.id, areaId: f.areaOneId,
    source: 'DISPOSABLE_CALENDAR_TEST', validFrom: new Date(legacyDay.start - 86400000) } });
  await prisma.home.update({ where: { id: f.homeOneId }, data: { timezone: 'Europe/London' } });
  await prisma.hubInstallation.update({ where: { id: f.hubOneId }, data: { analyticsWriterEnabled: true } });
  await prisma.nativeAnalyticsRetention.create({ data: { homeId: f.homeOneId, hubInstallationId: f.hubOneId,
    timezone: 'Europe/London', writerFrom, writerEnabled: true } });

  async function signed(events) {
    const cursor = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: f.hubOneId } });
    const from = Number(cursor.syncAcceptedSequence) + 1;
    const envelope = { schemaVersion: 1, hubInstallationId: f.hubOneId, streamId: String(cursor.syncStreamId),
      fromSequence: from, toSequence: from + events.length - 1,
      events: events.map((e, i) => ({ id: randomUUID(), sequence: from + i, occurredAt: new Date().toISOString(), critical: false, ...e })),
      queueDepth: events.length, acknowledgedCloudRevision: Number(cursor.acknowledgedCloudRevision),
      runtime: { kind: 'dinodia_os', version: 'calendar-integration', capabilities: { nativeDailyAnalyticsV1: true } }, sentAt: new Date().toISOString() };
    const submit = () => machineRequest({ base, path: '/api/hub-agent/v2/sync', machineSecret: f.machineSecret,
      body: { serial: f.identityOneSerial, identityGeneration: f.identityOneGeneration, ...envelope } });
    const response = await submit();
    assert.equal(response.response.status, 200, `signed daily upload: ${JSON.stringify(response.body)}`);
    const duplicate = await submit();
    assert.equal(duplicate.response.status, 200, 'exact authenticated retry is idempotent');
    return envelope;
  }
  const legacy = { type: 'usage.bucket', aggregateId: createHash('sha256').update([osDeviceId, f.areaOneOsId, 'LIGHT', controlId, f.identityOneGeneration, oldStart].join('|')).digest('hex'), payload: { osDeviceId, osAreaId: f.areaOneOsId,
    analyticsCategory: 'LIGHT', controlId, sourceGeneration: f.identityOneGeneration, bucketStart: new Date(oldStart).toISOString(),
    coverageStartAt: new Date(oldStart).toISOString(), coverageEndAt: new Date(oldStart + 3600000).toISOString(),
    revision: 1, onSeconds: 3600, offSeconds: 0, unknownSeconds: 0, closedAt: new Date(oldStart + 3600000).toISOString(),
    purgeAt: new Date(new Date(oldStart).setUTCFullYear(new Date(oldStart).getUTCFullYear() + 1)).toISOString() } };
  await signed([legacy]);
  assert.equal(await prisma.nativeDeviceUsageBucket.count({ where: { deviceId: device.id } }), 1);
  await signed([{ type: 'analytics.daily.barrier', aggregateId: writerFrom.toISOString(), critical: true,
    payload: { version: 1, writerFrom: writerFrom.toISOString(), timezone: 'Europe/London' } }]);
  const state = {};
  daily.initialize(state, { version: 1, enabled: true, writerFrom: writerFrom.toISOString(), timezone: 'Europe/London' });
  const source = { osDeviceId, osAreaId: f.areaOneOsId, category: 'LIGHT', controlId, sourceGeneration: f.identityOneGeneration,
    bindingRevision: 0, analyticsIntervalId: null, analyticsPolicyVersion: 1 };
  daily.recordUsageInterval(state, source, writerFrom.getTime(), writerFrom.getTime() + 600000, 'on');
  const event = () => { const e = daily.dailyEvents(state)[0]; return { type: 'analytics.day', aggregateId: e.aggregateId, payload: e.payload }; };
  await signed([event()]);
  daily.recordUsageInterval(state, source, writerFrom.getTime() + 600000, writerFrom.getTime() + 900000, 'off');
  await signed([event()]);
  const accepted = await prisma.nativeAnalyticsDay.findFirstOrThrow({ where: { deviceId: device.id, origin: 'HUB' } });
  assert.equal(accepted.onSeconds, 600); assert.equal(accepted.offSeconds, 300);
  let complete = false;
  for (let i = 0; i < 20; i++) {
    const result = await prisma.$transaction(tx => backfillLegacyDay(tx, f.hubOneId, now), { timeout: 20000 });
    if (result.completed) { complete = true; break; }
  }
  assert.equal(complete, true, 'bounded legacy backfill reaches the immutable writer boundary');
  const historical = await prisma.nativeAnalyticsDay.findFirstOrThrow({ where: { deviceId: device.id, origin: 'LEGACY' } });
  assert.equal(historical.onSeconds, 3600); assert.ok(historical.verifiedAt);
  await assert.rejects(prisma.$transaction(tx => compactDailyHistory(tx, f.hubOneId, now)), /daily_compaction_not_verified/);
  await prisma.nativeAnalyticsRetention.update({ where: { hubInstallationId: f.hubOneId }, data: { readsEnabled: true, pruningEnabled: true } });
  await prisma.nativeAnalyticsDay.update({ where: { id: historical.id }, data: {
    coverageStartAt: new Date(historical.coverageStartAt.getTime() + 1000),
    coverageEndAt: new Date(historical.coverageEndAt.getTime() + 1000),
    assignmentEpochAt: new Date(historical.assignmentEpochAt.getTime() + 1000) } });
  const mismatch = await prisma.$transaction(tx => compactDailyHistory(tx, f.hubOneId, now), { timeout: 20000 });
  assert.equal(mismatch.retained, true, 'identical counters with wrong temporal attribution must preserve source evidence');
  assert.equal(await prisma.nativeDeviceUsageBucket.count({ where: { deviceId: device.id } }), 1);
  await prisma.nativeAnalyticsDay.update({ where: { id: historical.id }, data: {
    coverageStartAt: historical.coverageStartAt, coverageEndAt: historical.coverageEndAt, assignmentEpochAt: historical.assignmentEpochAt } });
  const compacted = await prisma.$transaction(tx => compactDailyHistory(tx, f.hubOneId, now, { retryRetained: true }), { timeout: 20000 });
  assert.equal(compacted.usageDeleted, 1);
  assert.equal(await prisma.nativeDeviceUsageBucket.count({ where: { deviceId: device.id } }), 0);
  assert.equal((await prisma.nativeAnalyticsDay.findUniqueOrThrow({ where: { id: historical.id } })).onSeconds, 3600);
  await signed([{ ...legacy, payload: { ...legacy.payload, revision: 2 } }]);
  assert.equal(await prisma.nativeDeviceUsageBucket.count({ where: { deviceId: device.id } }), 0, 'sealed late evidence cannot resurrect pruned detail');
  assert.equal(await prisma.nativeAnalyticsUnallocated.count({ where: { deviceId: device.id, reason: 'sealed_legacy_late_evidence' } }), 1);

  const owner = await fetchJson(`${base}/api/v2/mobile/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    email: f.propertyEmail, password: f.propertyPassword, deviceInstallationId: f.propertyInstallationId,
    publicKey: f.propertyPublicKey, deviceName: 'Disposable calendar owner', model: 'test', osFamily: 'test', osVersion: 'test' }) });
  assert.equal(owner.response.status, 200);
  const headers = { authorization: `Bearer ${owner.body.accessToken}`, 'x-dinodia-home-id': f.homeOneId };
  const query = new URLSearchParams({ metric: 'light', level: 'day', from: new Date(legacyDay.start).toISOString(), to: new Date(legacyDay.end).toISOString(), deviceIds: device.id });
  const chart = await fetchJson(`${base}/api/v2/homes/${f.homeOneId}/analytics/usage?${query}`, { headers });
  assert.equal(chart.response.status, 200, JSON.stringify(chart.body));
  assert.equal(chart.body.buckets[0].onMinutes, 60);
  query.set('level', 'hour');
  const unavailable = await fetchJson(`${base}/api/v2/homes/${f.homeOneId}/analytics/usage?${query}`, { headers });
  assert.equal(unavailable.response.status, 409, 'older hourly request is explicit, never an empty or fabricated-zero chart');
  const denied = await fetchJson(`${base}/api/v2/homes/${f.homeTwoId}/analytics/usage?${query}`, { headers });
  assert.ok([403, 404].includes(denied.response.status), 'current membership authority remains enforced');
  const radiatorOsId = `calendar-radiator-${randomUUID()}`;
  const radiator = await prisma.nativeDevice.create({ data: { homeId: f.homeOneId, hubInstallationId: f.hubOneId,
    osDeviceId: radiatorOsId, originalName: 'Disposable calendar temperature', technicalLabel: 'property_device',
    managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR', deviceType: 'thermostat', protocol: 'zigbee',
    lifecycle: 'INSTALLED', descriptorRevision: 1, capabilitySummary: { controlCatalog: { revision: 1, controls: [
      { controlId: 'ambient', semanticRole: 'ambient_temperature', observable: true, writable: false, valueType: 'number' }] } } } });
  await prisma.deviceAreaAssignment.create({ data: { homeId: f.homeOneId, deviceId: radiator.id, areaId: f.areaOneId,
    source: 'DISPOSABLE_CALENDAR_TEST', validFrom: new Date(legacyDay.start - 86400000) } });
  const thermal = {};
  daily.initialize(thermal, { version: 1, enabled: true, writerFrom: writerFrom.toISOString(), timezone: 'Europe/London' });
  const observed = writerFrom.getTime();
  const temperatureSource = { ...source, osDeviceId: radiatorOsId, category: 'RADIATOR', controlId: 'ambient' };
  daily.observeTemperature(thermal, { ...temperatureSource, observedAt: new Date(observed - 300000).toISOString(),
    validUntil: new Date(observed + 600000).toISOString(), value: 20 }, observed + 600000);
  const temperatureEvent = () => { const e = daily.dailyEvents(thermal).find(e => e.payload.kind === 'TEMPERATURE');
    assert.ok(e); return { type: 'analytics.day', aggregateId: e.aggregateId, payload: e.payload }; };
  await signed([temperatureEvent()]);
  let thermalRow = await prisma.nativeAnalyticsDay.findFirstOrThrow({ where: { deviceId: radiator.id, origin: 'HUB' } });
  assert.equal(Number(thermalRow.knownMilliseconds), 600000);
  assert.equal(Number(thermalRow.celsiusMilliseconds), 12000000);
  const thermalDay = historyDay(observed, 'Europe/London');
  const thermalQuery = new URLSearchParams({ level: 'day', from: new Date(thermalDay.start).toISOString(),
    to: new Date(Math.min(now.getTime(), thermalDay.end)).toISOString(), deviceIds: radiator.id });
  const temperatureChart = await fetchJson(`${base}/api/v2/homes/${f.homeOneId}/analytics/temperature?${thermalQuery}`,
    { headers: { ...headers, 'X-Dinodia-Analytics-History-Version': '1' } });
  assert.equal(temperatureChart.response.status, 200, JSON.stringify(temperatureChart.body));
  assert.ok(temperatureChart.body.points.some(point => point.celsius === 20
    && point.averageSemantics === 'duration_weighted_device_readings' && point.coverageBasis === 'device_time'));
  const oldTemperatureClient = await fetchJson(`${base}/api/v2/homes/${f.homeOneId}/analytics/temperature?${thermalQuery}`, { headers });
  assert.equal(oldTemperatureClient.response.status, 409, 'old clients must not silently interpret compact means as continuous measurements');
  // A newly received genuine report without a currentness guarantee ends the
  // provisionally integrated predecessor, including the all-zero correction.
  daily.observeTemperature(thermal, { ...temperatureSource, observedAt: writerFrom.toISOString(),
    validUntil: writerFrom.toISOString(), value: 24 }, observed + 600000);
  await signed([temperatureEvent()]);
  thermalRow = await prisma.nativeAnalyticsDay.findUniqueOrThrow({ where: { id: thermalRow.id } });
  assert.equal(Number(thermalRow.knownMilliseconds), 0);
  assert.equal(Number(thermalRow.celsiusMilliseconds), 0);
  assert.equal(thermalRow.lastCelsius, null);
  daily.observeTemperature(thermal, { ...temperatureSource, observedAt: new Date(observed + 60000).toISOString(),
    validUntil: new Date(observed + 660000).toISOString(), value: 22 }, observed + 360000);
  await signed([temperatureEvent()]);
  daily.observeTemperature(thermal, { ...temperatureSource, observedAt: new Date(observed + 180000).toISOString(),
    validUntil: new Date(observed + 180000).toISOString(), value: 24 }, observed + 360000);
  await signed([temperatureEvent()]);
  thermalRow = await prisma.nativeAnalyticsDay.findUniqueOrThrow({ where: { id: thermalRow.id } });
  assert.equal(Number(thermalRow.knownMilliseconds), 120000);
  assert.equal(thermalRow.coverageEndAt.getTime(), observed + 180000, 'a newer absolute temperature correction can retract the end of coverage');
  // Real SQL guards protect even a direct writer, independently of the HTTP checks.
  await assert.rejects(prisma.nativeAnalyticsDay.create({ data: { ...historical, id: randomUUID(),
    deviceId: f.tenantDeviceId, assignmentEpochAt: new Date(historical.assignmentEpochAt.getTime() + 1) } }));
  const expiredDay = historyDay(now.getTime() - 400 * 86400000, 'Europe/London');
  const expired = await prisma.nativeAnalyticsDay.create({ data: { ...historical, id: randomUUID(),
    dayStartAt: new Date(expiredDay.start), dayEndAt: new Date(expiredDay.end), assignmentEpochAt: new Date(expiredDay.start),
    coverageStartAt: new Date(expiredDay.start), coverageEndAt: new Date(expiredDay.start + 3600000),
    closedAt: new Date(expiredDay.end), purgeAt: new Date(expiredDay.end) } });
  const priorFlag = process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;
  process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = 'true';
  let maintenance;
  try { maintenance = await maintainDailyAnalytics(prisma, now); } finally {
    if (priorFlag === undefined) delete process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED;
    else process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED = priorFlag;
  }
  assert.equal(maintenance.enabled, true);
  assert.equal(await prisma.nativeAnalyticsDay.count({ where: { id: expired.id } }), 0, 'the existing bounded scheduler also expires daily summaries after twelve calendar months');
  console.log('[calendar:integration] PASS authenticated Hub usage/temperature uploads/retry/replacement/zero correction, SQL guards, resumable verified backfill, guarded compaction, late evidence quarantine, authorized daily APIs and old-client/hourly boundaries');
}
