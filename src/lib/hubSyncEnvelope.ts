import { createHash } from 'node:crypto';

export const HUB_SYNC_MAX_BODY_BYTES = 1024 * 1024;
export const HUB_SYNC_MAX_BATCH_BYTES = 512 * 1024;
export const HUB_SYNC_MAX_EVENTS = 200;

export type HubSyncEvent = {
  id: string;
  sequence: number;
  type: string;
  aggregateId: string;
  occurredAt: string;
  critical: boolean;
  payload: Record<string, unknown>;
};

export type HubSyncEnvelope = {
  schemaVersion: 1;
  hubInstallationId: string;
  streamId: string;
  fromSequence: number;
  toSequence: number;
  events: HubSyncEvent[];
  queueDepth: number;
  acknowledgedCloudRevision: number;
  configurationRefreshOnly?: true;
  streamReconciliation?: {
    version: 1;
    previousStreamId: string;
    previousAcceptedSequence: number;
  };
  runtime: { kind: 'dinodia_os'; version: string; capabilities: Record<string, unknown> };
  sentAt: string;
};

export type HubSyncStreamState = {
  installationSyncMode: string;
  syncStreamId: string | null;
  syncAcceptedSequence: number;
  syncGapDetected: boolean;
  syncCriticalBacklog: boolean;
  syncTelemetryPaused: boolean;
  syncDroppedTelemetryCount: number;
};

const INSTALLATION_BOOTSTRAP_EVENT_TYPES = new Set(['sync.compacted', 'update.status', 'area.upsert']);

export function isInstallationBootstrapEvent(event: HubSyncEvent): boolean {
  if (INSTALLATION_BOOTSTRAP_EVENT_TYPES.has(event.type)) return true;
  return event.type === 'incident.transition' && event.critical === true
    && event.payload.osDeviceId === null && /^(hub|integration)_/.test(String(event.payload.kind || ''));
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function validUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const date = new Date(time);
  const milliseconds = value.match(/\.(\d{1,3})Z$/)?.[1].padEnd(3, '0') ?? '000';
  return date.toISOString().slice(0, 19) === value.slice(0, 19) && date.toISOString().slice(20, 23) === milliseconds;
}

function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && [...value].length <= max && (allowEmpty || value.length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validControlDescriptor(value: unknown, deviceId: string, catalogRevision: number): boolean {
  const keys = ['schemaVersion', 'deviceId', 'surfaceId', 'controlId', 'label', 'group', 'sortOrder', 'valueType', 'interactionKind', 'semanticRole', 'readable', 'writable', 'automatable', 'observable', 'idempotency', 'confirmationPolicy', 'riskLevel', 'stepUpPolicy', 'constraints', 'expectedReportingIntervalSeconds', 'maxStateValiditySeconds', 'unsupportedReason', 'catalogRevision'];
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))
    || !['schemaVersion', 'deviceId', 'surfaceId', 'controlId', 'label', 'group', 'sortOrder', 'valueType', 'interactionKind', 'semanticRole', 'readable', 'writable', 'automatable', 'observable', 'idempotency', 'confirmationPolicy', 'riskLevel', 'stepUpPolicy', 'unsupportedReason', 'catalogRevision'].every((key) => Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || value.deviceId !== deviceId || !boundedText(value.controlId, 160)
    || !boundedText(value.label, 80) || (value.group !== null && !boundedText(value.group, 80))
    || (value.surfaceId !== null && !boundedText(value.surfaceId, 160))
    || !Number.isSafeInteger(value.sortOrder) || Number(value.sortOrder) < 0
    || !['boolean', 'number', 'option', 'text', 'invoke'].includes(String(value.valueType))
    || !['toggle', 'slider', 'thermostat', 'picker', 'text_input', 'momentary_action', 'read_only'].includes(String(value.interactionKind))
    || !['power', 'brightness', 'active_heat_demand', 'active_heat_production', 'target_temperature', 'ambient_temperature', 'opening_percentage', 'connectivity', 'security_lock', 'lock_state', 'operating_mode', 'position', 'volume', 'color', 'state', 'unknown'].includes(String(value.semanticRole))
    || typeof value.readable !== 'boolean' || typeof value.writable !== 'boolean' || value.writable && !value.readable
    || typeof value.automatable !== 'boolean' || typeof value.observable !== 'boolean'
    || !['set_value', 'invoke_once', 'none'].includes(String(value.idempotency))
    || !['none', 'matching_observation', 'explicit_user', 'step_up'].includes(String(value.confirmationPolicy))
    || !['low', 'normal', 'sensitive', 'critical'].includes(String(value.riskLevel))
    || !['none', 'required'].includes(String(value.stepUpPolicy))
    || (value.unsupportedReason !== null && !boundedText(value.unsupportedReason, 120))
    || !Number.isSafeInteger(value.catalogRevision) || Number(value.catalogRevision) !== catalogRevision) return false;
  if (value.observable && (!Number.isSafeInteger(value.expectedReportingIntervalSeconds) || Number(value.expectedReportingIntervalSeconds) <= 0
    || !Number.isSafeInteger(value.maxStateValiditySeconds) || Number(value.maxStateValiditySeconds) <= 0)) return false;
  if (!value.observable && (Object.hasOwn(value, 'expectedReportingIntervalSeconds') || Object.hasOwn(value, 'maxStateValiditySeconds'))) return false;
  if (value.constraints !== undefined) {
    if (!object(value.constraints) || Object.keys(value.constraints).some((key) => !['minimum', 'maximum', 'step', 'precision', 'unit', 'options'].includes(key))) return false;
    const constraints = value.constraints;
    if (constraints.minimum !== undefined && (typeof constraints.minimum !== 'number' || !Number.isFinite(constraints.minimum))) return false;
    if (constraints.maximum !== undefined && (typeof constraints.maximum !== 'number' || !Number.isFinite(constraints.maximum))) return false;
    if (constraints.minimum !== undefined && constraints.maximum !== undefined && constraints.minimum > constraints.maximum) return false;
    if (constraints.step !== undefined && (typeof constraints.step !== 'number' || !Number.isFinite(constraints.step) || constraints.step <= 0)) return false;
    if (constraints.unit !== undefined && !boundedText(constraints.unit, 32, true)) return false;
    if (constraints.options !== undefined && (!Array.isArray(constraints.options) || constraints.options.length > 128
      || constraints.options.some((option) => !object(option) || !exactKeys(option, ['value', 'label']) || !Object.hasOwn(option, 'value') || !boundedText(option.label, 80, true)))) return false;
  }
  if (!['read_only', 'toggle', 'slider', 'thermostat', 'picker', 'text_input', 'momentary_action'].includes(String(value.interactionKind))) return false;
  if (String(value.interactionKind) === 'read_only' && value.writable) return false;
  if (value.stepUpPolicy === 'required' && value.automatable) return false;
  if (['security_lock', 'lock_state'].includes(String(value.semanticRole)) && (value.stepUpPolicy !== 'required' || value.automatable)) return false;
  return true;
}

function validEvent(event: unknown): event is HubSyncEvent {
  if (!object(event) || !exactKeys(event, ['id', 'sequence', 'type', 'aggregateId', 'occurredAt', 'critical', 'payload'])
    || typeof event.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.id)
    || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1
    || !boundedText(event.type, 60) || !boundedText(event.aggregateId, 160, true)
    || !validUtc(event.occurredAt) || typeof event.critical !== 'boolean' || !object(event.payload)) return false;
  const payload = event.payload;
  switch (event.type) {
    case 'area.upsert':
      return exactKeys(payload, ['osAreaId', 'name', 'icon']) && boundedText(payload.osAreaId, 160)
        && boundedText(payload.name, 160) && boundedText(payload.icon, 40);
    case 'area.tombstone':
      return exactKeys(payload, ['osAreaId', 'removedAt']) && boundedText(payload.osAreaId, 160) && validUtc(payload.removedAt);
    case 'device.upsert':
      return exactKeys(payload, ['osDeviceId', 'name', 'areaId', 'protocol', 'deviceType', 'technicalLabel', 'descriptorRevision', 'descriptorDigest', 'available', 'observedAt'])
        && boundedText(payload.osDeviceId, 160) && boundedText(payload.name, 160) && (payload.areaId === null || boundedText(payload.areaId, 160))
        && ['zigbee', 'matter', 'thread', 'hive', 'google_nest', 'unknown'].includes(String(payload.protocol))
        && boundedText(payload.deviceType, 120) && boundedText(payload.technicalLabel, 80)
        && Number.isSafeInteger(payload.descriptorRevision) && Number(payload.descriptorRevision) >= 1
        && typeof payload.descriptorDigest === 'string' && /^[a-f0-9]{64}$/i.test(payload.descriptorDigest)
        && typeof payload.available === 'boolean' && (payload.observedAt === null || validUtc(payload.observedAt));
    case 'device.tombstone':
      return (exactKeys(payload, ['osDeviceId', 'removedAt']) || exactKeys(payload, ['osDeviceId', 'removedAt', 'replacementOsDeviceId']))
        && boundedText(payload.osDeviceId, 160) && validUtc(payload.removedAt)
        && (payload.replacementOsDeviceId === undefined || boundedText(payload.replacementOsDeviceId, 160));
    case 'device.state': {
      const stateKeys = ['osDeviceId', 'osAreaId', 'controlId', 'sourceGeneration', 'descriptorRevision', 'revision',
        'observedAt', 'receivedAt', 'validUntil', 'quality', 'value', 'deviceAvailability'];
      const changeCauses = ['APP_INTERACTION', 'PERIODIC_POLL', 'PHYSICAL_INTERACTION', 'VOICE_INTERACTION'];
      if (!(exactKeys(payload, stateKeys) || exactKeys(payload, [...stateKeys, 'causeType']))
        || !boundedText(payload.osDeviceId, 160) || !boundedText(payload.osAreaId, 160) || !boundedText(payload.controlId, 160)
        || !Number.isSafeInteger(payload.sourceGeneration) || Number(payload.sourceGeneration) < 1
        || !Number.isSafeInteger(payload.descriptorRevision) || Number(payload.descriptorRevision) < 1
        || !Number.isSafeInteger(payload.revision) || Number(payload.revision) < 0
        || !validUtc(payload.observedAt) || !validUtc(payload.receivedAt) || !validUtc(payload.validUntil)
        || Date.parse(String(payload.receivedAt)) < Date.parse(String(payload.observedAt))
        || Date.parse(String(payload.validUntil)) <= Date.parse(String(payload.observedAt))
        || !['fresh', 'stale', 'unknown', 'unavailable'].includes(String(payload.quality))
        || !['online', 'offline', 'unknown'].includes(String(payload.deviceAvailability))
        || payload.causeType !== undefined && !changeCauses.includes(String(payload.causeType))
        || !(payload.value === null || typeof payload.value === 'boolean'
          || typeof payload.value === 'number' && Number.isFinite(payload.value)
          || typeof payload.value === 'string' && boundedText(payload.value, 160, true))
        || payload.value === null && !['unknown', 'unavailable'].includes(String(payload.quality))
        || event.critical) return false;
      const expectedAggregate = createHash('sha256').update(`${String(payload.osDeviceId)}\n${String(payload.controlId)}`, 'utf8').digest('hex');
      return event.aggregateId === expectedAggregate;
    }
    case 'control.catalog.upsert':
      return exactKeys(payload, ['osDeviceId', 'catalogRevision', 'descriptorDigest', 'controls'])
        && boundedText(payload.osDeviceId, 160) && Number.isSafeInteger(payload.catalogRevision) && Number(payload.catalogRevision) >= 1
        && typeof payload.descriptorDigest === 'string' && /^[a-f0-9]{64}$/i.test(payload.descriptorDigest)
        && Array.isArray(payload.controls) && payload.controls.length <= 64
        && payload.controls.every((control) => validControlDescriptor(control, String(payload.osDeviceId), Number(payload.catalogRevision)))
        && new Set(payload.controls.map((control) => String((control as Record<string, unknown>).controlId))).size === payload.controls.length;
    case 'control.catalog.tombstone':
      return exactKeys(payload, ['osDeviceId', 'catalogRevision', 'descriptorDigest', 'controlIds'])
        && boundedText(payload.osDeviceId, 160) && Number.isSafeInteger(payload.catalogRevision) && Number(payload.catalogRevision) >= 1
        && typeof payload.descriptorDigest === 'string' && /^[a-f0-9]{64}$/i.test(payload.descriptorDigest)
        && Array.isArray(payload.controlIds) && payload.controlIds.length > 0 && payload.controlIds.length <= 64
        && payload.controlIds.every((id) => boundedText(id, 160)) && new Set(payload.controlIds).size === payload.controlIds.length;
    case 'incident.transition':
      return exactKeys(payload, ['incidentKey', 'revision', 'kind', 'state', 'severity', 'occurredAt', 'firstObservedAt', 'lastObservedAt', 'resolvedAt', 'osDeviceId'])
        && /^[a-f0-9]{64}$/i.test(String(payload.incidentKey))
        && Number.isSafeInteger(payload.revision) && Number(payload.revision) >= 1
        && /^[a-z0-9_:-]{1,80}$/.test(String(payload.kind))
        && ['open', 'resolved'].includes(String(payload.state)) && payload.severity === 'critical'
        && validUtc(payload.occurredAt) && validUtc(payload.firstObservedAt) && validUtc(payload.lastObservedAt)
        && (payload.resolvedAt === null || validUtc(payload.resolvedAt))
        && (payload.osDeviceId === null || boundedText(payload.osDeviceId, 160));
    case 'update.status':
      return exactKeys(payload, ['trustState', 'phase', 'activeReleaseVersion', 'attemptId', 'releaseId', 'attemptPhase', 'resultCode', 'updatedAt', 'busy', 'revision'])
        && ['ready', 'unprovisioned', 'unavailable'].includes(String(payload.trustState))
        && ['idle', 'downloading', 'verifying', 'staged', 'maintenance', 'activating', 'health_check', 'active', 'failed', 'rolled_back', 'unavailable'].includes(String(payload.phase))
        && (payload.activeReleaseVersion === null || boundedText(payload.activeReleaseVersion, 96))
        && (payload.attemptId === null || boundedText(payload.attemptId, 96))
        && (payload.releaseId === null || boundedText(payload.releaseId, 96))
        && (payload.attemptPhase === null || ['downloading', 'verifying', 'staged', 'maintenance', 'activating', 'health_check', 'active', 'failed', 'rolled_back'].includes(String(payload.attemptPhase)))
        && (payload.resultCode === null || /^[A-Z0-9_-]{1,96}$/.test(String(payload.resultCode)))
        && (payload.updatedAt === null || validUtc(payload.updatedAt))
        && typeof payload.busy === 'boolean' && Number.isSafeInteger(payload.revision) && Number(payload.revision) >= 1
        && !(payload.phase === 'active' && payload.trustState !== 'ready');
    case 'usage.bucket': {
      const legacyKeys = ['osDeviceId', 'osAreaId', 'analyticsCategory', 'controlId', 'sourceGeneration', 'bucketStart', 'revision', 'onSeconds', 'offSeconds', 'unknownSeconds', 'closedAt', 'purgeAt'];
      const coveredKeys = [...legacyKeys.slice(0, 6), 'coverageStartAt', 'coverageEndAt', ...legacyKeys.slice(6)];
      const hasCoverage = exactKeys(payload, coveredKeys);
      if ((!hasCoverage && !exactKeys(payload, legacyKeys))
        || !boundedText(payload.osDeviceId, 160) || !boundedText(payload.osAreaId, 160)
        || !['LIGHT', 'BOILER', 'RADIATOR'].includes(String(payload.analyticsCategory)) || !boundedText(payload.controlId, 160)
        || !Number.isSafeInteger(payload.sourceGeneration) || Number(payload.sourceGeneration) < 1
        || !validUtc(payload.bucketStart) || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(String(payload.bucketStart))
        || hasCoverage && (!validUtc(payload.coverageStartAt) || !validUtc(payload.coverageEndAt))
        || !Number.isSafeInteger(payload.revision) || Number(payload.revision) < 1
        || ![payload.onSeconds, payload.offSeconds, payload.unknownSeconds].every((value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3600)
        || Number(payload.onSeconds) + Number(payload.offSeconds) + Number(payload.unknownSeconds) > 3600
        || !(payload.closedAt === null || validUtc(payload.closedAt)) || !validUtc(payload.purgeAt) || event.critical) return false;
      const start = Date.parse(String(payload.bucketStart));
      const totalSeconds = Number(payload.onSeconds) + Number(payload.offSeconds) + Number(payload.unknownSeconds);
      const closed = payload.closedAt === null ? null : Date.parse(String(payload.closedAt));
      const coveredStart = hasCoverage ? Date.parse(String(payload.coverageStartAt))
        : (closed ?? start + totalSeconds * 1000) - totalSeconds * 1000;
      const coveredEnd = hasCoverage ? Date.parse(String(payload.coverageEndAt))
        : (closed ?? start + totalSeconds * 1000);
      if (!Number.isFinite(coveredStart) || !Number.isFinite(coveredEnd)
        || coveredStart < start || coveredEnd > start + 3600000 || coveredEnd <= coveredStart
        || coveredEnd - coveredStart !== totalSeconds * 1000
        || (closed !== null && (closed !== start + 3600000 || coveredEnd !== closed))) return false;
      const purge = Date.parse(String(payload.purgeAt));
      const expectedPurge = new Date(start);
      const originalDay = expectedPurge.getUTCDate();
      expectedPurge.setUTCDate(1);
      expectedPurge.setUTCFullYear(expectedPurge.getUTCFullYear() + 1);
      const finalDay = new Date(Date.UTC(expectedPurge.getUTCFullYear(), expectedPurge.getUTCMonth() + 1, 0)).getUTCDate();
      expectedPurge.setUTCDate(Math.min(originalDay, finalDay));
      const expectedAggregate = createHash('sha256').update([
        String(payload.osDeviceId), String(payload.osAreaId), String(payload.analyticsCategory),
        String(payload.controlId), String(payload.sourceGeneration), String(start),
      ].join('|'), 'utf8').digest('hex');
      if (purge !== expectedPurge.getTime() || event.aggregateId !== expectedAggregate) return false;
      return true;
    }
    case 'temperature.sample':
      return exactKeys(payload, ['osDeviceId', 'osAreaId', 'controlId', 'sourceGeneration', 'sourceEventKey', 'temperature', 'sourceObservedAt', 'validUntil', 'quality'])
        && boundedText(payload.osDeviceId, 160) && boundedText(payload.osAreaId, 160) && boundedText(payload.controlId, 160)
        && Number.isSafeInteger(payload.sourceGeneration) && Number(payload.sourceGeneration) >= 1
        && /^[a-f0-9]{64}$/i.test(String(payload.sourceEventKey))
        && typeof payload.temperature === 'number' && Number.isFinite(payload.temperature) && payload.temperature >= -50 && payload.temperature <= 80
        && validUtc(payload.sourceObservedAt) && validUtc(payload.validUntil)
        && Date.parse(String(payload.validUntil)) > Date.parse(String(payload.sourceObservedAt))
        && Date.parse(String(payload.validUntil)) <= Date.parse(String(payload.sourceObservedAt)) + 30 * 60 * 1000
        && payload.quality === 'fresh' && !event.critical && event.aggregateId === payload.sourceEventKey;
    case 'automation.outcome':
      return exactKeys(payload, ['occurrenceId', 'automationId', 'automationRevision', 'status', 'startedAt', 'completedAt', 'actionCount', 'actionStatuses'])
        // OS occurrence IDs include the signed local UTC offset (for example
        // +0100/-0500) so repeated wall-clock times remain distinct at DST.
        && boundedText(payload.occurrenceId, 160) && /^[A-Za-z0-9:_+\-]+$/.test(String(payload.occurrenceId))
        && /^[0-9a-f-]{36}$/i.test(String(payload.automationId)) && event.aggregateId === payload.occurrenceId
        && Number.isSafeInteger(payload.automationRevision) && Number(payload.automationRevision) >= 1
        && ['succeeded', 'partial', 'failed', 'interrupted', 'skipped'].includes(String(payload.status))
        && validUtc(payload.startedAt) && validUtc(payload.completedAt) && Date.parse(String(payload.completedAt)) >= Date.parse(String(payload.startedAt))
        && Number.isSafeInteger(payload.actionCount) && Number(payload.actionCount) >= 0 && Number(payload.actionCount) <= 32
        && object(payload.actionStatuses) && exactKeys(payload.actionStatuses, ['applied', 'failed', 'uncertain', 'skipped'])
        && Object.values(payload.actionStatuses).every((value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= Number(payload.actionCount))
        && Object.values(payload.actionStatuses).reduce<number>((sum, value) => sum + Number(value), 0) <= Number(payload.actionCount) && event.critical;
    case 'sync.compacted':
      return exactKeys(payload, ['supersededBy']) && Number.isSafeInteger(payload.supersededBy) && Number(payload.supersededBy) > Number(event.sequence);
    default:
      return false;
  }
}

export function validateHubSyncEnvelope(value: unknown, rawBody?: string): value is HubSyncEnvelope {
  if (rawBody !== undefined && Buffer.byteLength(rawBody, 'utf8') > HUB_SYNC_MAX_BODY_BYTES) return false;
  const baseKeys = ['schemaVersion', 'hubInstallationId', 'streamId', 'fromSequence', 'toSequence', 'events', 'queueDepth', 'acknowledgedCloudRevision', 'runtime', 'sentAt'];
  const hasConfigurationRefreshOnly = object(value) && Object.hasOwn(value, 'configurationRefreshOnly');
  const configurationRefreshOnly = object(value) && value.configurationRefreshOnly === true;
  const hasStreamReconciliation = object(value) && Object.hasOwn(value, 'streamReconciliation');
  const allowedKeys = [...baseKeys,
    ...(configurationRefreshOnly ? ['configurationRefreshOnly'] : []),
    ...(hasStreamReconciliation ? ['streamReconciliation'] : []),
  ];
  if (!object(value) || !exactKeys(value, allowedKeys)
    || hasConfigurationRefreshOnly && !configurationRefreshOnly
    || configurationRefreshOnly && hasStreamReconciliation
    || value.schemaVersion !== 1 || typeof value.hubInstallationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.hubInstallationId)
    || typeof value.streamId !== 'string' || !/^[a-zA-Z0-9._:-]{16,80}$/.test(value.streamId)
    || !Number.isSafeInteger(value.fromSequence) || !Number.isSafeInteger(value.toSequence)
    || Number(value.fromSequence) < 1 || Number(value.toSequence) < 0
    || !Number.isSafeInteger(value.queueDepth) || Number(value.queueDepth) < 0 || Number(value.queueDepth) > 100000
    || !Number.isSafeInteger(value.acknowledgedCloudRevision) || Number(value.acknowledgedCloudRevision) < 0
    || !validUtc(value.sentAt) || !Array.isArray(value.events) || value.events.length > HUB_SYNC_MAX_EVENTS
    || !object(value.runtime) || !exactKeys(value.runtime, ['kind', 'version', 'capabilities']) || value.runtime.kind !== 'dinodia_os'
    || !boundedText(value.runtime.version, 120) || !object(value.runtime.capabilities)) return false;
  if (hasStreamReconciliation) {
    const reconciliation = value.streamReconciliation;
    if (!object(reconciliation) || !exactKeys(reconciliation, ['version', 'previousStreamId', 'previousAcceptedSequence'])
      || reconciliation.version !== 1 || !boundedText(reconciliation.previousStreamId, 80)
      || !/^[a-zA-Z0-9._:-]{16,80}$/.test(reconciliation.previousStreamId)
      || !Number.isSafeInteger(reconciliation.previousAcceptedSequence) || Number(reconciliation.previousAcceptedSequence) < 1) return false;
  }
  const syncStatus = (value.runtime.capabilities as Record<string, unknown>).nativeSyncOutbox;
  if (syncStatus !== undefined && (!object(syncStatus) || !exactKeys(syncStatus, ['queueDepth', 'gapDetected', 'criticalBacklog', 'telemetryPaused', 'droppedTelemetryCount', 'lastErrorCode'])
    || !Number.isSafeInteger(syncStatus.queueDepth) || Number(syncStatus.queueDepth) < 0 || Number(syncStatus.queueDepth) > 100000
    || typeof syncStatus.gapDetected !== 'boolean' || typeof syncStatus.criticalBacklog !== 'boolean' || typeof syncStatus.telemetryPaused !== 'boolean'
    || !Number.isSafeInteger(syncStatus.droppedTelemetryCount) || Number(syncStatus.droppedTelemetryCount) < 0
    || !(syncStatus.lastErrorCode === null || boundedText(syncStatus.lastErrorCode, 80)))) return false;
  const events = value.events;
  if (!events.every(validEvent)) return false;
  if (configurationRefreshOnly && events.length !== 0) return false;
  if (new Set(events.map((event) => event.id)).size !== events.length || Number(value.queueDepth) < events.length) return false;
  if (events.length === 0) {
    if (Number(value.fromSequence) !== Number(value.toSequence) + 1) return false;
  } else {
    if (Number(value.fromSequence) !== Number(events[0].sequence) || Number(value.toSequence) !== Number(events.at(-1)?.sequence)) return false;
    for (let index = 0; index < events.length; index += 1) if (Number(events[index].sequence) !== Number(value.fromSequence) + index) return false;
  }
  return Buffer.byteLength(JSON.stringify(events), 'utf8') <= HUB_SYNC_MAX_BATCH_BYTES;
}

export function canReconcileHubSyncStream(envelope: HubSyncEnvelope, state: HubSyncStreamState): boolean {
  const reconciliation = envelope.streamReconciliation;
  const localStatus = envelope.runtime.capabilities.nativeSyncOutbox;
  if (!reconciliation || envelope.configurationRefreshOnly === true || state.installationSyncMode !== 'ACTIVE'
    || !state.syncStreamId || state.syncStreamId === envelope.streamId
    || reconciliation.previousStreamId !== state.syncStreamId
    || !Number.isSafeInteger(state.syncAcceptedSequence) || state.syncAcceptedSequence < 1
    || reconciliation.previousAcceptedSequence !== state.syncAcceptedSequence
    || envelope.fromSequence !== 1 || envelope.events.length < 1 || envelope.events[0]?.sequence !== 1
    || state.syncGapDetected || state.syncCriticalBacklog || state.syncTelemetryPaused || state.syncDroppedTelemetryCount !== 0
    || !object(localStatus) || localStatus.gapDetected !== false || localStatus.criticalBacklog !== false
    || localStatus.telemetryPaused !== false || localStatus.droppedTelemetryCount !== 0) return false;
  return true;
}

export function hubSyncBodyHash(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

export function canonicalSyncJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSyncJson).join(',')}]`;
  if (!object(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(value[key])}`).join(',')}}`;
}

export function hashSyncConfiguration(value: unknown): string {
  return createHash('sha256').update(canonicalSyncJson(value), 'utf8').digest('hex');
}
