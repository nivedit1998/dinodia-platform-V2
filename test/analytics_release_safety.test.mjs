import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
class AuthError extends Error { constructor(status, code, message = code) { super(message); this.status = status; this.code = code; } }
function load(name) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(`src/lib/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const local = id => id === './stage1Auth' ? { Stage1AuthError: AuthError } : id === './hubSyncEnvelope'
    ? { canonicalSyncJson: JSON.stringify } : id === './analyticsIntervals' ? load('analyticsIntervals')
    : id === './stage1Crypto' ? { sha256: value => require('node:crypto').createHash('sha256').update(value).digest('hex') }
    : id === './hubCloudConfiguration' ? { buildHubCloudConfiguration: async () => ({ checksum: 'fixture' }),
      finalizeHubCloudConfiguration: (candidate, revision) => ({ ...candidate, revision }) }
    : id.startsWith('.') ? {} : require(id);
  new Function('require', 'module', 'exports', code)(local, module, module.exports);
  return module.exports;
}

test('RB2 overlapping legacy device-hour is omitted without losing other devices or hours', () => {
  const { aggregateNativeUsage } = load('nativeAnalytics');
  const row = { deviceId: 'a', areaId: 'area', bucketStart: '2026-10-23T10:00:00Z', closedAt: null,
    coverageStartAt: '2026-10-23T10:00:00Z', coverageEndAt: '2026-10-23T10:10:00Z', onSeconds: 600, offSeconds: 0, unknownSeconds: 0 };
  const result = aggregateNativeUsage([row, { ...row }, { ...row, deviceId: 'b' }], 'hour', 'UTC');
  assert.equal(result[0].onMinutes, 10);
  assert.equal(result[0].coverageSeconds, 600);
  assert.equal(result[0].contributingDeviceDays, 1);
  assert.equal(result[0].isPartial, true);
  assert.deepEqual(aggregateNativeUsage([row, row], 'hour', 'UTC'), []);
});

test('RB3 activation is scoped, audited, CAS guarded and an exact retry does not change revision', async () => {
  const { setAnalyticsActivation } = load('analyticsActivation');
  const now = new Date('2026-10-23T12:00:00Z'), events = [], records = new Map();
  const hub = { id: 'hub', cloudConfigurationRevision: 3, analyticsWriterEnabled: false, analyticsCollectionEnabled: false,
    manufacturingIdentity: { identityGeneration: 1 }, capabilitySummary: { nativeUniversalAnalyticsV2: true } };
  const tx = { $queryRaw: async () => [], hubInstallation: { findFirst: async ({ where }) => where.id === 'hub' && where.homeId === 'home' ? { ...hub } : null,
    update: async ({ data }) => Object.assign(hub, data) }, nativeDevice: { findMany: async () => [] },
    home: { update: async () => events.push('home_revision') }, auditEvent: { create: async ({ data }) => events.push(data) },
    idempotencyRecord: { findUnique: async ({ where }) => records.get(where.namespace_keyHash.keyHash),
      create: async ({ data }) => records.set(data.keyHash, data) } };
  const actor = { id: 'employee', role: 'CXO', expiresAt: now.getTime() + 60000, recentAuthenticatedAt: now.getTime() };
  const input = { homeId: 'home', hubInstallationId: 'hub', operationId: 'operation', expectedCloudRevision: 3,
    expectedWriterEnabled: false, expectedCollectionEnabled: false, writerEnabled: true, collectionEnabled: false };
  await assert.rejects(setAnalyticsActivation(tx, { ...actor, role: 'INSTALLER' }, input, now), /analytics_activation_authority/);
  await assert.rejects(setAnalyticsActivation(tx, actor, { ...input, homeId: 'other' }, now), /analytics_installation_unavailable/);
  await assert.rejects(setAnalyticsActivation(tx, actor, { ...input, expectedCloudRevision: 2 }, now), /revision_conflict/);
  const enabled = await setAnalyticsActivation(tx, actor, input, now);
  assert.equal(enabled.cloudRevision, 4); assert.equal(enabled.acknowledged, false);
  assert.deepEqual(await setAnalyticsActivation(tx, actor, input, now), enabled);
  assert.equal(events.filter(value => value.action === 'analytics_installation_activation_changed').length, 1);
  const disabled = await setAnalyticsActivation(tx, actor, { ...input, operationId: 'disable', expectedCloudRevision: 4,
    expectedWriterEnabled: true, writerEnabled: false }, now);
  assert.equal(disabled.writerEnabled, false); assert.equal(disabled.cloudRevision, 5);
});

test('RB1 queued old generation v2 evidence is preserved without rejecting the signed stream', async () => {
  const { applyHubSyncEvent } = load('hubSyncIngestion');
  const statements = [], evidence = [];
  const device = { id: 'device', homeId: 'home', managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED' };
  const tx = { $executeRawUnsafe: async sql => statements.push(sql),
    nativeDevice: { findUnique: async () => device }, area: { findUnique: async () => ({ id: 'area' }) },
    nativeAnalyticsUnallocated: { findUnique: async () => null, create: async ({ data }) => evidence.push(data) } };
  await applyHubSyncEvent(tx, { homeId: 'home', hubInstallationId: 'hub', identityGeneration: 2,
    now: new Date('2026-10-23T11:00:00Z'), event: { id: 'event', type: 'usage.bucket', payload: {
      osDeviceId: 'dev', osAreaId: 'a', analyticsCategory: 'RADIATOR', analyticsIntervalId: 'interval', sourceGeneration: 1,
      coverageStartAt: '2026-10-23T10:00:00Z', coverageEndAt: '2026-10-23T10:10:00Z', purgeAt: '2027-10-23T10:00:00Z' } } });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].reason, 'hub_sync_usage_generation_invalid');
  assert.ok(statements.includes('ROLLBACK TO SAVEPOINT analytics_usage_event'));
  assert.ok(statements.includes('RELEASE SAVEPOINT analytics_usage_event'));
});

test('checked temperature evidence ends at trusted OFFLINE and cannot revive on ONLINE without a new sample', async () => {
  const { applyHubSyncEvent } = load('hubSyncIngestion');
  const clipped = [];
  const device = { id: 'device', homeId: 'home', managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED',
    descriptorRevision: 4, descriptorDigest: 'a'.repeat(64), protocol: 'zigbee', originalName: 'Radiator',
    capabilitySummary: {}, assignments: [{ id: 'assignment', areaId: 'area', validFrom: new Date('2026-10-24T10:00:00Z') }] };
  const tx = {
    nativeDevice: { findUnique: async () => device, update: async () => ({}) },
    area: { findUnique: async () => ({ id: 'area', status: 'ACTIVE' }) },
    nativeAutomation: {}, deviceAreaAssignment: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), create: async () => ({}) },
    nativeTemperatureSample: { updateMany: async args => { clipped.push(args); return { count: 1 }; } },
  };
  const event = (available, occurredAt) => ({ id: `event-${available}`, type: 'device.upsert', occurredAt, payload: {
    osDeviceId: 'os-device', name: 'Radiator', areaId: 'os-area', protocol: 'zigbee', deviceType: 'radiator',
    technicalLabel: 'radiator', descriptorRevision: 4, descriptorDigest: 'a'.repeat(64), available, observedAt: occurredAt,
  } });
  await applyHubSyncEvent(tx, { homeId: 'home', hubInstallationId: 'hub', identityGeneration: 1,
    now: new Date('2026-10-24T10:20:00Z'), event: event(false, '2026-10-24T10:10:00Z') });
  assert.equal(clipped.length, 1, 'trusted offline must durably end prior checked sample validity');
  assert.deepEqual(clipped[0].where, { deviceId: 'device', analyticsPolicyVersion: 3,
    sourceObservedAt: { lt: new Date('2026-10-24T10:10:00Z') }, validUntil: { gt: new Date('2026-10-24T10:10:00Z') },
    OR: [{ currentnessEndedAt: null }, { currentnessEndedAt: { gt: new Date('2026-10-24T10:10:00Z') } }] });
  assert.deepEqual(clipped[0].data, { currentnessEndedAt: new Date('2026-10-24T10:10:00Z') });
  await applyHubSyncEvent(tx, { homeId: 'home', hubInstallationId: 'hub', identityGeneration: 1,
    now: new Date('2026-10-24T10:20:00Z'), event: event(true, '2026-10-24T10:15:00Z') });
  assert.equal(clipped.length, 1, 'online without a new observation cannot extend or revive the clipped sample');
});

test('temperature observation replay after OFFLINE clipping is idempotent but changed sample data conflicts', async () => {
  const { applyHubSyncEvent } = load('hubSyncIngestion');
  const sourceObservedAt = new Date('2026-10-24T10:00:00Z');
  const originalValidUntil = new Date('2026-10-24T11:00:00Z');
  const sourceGeneration = 1;
  const controlId = 'temperature';
  const osDeviceId = 'os-device';
  const sourceEventKey = require('node:crypto').createHash('sha256').update([
    osDeviceId, controlId, String(sourceGeneration), sourceObservedAt.toISOString(),
  ].join('\n'), 'utf8').digest('hex');
  const device = { id: 'device', homeId: 'home', managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR',
    lifecycle: 'INSTALLED', descriptorRevision: 4, radiatorReadingAt: sourceObservedAt,
    capabilitySummary: { controlCatalog: { revision: 4, controls: [{ controlId, semanticRole: 'ambient_temperature',
      valueType: 'number', observable: true, maxStateValiditySeconds: 3600 }] } } };
  const alreadyOfflineClipped = { id: 'sample', homeId: 'home', deviceId: 'device', temperature: 21.25,
    sourceObservedAt, validUntil: originalValidUntil, currentnessEndedAt: new Date('2026-10-24T10:10:00Z') };
  const tx = { nativeDevice: { findUnique: async () => device, update: async () => ({}) },
    nativeTemperatureSample: { findUnique: async () => alreadyOfflineClipped } };
  const applyReplay = (temperature) => applyHubSyncEvent(tx, { homeId: 'home', hubInstallationId: 'hub', identityGeneration: 1,
    now: new Date('2026-10-24T10:20:00Z'), event: { id: 'temperature-replay', type: 'temperature.sample', aggregateId: sourceEventKey,
      payload: { osDeviceId, controlId, sourceGeneration, sourceEventKey, temperature, sourceObservedAt: sourceObservedAt.toISOString(),
        validUntil: originalValidUntil.toISOString(), quality: 'fresh', analyticsPolicyVersion: 3 } } });
  await applyReplay(21.25);
  await assert.rejects(applyReplay(22.0), error => error.code === 'hub_sync_temperature_key_conflict');
});

for (const dbError of [
  { code: 'P2010', meta: { code: '23514', message: 'physical-device usage coverage cannot overlap' } },
  { code: 'P2004', meta: { database_error: 'physical-device usage coverage cannot overlap' } },
  { name: 'PrismaClientUnknownRequestError', message: 'SqlState(E23514): physical-device usage coverage cannot overlap' },
]) test(`RB1 known PostgreSQL overlap is isolated for ${dbError.code || dbError.name}`, async () => {
  const { applyHubSyncEvent } = load('hubSyncIngestion');
  let reads = 0; const evidence = [];
  const tx = { $executeRawUnsafe: async () => 0,
    nativeDevice: { findUnique: async () => { if (!reads++) throw dbError; return { id: 'device', homeId: 'home', managementClass: 'PROPERTY_DEVICE' }; } },
    area: { findUnique: async () => ({ id: 'area' }) },
    nativeAnalyticsUnallocated: { findUnique: async () => null, create: async ({ data }) => evidence.push(data) } };
  await applyHubSyncEvent(tx, { homeId: 'home', hubInstallationId: 'hub', identityGeneration: 1,
    now: new Date('2026-10-23T11:00:00Z'), event: { id: 'event', type: 'usage.bucket', payload: {
      osDeviceId: 'dev', osAreaId: 'a', analyticsCategory: 'LIGHT', analyticsIntervalId: 'interval', sourceGeneration: 1,
      coverageStartAt: '2026-10-23T10:00:00Z', coverageEndAt: '2026-10-23T10:10:00Z', purgeAt: '2027-10-23T10:00:00Z' } } });
  assert.equal(evidence[0].reason, 'analytics_constraint_unallocated');
});

test('RB1 unrelated database failures remain retryable failures, never acknowledged as evidence', async () => {
  const { applyHubSyncEvent } = load('hubSyncIngestion');
  const outage = Object.assign(new Error('Synthetic database unavailable'), { code: 'P1001' });
  const tx = { $executeRawUnsafe: async () => 0, nativeDevice: { findUnique: async () => { throw outage; } } };
  await assert.rejects(applyHubSyncEvent(tx, { homeId: 'home', hubInstallationId: 'hub', identityGeneration: 1,
    now: new Date(), event: { id: 'event', type: 'usage.bucket', payload: { osDeviceId: 'dev' } } }), error => error === outage);
});
