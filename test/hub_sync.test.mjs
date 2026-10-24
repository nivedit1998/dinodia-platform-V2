import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
function loadTypeScript(relative) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const output = ts.transpileModule(read(relative), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(require, module, module.exports);
  return module.exports;
}

const { canReconcileHubSyncStream, isInstallationBootstrapEvent, validateHubSyncEnvelope } = loadTypeScript('src/lib/hubSyncEnvelope.ts');
const { parseHubSyncOutboxReport, parseCloudflareTunnelStatus, currentCloudflareTunnelStatus } = loadTypeScript('src/lib/hubSyncTelemetry.ts');
const { resolveNativeInstallationSyncMode } = loadTypeScript('src/lib/nativeInstallationSyncMode.ts');

test('installation sync mode permits current active sync or narrowly bounded ownerless/installer bootstrap', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const base = {
    hubId: '11111111-1111-4111-8111-111111111111', hubState: 'PROVISIONED', hubLifecycleStatus: 'PENDING',
    cloudUrlVerifiedAt: new Date(now.getTime() - 1000), remoteVerificationAt: new Date(now.getTime() - 1000),
    homeId: '22222222-2222-4222-8222-222222222222', homeLifecycle: 'INSTALLING', installationStatus: 'IN_PROGRESS',
    activeHubInstallationId: null, openAssignedInstallationWorkCount: 1, activeMembershipCount: 0, now,
  };
  assert.equal(resolveNativeInstallationSyncMode(base), 'INSTALLATION_BOOTSTRAP');
  assert.equal(resolveNativeInstallationSyncMode({ ...base, activeMembershipCount: 1 }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...base, openAssignedInstallationWorkCount: 0 }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...base, cloudUrlVerifiedAt: null }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...base, remoteVerificationAt: new Date(now.getTime() + 1) }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...base, homeLifecycle: 'ACTIVE' }), 'UNAVAILABLE');
  const active = { ...base, hubLifecycleStatus: 'ACTIVE', hubState: 'ACTIVE', installationStatus: 'COMPLETE', homeLifecycle: 'PENDING_INSTALLATION', activeHubInstallationId: base.hubId };
  assert.equal(resolveNativeInstallationSyncMode(active), 'ACTIVE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'ACTIVE' }), 'ACTIVE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'CLAIMABLE' }), 'INSTALLATION_BOOTSTRAP', 'a completed ownerless Home may refresh signed liveness, but not receive full tenant sync');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'CLAIM_RESERVED' }), 'INSTALLATION_BOOTSTRAP', 'a reserved initial-owner claim remains ownerless until activation');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'CLAIMABLE', activeMembershipCount: 1 }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'CLAIM_RESERVED', activeMembershipCount: 1 }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'CLAIMABLE', activeHubInstallationId: null }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'CLAIMABLE', installationStatus: 'IN_PROGRESS' }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'CLAIMABLE', cloudUrlVerifiedAt: null }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, installationStatus: 'IN_PROGRESS' }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, homeLifecycle: 'RETIRED' }), 'UNAVAILABLE');
  assert.equal(resolveNativeInstallationSyncMode({ ...active, hubState: 'REVOKED' }), 'UNAVAILABLE');
});

function envelope() {
  return {
    schemaVersion: 1,
    hubInstallationId: '11111111-1111-4111-8111-111111111111',
    streamId: '22222222-2222-4222-8222-222222222222',
    fromSequence: 1,
    toSequence: 1,
    events: [{
      id: '33333333-3333-4333-8333-333333333333', sequence: 1, type: 'area.upsert', aggregateId: 'os-area-1',
      occurredAt: '2026-10-04T12:00:00.000Z', critical: true,
      payload: { osAreaId: 'os-area-1', name: 'Kitchen', icon: 'room' },
    }],
    queueDepth: 1,
    acknowledgedCloudRevision: 0,
    runtime: { kind: 'dinodia_os', version: 'test', capabilities: { syncV2: true } },
    sentAt: '2026-10-04T12:00:00.000Z',
  };
}

test('bootstrap admits only bounded hub-level incidents and rejects device-bound incident authority', () => {
  const safe = { type: 'incident.transition', critical: true, payload: { kind: 'hub_network_unavailable', osDeviceId: null } };
  assert.equal(isInstallationBootstrapEvent(safe), true);
  assert.equal(isInstallationBootstrapEvent({ ...safe, payload: { ...safe.payload, osDeviceId: 'not-yet-commissioned-device' } }), false);
  assert.equal(isInstallationBootstrapEvent({ ...safe, payload: { ...safe.payload, kind: 'device_offline' } }), false);
  assert.equal(isInstallationBootstrapEvent({ ...safe, critical: false }), false);
  assert.equal(isInstallationBootstrapEvent({ type: 'device.upsert', critical: false, payload: {} }), false);
});

test('queue telemetry distinguishes a valid empty report from missing or malformed state', () => {
  assert.equal(parseHubSyncOutboxReport(null), null);
  assert.equal(parseHubSyncOutboxReport({ queueDepth: 0, gapDetected: false, criticalBacklog: false, telemetryPaused: false, droppedTelemetryCount: 0, lastErrorCode: null })?.queueDepth, 0);
  assert.equal(parseHubSyncOutboxReport({ queueDepth: -1, gapDetected: false, criticalBacklog: false, telemetryPaused: false, droppedTelemetryCount: 0, lastErrorCode: null }), null);
  assert.equal(parseHubSyncOutboxReport({ queueDepth: 5, gapDetected: false, criticalBacklog: false, telemetryPaused: false, droppedTelemetryCount: 0, lastErrorCode: 'secret=never' }), null);
  assert.equal(parseHubSyncOutboxReport({ queueDepth: 5, gapDetected: false, criticalBacklog: false, telemetryPaused: false, droppedTelemetryCount: 0, lastErrorCode: null, privateText: 'rejected' }), null);
});

test('tunnel telemetry is bounded, secret-free and scoped to the current hub identity', () => {
  const current = {
    schemaVersion: 1, recoveryState: 'RECONNECTING', childRunning: true,
    originState: 'HEALTHY', edgeState: 'DISCONNECTED', activeConnections: 0,
    sampledAt: '2026-10-11T12:00:00.000Z', validUntil: '2026-10-11T12:07:00.000Z', identityGeneration: 4,
  };
  assert.deepEqual(parseCloudflareTunnelStatus(current), current);
  assert.equal(parseCloudflareTunnelStatus({ ...current, reservationToken: 'must-not-pass' }), null);
  assert.equal(parseCloudflareTunnelStatus({ ...current, validUntil: '2026-10-11T12:30:00.000Z' }), null);
  assert.equal(parseCloudflareTunnelStatus({ ...current, identityGeneration: -1 }), null);
  assert.equal(currentCloudflareTunnelStatus(current, 4, Date.parse('2026-10-11T12:01:00.000Z'))?.recoveryState, 'RECONNECTING');
  assert.equal(currentCloudflareTunnelStatus(current, 5, Date.parse('2026-10-11T12:01:00.000Z')), null, 'a replacement identity cannot inherit old recovery status');
  assert.equal(currentCloudflareTunnelStatus(current, 4, Date.parse('2026-10-11T12:08:00.000Z')), null, 'expired transport state is not current');
  assert.equal(currentCloudflareTunnelStatus({ ...current, recoveryState: 'READY', edgeState: 'DISCONNECTED' }, 4, Date.parse('2026-10-11T12:01:00.000Z')), null, 'contradictory ready state is rejected');
});

test('hub sync accepts a bounded contiguous signed-envelope shape and rejects malformed, stale and contradictory bodies', () => {
  const valid = envelope();
  assert.equal(validateHubSyncEnvelope(valid, JSON.stringify(valid)), true);

  const impossibleDate = structuredClone(valid);
  impossibleDate.events[0].occurredAt = '2026-02-31T10:00:00Z';
  assert.equal(validateHubSyncEnvelope(impossibleDate), false);

  const sequenceGap = structuredClone(valid);
  sequenceGap.events[0].sequence = 2;
  sequenceGap.toSequence = 2;
  assert.equal(validateHubSyncEnvelope(sequenceGap), false);

  const duplicateId = structuredClone(valid);
  duplicateId.events.push({ ...duplicateId.events[0], sequence: 2 });
  duplicateId.toSequence = 2;
  duplicateId.queueDepth = 2;
  assert.equal(validateHubSyncEnvelope(duplicateId), false);

  const conflictingMetadata = structuredClone(valid);
  conflictingMetadata.serial = 'caller-selected-serial';
  assert.equal(validateHubSyncEnvelope(conflictingMetadata), false);

  assert.equal(validateHubSyncEnvelope(valid, 'x'.repeat(1024 * 1024 + 1)), false);
});

test('stream reconciliation is bound to the exact active remote cursor and a complete gap-free local first batch', () => {
  const candidate = envelope();
  candidate.streamId = 'local-stream-00000001';
  candidate.streamReconciliation = { version: 1, previousStreamId: 'remote-stream-accepted-18', previousAcceptedSequence: 18 };
  candidate.runtime.capabilities.nativeSyncOutbox = {
    queueDepth: 1, gapDetected: false, criticalBacklog: false, telemetryPaused: false, droppedTelemetryCount: 0, lastErrorCode: null,
  };
  assert.equal(validateHubSyncEnvelope(candidate), true);
  const active = {
    installationSyncMode: 'ACTIVE', syncStreamId: 'remote-stream-accepted-18', syncAcceptedSequence: 18,
    syncGapDetected: false, syncCriticalBacklog: false, syncTelemetryPaused: false, syncDroppedTelemetryCount: 0,
  };
  assert.equal(canReconcileHubSyncStream(candidate, active), true);
  assert.equal(canReconcileHubSyncStream(candidate, { ...active, syncAcceptedSequence: 19 }), false, 'a stale cursor cannot replace newer server history');
  assert.equal(canReconcileHubSyncStream(candidate, { ...active, installationSyncMode: 'INSTALLATION_BOOTSTRAP' }), false, 'restricted bootstrap cannot reconcile a full Home stream');
  assert.equal(canReconcileHubSyncStream(candidate, { ...active, syncGapDetected: true }), false, 'a known server retention gap remains held');
  assert.equal(canReconcileHubSyncStream({ ...candidate, runtime: { ...candidate.runtime, capabilities: { ...candidate.runtime.capabilities, nativeSyncOutbox: { ...candidate.runtime.capabilities.nativeSyncOutbox, droppedTelemetryCount: 1 } } } }, active), false, 'known local drops cannot be represented as a complete transition');

  const malformed = structuredClone(candidate);
  malformed.streamReconciliation.unreviewed = true;
  assert.equal(validateHubSyncEnvelope(malformed), false, 'unknown reconciliation fields are rejected');
  const wrongStart = structuredClone(candidate);
  wrongStart.fromSequence = 2;
  wrongStart.toSequence = 2;
  wrongStart.events[0].sequence = 2;
  assert.equal(validateHubSyncEnvelope(wrongStart), true);
  assert.equal(canReconcileHubSyncStream(wrongStart, active), false, 'the local stream must be replayed from sequence one');
});

test('configuration refresh is a distinct empty signed envelope and can never carry events', () => {
  const refresh = envelope();
  refresh.events = [];
  refresh.fromSequence = 1;
  refresh.toSequence = 0;
  refresh.queueDepth = 2;
  refresh.configurationRefreshOnly = true;
  assert.equal(validateHubSyncEnvelope(refresh), true);

  const eventBearingRefresh = structuredClone(refresh);
  eventBearingRefresh.events = [envelope().events[0]];
  eventBearingRefresh.toSequence = 1;
  assert.equal(validateHubSyncEnvelope(eventBearingRefresh), false, 'configuration refresh cannot accept or acknowledge an event');

  const falseRefresh = structuredClone(refresh);
  falseRefresh.configurationRefreshOnly = false;
  assert.equal(validateHubSyncEnvelope(falseRefresh), false, 'the optional mode flag is an exact true-only protocol discriminator');
});

test('sync validates redacted incident and manual updater status outcomes without accepting authority-shaped extras', () => {
  const incident = envelope();
  incident.events[0] = {
    id: '33333333-3333-4333-8333-333333333333', sequence: 1, type: 'incident.transition', aggregateId: 'a'.repeat(64),
    occurredAt: '2026-10-04T12:00:00.000Z', critical: true,
    payload: { incidentKey: 'a'.repeat(64), revision: 1, kind: 'device_offline', state: 'open', severity: 'critical', occurredAt: '2026-10-04T12:00:00.000Z', firstObservedAt: '2026-10-04T11:00:00.000Z', lastObservedAt: '2026-10-04T12:00:00.000Z', resolvedAt: null, osDeviceId: null },
  };
  assert.equal(validateHubSyncEnvelope(incident), true);
  const privateLeak = structuredClone(incident);
  privateLeak.events[0].payload.privateDetail = 'tenant-only narrative';
  assert.equal(validateHubSyncEnvelope(privateLeak), false);

  const update = envelope();
  update.events[0] = {
    id: '33333333-3333-4333-8333-333333333333', sequence: 1, type: 'update.status', aggregateId: 'hub-updater',
    occurredAt: '2026-10-04T12:00:00.000Z', critical: true,
    payload: { trustState: 'unprovisioned', phase: 'idle', activeReleaseVersion: null, attemptId: null, releaseId: null, attemptPhase: null, resultCode: null, updatedAt: null, busy: false, revision: 1 },
  };
  assert.equal(validateHubSyncEnvelope(update), true);
  const inventedActive = structuredClone(update);
  inventedActive.events[0].payload.activeReleaseVersion = 'not-installed';
  assert.equal(validateHubSyncEnvelope(inventedActive), true, 'a previously installed version may remain active while update trust is not provisioned');
  const falselyReady = structuredClone(inventedActive);
  falselyReady.events[0].payload.phase = 'active';
  assert.equal(validateHubSyncEnvelope(falselyReady), false, 'unprovisioned update trust cannot report an active update phase');
  const forbiddenMetadata = structuredClone(update);
  forbiddenMetadata.events[0].payload.signingPrivateKey = 'never-accepted';
  assert.equal(validateHubSyncEnvelope(forbiddenMetadata), false);
});

test('sync accepts only a bounded public control catalogue at the current descriptor revision', () => {
  const catalogue = envelope();
  catalogue.events[0] = {
    id: '33333333-3333-4333-8333-333333333333', sequence: 1, type: 'control.catalog.upsert', aggregateId: 'device-1',
    occurredAt: '2026-10-04T12:00:00.000Z', critical: true,
    payload: {
      osDeviceId: 'device-1', catalogRevision: 4, descriptorDigest: 'a'.repeat(64),
      controls: [{
        schemaVersion: 1, deviceId: 'device-1', surfaceId: 'surface-1', controlId: 'control-power', label: 'Power', group: 'Kitchen', sortOrder: 0,
        valueType: 'boolean', interactionKind: 'toggle', semanticRole: 'power', readable: true, writable: true, automatable: true, observable: true,
        idempotency: 'set_value', confirmationPolicy: 'matching_observation', riskLevel: 'normal', stepUpPolicy: 'none',
        expectedReportingIntervalSeconds: 120, maxStateValiditySeconds: 420, unsupportedReason: null, catalogRevision: 4,
      }],
    },
  };
  assert.equal(validateHubSyncEnvelope(catalogue), true);
  const bindingLeak = structuredClone(catalogue);
  bindingLeak.events[0].payload.controls[0].serviceId = 'switch.turn_on';
  assert.equal(validateHubSyncEnvelope(bindingLeak), false);
  const staleRevision = structuredClone(catalogue);
  staleRevision.events[0].payload.controls[0].catalogRevision = 3;
  assert.equal(validateHubSyncEnvelope(staleRevision), false);
  const tombstone = structuredClone(catalogue);
  tombstone.events[0].type = 'control.catalog.tombstone';
  tombstone.events[0].payload = { osDeviceId: 'device-1', catalogRevision: 4, descriptorDigest: 'a'.repeat(64), controlIds: ['control-power'] };
  assert.equal(validateHubSyncEnvelope(tombstone), true);
});

test('usage buckets carry bounded absolute counters, calendar retention and no authority extras', () => {
  const value = envelope();
  const bucket = {
    osDeviceId: 'device-1', osAreaId: 'room-1', analyticsCategory: 'LIGHT', controlId: 'power', sourceGeneration: 2,
    bucketStart: '2026-10-04T12:00:00.000Z', revision: 2, onSeconds: 120, offSeconds: 60, unknownSeconds: 0,
    closedAt: null, purgeAt: '2027-10-04T12:00:00.000Z',
  };
  const aggregateId = createHash('sha256').update([
    bucket.osDeviceId, bucket.osAreaId, bucket.analyticsCategory, bucket.controlId, String(bucket.sourceGeneration),
    String(Date.parse(bucket.bucketStart)),
  ].join('|')).digest('hex');
  value.events[0] = {
    id: '33333333-3333-4333-8333-333333333333', sequence: 1, type: 'usage.bucket', aggregateId,
    occurredAt: '2026-10-04T12:00:00.000Z', critical: false,
    payload: bucket,
  };
  assert.equal(validateHubSyncEnvelope(value), true);
  const counterOverflow = structuredClone(value);
  counterOverflow.events[0].payload.onSeconds = 3601;
  assert.equal(validateHubSyncEnvelope(counterOverflow), false);
  const coveredPartial = structuredClone(value);
  Object.assign(coveredPartial.events[0].payload, {
    coverageStartAt: '2026-10-04T12:00:00.000Z', coverageEndAt: '2026-10-04T12:03:00.000Z',
  });
  assert.equal(validateHubSyncEnvelope(coveredPartial), true);
  const subsecondMismatch = structuredClone(coveredPartial);
  subsecondMismatch.events[0].payload.coverageEndAt = '2026-10-04T12:03:00.001Z';
  assert.equal(validateHubSyncEnvelope(subsecondMismatch), false);
  const criticalTelemetry = structuredClone(value);
  criticalTelemetry.events[0].critical = true;
  assert.equal(validateHubSyncEnvelope(criticalTelemetry), false);
  const extra = structuredClone(value);
  extra.events[0].payload.tenantMembershipId = 'must-not-be-authority';
  assert.equal(validateHubSyncEnvelope(extra), false);

  const leapDay = structuredClone(value);
  leapDay.events[0].payload.bucketStart = '2024-02-29T00:00:00.000Z';
  leapDay.events[0].payload.purgeAt = '2025-02-28T00:00:00.000Z';
  leapDay.events[0].aggregateId = createHash('sha256').update([
    bucket.osDeviceId, bucket.osAreaId, bucket.analyticsCategory, bucket.controlId, String(bucket.sourceGeneration),
    String(Date.parse(leapDay.events[0].payload.bucketStart)),
  ].join('|')).digest('hex');
  assert.equal(validateHubSyncEnvelope(leapDay), true, 'retention uses a calendar-year anniversary clamped at leap day');
  const forgedAggregate = structuredClone(value);
  forgedAggregate.events[0].aggregateId = 'a'.repeat(64);
  assert.equal(validateHubSyncEnvelope(forgedAggregate), false);
});

test('temperature samples retain source freshness and automation outcomes are aggregate-only', () => {
  const temperature = envelope();
  temperature.events[0] = {
    id: '33333333-3333-4333-8333-333333333333', sequence: 1, type: 'temperature.sample', aggregateId: 'b'.repeat(64),
    occurredAt: '2026-10-04T12:00:00.000Z', critical: false,
    payload: {
      osDeviceId: 'device-1', osAreaId: 'room-1', controlId: 'ambient', sourceGeneration: 2,
      sourceEventKey: 'b'.repeat(64), temperature: 20.25, sourceObservedAt: '2026-10-04T11:59:00.000Z',
      validUntil: '2026-10-04T12:20:00.000Z', quality: 'fresh',
    },
  };
  temperature.events[0].payload.sourceEventKey = temperature.events[0].aggregateId;
  assert.equal(validateHubSyncEnvelope(temperature), true);
  const carriedForward = structuredClone(temperature);
  carriedForward.events[0].payload.validUntil = '2026-10-04T12:30:00.001Z';
  assert.equal(validateHubSyncEnvelope(carriedForward), false);
  const limited = structuredClone(temperature);
  limited.events[0].payload.analyticsPolicyVersion = 3;
  limited.events[0].payload.quality = 'unknown';
  limited.events[0].payload.validUntil = limited.events[0].payload.sourceObservedAt;
  assert.equal(validateHubSyncEnvelope(limited), true, 'a real point value is retained without duration coverage');
  limited.events[0].payload.quality = 'fresh';
  assert.equal(validateHubSyncEnvelope(limited), false, 'zero coverage cannot claim fresh');
  limited.events[0].payload.validUntil = '2026-10-04T13:00:00.000Z';
  assert.equal(validateHubSyncEnvelope(limited), true, 'policy3 admits bounded checked hourly coverage');

  const outcome = envelope();
  outcome.events[0] = {
    id: '33333333-3333-4333-8333-333333333333', sequence: 1, type: 'automation.outcome', aggregateId: 'occurrence-1',
    occurredAt: '2026-10-04T12:00:00.000Z', critical: true,
    payload: {
      occurrenceId: 'automation-55555555:3:2026-10-04:12:00', automationId: '55555555-5555-4555-8555-555555555555',
      automationRevision: 3, status: 'partial', startedAt: '2026-10-04T11:59:00.000Z', completedAt: '2026-10-04T12:00:00.000Z',
      actionCount: 2, actionStatuses: { applied: 1, failed: 1, uncertain: 0, skipped: 0 },
    },
  };
  outcome.events[0].aggregateId = outcome.events[0].payload.occurrenceId;
  assert.equal(validateHubSyncEnvelope(outcome), true);
  for (const offsetOccurrenceId of [
    'automation-55555555:3:2026-10-25:01:30:+0100',
    'automation-55555555:3:2026-10-25:01:30:-0100',
  ]) {
    const offsetOutcome = structuredClone(outcome);
    offsetOutcome.events[0].aggregateId = offsetOccurrenceId;
    offsetOutcome.events[0].payload.occurrenceId = offsetOccurrenceId;
    assert.equal(validateHubSyncEnvelope(offsetOutcome), true, `signed DST occurrence offset ${offsetOccurrenceId.slice(-5)} is valid`);
  }
  const leaked = structuredClone(outcome);
  leaked.events[0].payload.actionValue = { private: true };
  assert.equal(validateHubSyncEnvelope(leaked), false);
});

test('the Stage 5 sync endpoint is inventoried as a machine-authenticated Native V2 route', () => {
  const route = read('test/stage1_route_inventory.mjs');
  assert.match(route, /\['POST', '\/api\/hub-agent\/v2\/sync', 'machine'\]/);
  const source = read('src/app/api/hub-agent/v2/sync/route.ts');
  assert.match(source, /authenticateHub\(request, raw, \{ maxBodyBytes: HUB_SYNC_MAX_BODY_BYTES \}\)/);
  assert.match(source, /syncAcceptedSequence/);
  assert.match(source, /applyHubSyncEvent/);
  assert.match(source, /hubSyncReceipt\.create/);
  assert.match(source, /hub_sync_stream_reconciliation_required/);
  assert.match(source, /canReconcileHubSyncStream/);
  assert.match(source, /hub_sync_stream_reconciled/);
});
