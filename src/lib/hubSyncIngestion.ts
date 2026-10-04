import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import type { HubSyncEvent } from './hubSyncEnvelope';

function invalid(code: string, message: string): never {
  throw new Stage1AuthError(409, code, message);
}

function strictDate(value: unknown, now: Date): Date {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > now.getTime() + 120_000) invalid('hub_sync_observation_invalid', 'A sync observation timestamp is invalid');
  return parsed;
}

async function requireAreaAssignmentAt(tx: Prisma.TransactionClient, input: {
  homeId: string; deviceId: string; areaId: string; at: Date;
}) {
  const assignment = await tx.deviceAreaAssignment.findFirst({ where: {
    homeId: input.homeId, deviceId: input.deviceId, areaId: input.areaId,
    validFrom: { lte: input.at },
    OR: [{ validUntil: null }, { validUntil: { gt: input.at } }],
  }, select: { id: true } });
  if (!assignment) invalid('hub_sync_area_assignment_invalid', 'The device was not assigned to this area at the source observation time');
}

function oneCalendarYearAfter(source: Date): Date {
  const result = new Date(source);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCFullYear(result.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export async function applyHubSyncEvent(tx: Prisma.TransactionClient, input: {
  event: HubSyncEvent; homeId: string; hubInstallationId: string; identityGeneration?: number; now: Date;
}) {
  const { event, homeId, hubInstallationId, now } = input;
  const payload = event.payload;
  if (event.type === 'sync.compacted') return;

  if (event.type === 'area.upsert') {
    const osAreaId = String(payload.osAreaId);
    const existing = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId } }, select: { id: true, originalName: true, status: true, revision: true } });
    if (existing?.status === 'RETIRED') invalid('hub_sync_retired_area', 'A retired area cannot be reintroduced by inventory sync');
    if (!existing) {
      await tx.area.create({ data: { homeId, osAreaId, originalName: String(payload.name), status: 'ACTIVE', revision: 1 } });
    } else if (existing.originalName !== String(payload.name)) {
      await tx.area.updateMany({ where: { id: existing.id, homeId, status: 'ACTIVE', revision: existing.revision }, data: { originalName: String(payload.name), revision: { increment: 1 } } });
    }
    return;
  }

  if (event.type === 'area.tombstone') {
    const osAreaId = String(payload.osAreaId);
    const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId } }, select: { id: true, status: true } });
    if (!area || area.status === 'RETIRED') return;
    await tx.area.update({ where: { id: area.id }, data: { status: 'RETIRED', retiredAt: strictDate(payload.removedAt, now), revision: { increment: 1 } } });
    await tx.deviceAreaAssignment.updateMany({ where: { homeId, areaId: area.id, validUntil: null }, data: { validUntil: now } });
    await tx.areaSourceAlias.updateMany({ where: { homeId, areaId: area.id, retiredAt: null }, data: { retiredAt: now } });
    return;
  }

  if (event.type === 'device.upsert') {
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, managementClass: true, lifecycle: true, descriptorRevision: true, descriptorDigest: true, protocol: true, originalName: true,
      assignments: { where: { validUntil: null }, select: { id: true, areaId: true } },
    } });
    // OS discovery is not itself authority to decide whether an unknown device
    // belongs to the property or a tenant. Commissioning must create the
    // platform-owned classification before its inventory is accepted.
    if (!device || device.homeId !== homeId || device.managementClass !== 'PROPERTY_DEVICE') invalid('hub_sync_device_uncommissioned', 'The device is not bound to a current permanent property record');
    if (['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)) invalid('hub_sync_device_retired', 'A removed device cannot be restored by inventory sync');
    const descriptorRevision = Number(payload.descriptorRevision);
    const descriptorDigest = String(payload.descriptorDigest);
    if (descriptorRevision < device.descriptorRevision || descriptorRevision === device.descriptorRevision && device.descriptorDigest && descriptorDigest !== device.descriptorDigest) {
      invalid('hub_sync_descriptor_stale', 'The device catalogue revision is stale or conflicts with the recorded descriptor');
    }
    let areaId: string | null = null;
    if (payload.areaId !== null) {
      const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId: String(payload.areaId) } }, select: { id: true, status: true } });
      if (!area || area.status !== 'ACTIVE') invalid('hub_sync_area_unavailable', 'The device area is not an active area in this home');
      areaId = area.id;
    }
    const observedAt = payload.observedAt === null ? null : strictDate(payload.observedAt, now);
    await tx.nativeDevice.update({ where: { id: device.id }, data: {
      originalName: String(payload.name), technicalLabel: String(payload.technicalLabel), protocol: String(payload.protocol),
      deviceType: String(payload.deviceType), descriptorRevision, descriptorDigest,
      capabilitySummary: { protocol: payload.protocol, technicalLabel: payload.technicalLabel, descriptorDigest } as Prisma.InputJsonValue,
      onlineState: payload.available === true ? 'ONLINE' : 'OFFLINE',
      ...(observedAt ? { lastSeenAt: observedAt } : {}),
    } });
    if (areaId !== null && !device.assignments.some((assignment) => assignment.areaId === areaId)) {
      await tx.deviceAreaAssignment.updateMany({ where: { deviceId: device.id, validUntil: null }, data: { validUntil: now } });
      await tx.deviceAreaAssignment.create({ data: { homeId, deviceId: device.id, areaId, source: 'DINODIA_OS_SYNC', validFrom: now } });
    } else if (areaId === null && device.assignments.length) {
      await tx.deviceAreaAssignment.updateMany({ where: { deviceId: device.id, validUntil: null }, data: { validUntil: now } });
    }
    return;
  }

  if (event.type === 'device.tombstone') {
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId: String(payload.osDeviceId) } }, select: { id: true, homeId: true, lifecycle: true } });
    if (!device || device.homeId !== homeId) return;
    if (device.lifecycle === 'REMOVED') return;
    await tx.nativeDevice.update({ where: { id: device.id }, data: { lifecycle: 'REMOVED', retiredAt: strictDate(payload.removedAt, now), cleanupDeadlineAt: now } });
    await tx.deviceAreaAssignment.updateMany({ where: { deviceId: device.id, validUntil: null }, data: { validUntil: now } });
    return;
  }

  if (event.type === 'control.catalog.upsert') {
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, lifecycle: true, managementClass: true, descriptorRevision: true, descriptorDigest: true, capabilitySummary: true,
    } });
    if (!device || device.homeId !== homeId || device.managementClass !== 'PROPERTY_DEVICE') invalid('hub_sync_catalog_device_invalid', 'The control catalogue does not belong to a current permanent property device');
    if (['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)) invalid('hub_sync_catalog_device_retired', 'A retired device catalogue cannot be restored');
    const revision = Number(payload.catalogRevision);
    if (revision !== device.descriptorRevision || payload.descriptorDigest !== device.descriptorDigest) invalid('hub_sync_catalog_revision_mismatch', 'The control catalogue does not match the current device descriptor');
    const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
      ? device.capabilitySummary as Record<string, unknown> : {};
    const priorCatalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
      ? summary.controlCatalog as Record<string, unknown> : null;
    const controls = payload.controls as unknown[];
    if (priorCatalog && Number(priorCatalog.revision) > revision) invalid('hub_sync_catalog_stale', 'A newer control catalogue is already stored');
    if (priorCatalog && Number(priorCatalog.revision) === revision) {
      if (JSON.stringify(priorCatalog.controls) !== JSON.stringify(controls) || priorCatalog.descriptorDigest !== payload.descriptorDigest) {
        invalid('hub_sync_catalog_conflict', 'This catalogue revision was already used for different controls');
      }
      return;
    }
    await tx.nativeDevice.update({ where: { id: device.id }, data: {
      capabilitySummary: { ...summary, controlCatalog: { revision, descriptorDigest: payload.descriptorDigest, controls } } as Prisma.InputJsonValue,
    } });
    return;
  }

  if (event.type === 'control.catalog.tombstone') {
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, lifecycle: true, managementClass: true, descriptorRevision: true, descriptorDigest: true, capabilitySummary: true,
    } });
    if (!device || device.homeId !== homeId || device.managementClass !== 'PROPERTY_DEVICE'
      || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)) invalid('hub_sync_catalog_device_invalid', 'The control catalogue tombstone is not for a current permanent device');
    const revision = Number(payload.catalogRevision);
    if (revision !== device.descriptorRevision || payload.descriptorDigest !== device.descriptorDigest) invalid('hub_sync_catalog_revision_mismatch', 'The catalogue tombstone does not match the current descriptor');
    const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
      ? device.capabilitySummary as Record<string, unknown> : {};
    const priorCatalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
      ? summary.controlCatalog as Record<string, unknown> : { revision, descriptorDigest: payload.descriptorDigest, controls: [] };
    if (Number(priorCatalog.revision) > revision) invalid('hub_sync_catalog_stale', 'A newer control catalogue is already stored');
    const removed = new Set(payload.controlIds as string[]);
    const priorControls = Array.isArray(priorCatalog.controls) ? priorCatalog.controls as Array<Record<string, unknown>> : [];
    const controls = priorControls.filter((control) => !removed.has(String(control.controlId)));
    if (Number(priorCatalog.revision) === revision && controls.length === priorControls.length) return;
    await tx.nativeDevice.update({ where: { id: device.id }, data: {
      capabilitySummary: { ...summary, controlCatalog: { revision, descriptorDigest: payload.descriptorDigest, controls } } as Prisma.InputJsonValue,
    } });
    return;
  }

  if (event.type === 'usage.bucket') {
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, managementClass: true, analyticsCategory: true, lifecycle: true, descriptorRevision: true, capabilitySummary: true,
    } });
    if (!device || device.homeId !== homeId) invalid('hub_sync_usage_device_invalid', 'The usage projection device does not belong to this enrolled home');
    // A newer staff policy may have revoked analytics or changed classification
    // while an old bounded event was in flight. Consume that stale event without
    // restoring the former projection.
    if (device.managementClass !== 'PROPERTY_DEVICE' || device.analyticsCategory !== payload.analyticsCategory
      || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)) return;
    if (Number(payload.sourceGeneration) !== Number(input.identityGeneration)) return;
    const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
      ? device.capabilitySummary as Record<string, unknown> : {};
    const catalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
      ? summary.controlCatalog as Record<string, unknown> : null;
    const controls = Array.isArray(catalog?.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
    const role = payload.analyticsCategory === 'LIGHT' ? 'power' : payload.analyticsCategory === 'RADIATOR' ? 'active_heat_demand' : 'active_heat_production';
    if (Number(catalog?.revision) !== Number(device.descriptorRevision)
      || !controls.some((control) => control.controlId === payload.controlId && control.semanticRole === role && control.observable === true)) return;
    const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId: String(payload.osAreaId) } }, select: { id: true } });
    if (!area) invalid('hub_sync_usage_area_invalid', 'The usage bucket area is not part of this home');
    const bucketStart = strictDate(payload.bucketStart, now);
    await requireAreaAssignmentAt(tx, { homeId, deviceId: device.id, areaId: area.id, at: bucketStart });
    const where = { deviceId_areaId_analyticsCategory_controlId_bucketStart_sourceGeneration: {
      deviceId: device.id, areaId: area.id, analyticsCategory: payload.analyticsCategory as 'LIGHT' | 'BOILER' | 'RADIATOR',
      controlId: String(payload.controlId), bucketStart, sourceGeneration: Number(payload.sourceGeneration),
    } };
    const previous = await tx.nativeDeviceUsageBucket.findUnique({ where, select: {
      id: true, revision: true, onSeconds: true, offSeconds: true, unknownSeconds: true, closedAt: true, purgeAt: true,
    } });
    const incomingRevision = Number(payload.revision);
    const closedAt = payload.closedAt === null ? null : strictDate(payload.closedAt, now);
    const purgeAt = new Date(String(payload.purgeAt));
    if (!Number.isFinite(purgeAt.getTime()) || purgeAt.getTime() !== oneCalendarYearAfter(bucketStart).getTime()) invalid('hub_sync_usage_purge_invalid', 'The usage bucket retention deadline is invalid');
    const data = { onSeconds: Number(payload.onSeconds), offSeconds: Number(payload.offSeconds), unknownSeconds: Number(payload.unknownSeconds), closedAt, purgeAt, revision: incomingRevision };
    if (previous) {
      if (previous.revision > incomingRevision) return;
      if (previous.revision === incomingRevision) {
        if (previous.onSeconds !== data.onSeconds || previous.offSeconds !== data.offSeconds || previous.unknownSeconds !== data.unknownSeconds
          || previous.closedAt?.getTime() !== closedAt?.getTime() || previous.purgeAt.getTime() !== purgeAt.getTime()) {
          invalid('hub_sync_usage_revision_conflict', 'A usage revision was reused with different absolute counters');
        }
        return;
      }
      if (data.onSeconds < previous.onSeconds || data.offSeconds < previous.offSeconds || data.unknownSeconds < previous.unknownSeconds) {
        invalid('hub_sync_usage_counter_regression', 'Absolute usage counters cannot move backwards');
      }
      await tx.nativeDeviceUsageBucket.update({ where: { id: previous.id }, data });
      return;
    }
    await tx.nativeDeviceUsageBucket.create({ data: {
      homeId, deviceId: device.id, areaId: area.id, analyticsCategory: payload.analyticsCategory as 'LIGHT' | 'BOILER' | 'RADIATOR',
      controlId: String(payload.controlId), bucketStart, sourceGeneration: Number(payload.sourceGeneration), ...data,
    } });
    return;
  }

  if (event.type === 'temperature.sample') {
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, managementClass: true, analyticsCategory: true, lifecycle: true, descriptorRevision: true, capabilitySummary: true,
      radiatorReadingAt: true,
    } });
    if (!device || device.homeId !== homeId) invalid('hub_sync_temperature_device_invalid', 'The temperature projection device does not belong to this enrolled home');
    if (device.managementClass !== 'PROPERTY_DEVICE' || device.analyticsCategory !== 'RADIATOR'
      || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)
      || Number(payload.sourceGeneration) !== Number(input.identityGeneration)) return;
    const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
      ? device.capabilitySummary as Record<string, unknown> : {};
    const catalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
      ? summary.controlCatalog as Record<string, unknown> : null;
    const controls = Array.isArray(catalog?.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
    const control = controls.find((item) => item.controlId === payload.controlId && item.semanticRole === 'ambient_temperature' && item.valueType === 'number' && item.observable === true);
    if (Number(catalog?.revision) !== Number(device.descriptorRevision) || !control) return;
    const observedAt = strictDate(payload.sourceObservedAt, now);
    const validUntil = new Date(String(payload.validUntil));
    if (!Number.isFinite(validUntil.getTime())) invalid('hub_sync_temperature_validity_invalid', 'The temperature validity deadline is invalid');
    if (validUntil <= observedAt || validUntil.getTime() > observedAt.getTime() + 30 * 60 * 1000
      || observedAt > now || now >= validUntil) return;
    const existing = await tx.nativeTemperatureSample.findUnique({ where: { sourceEventKey: String(payload.sourceEventKey) }, select: { id: true, homeId: true, deviceId: true, temperature: true, sourceObservedAt: true, validUntil: true } });
    const expectedSourceEventKey = createHash('sha256').update([
      osDeviceId, String(payload.controlId), String(payload.sourceGeneration), observedAt.toISOString(),
    ].join('\n'), 'utf8').digest('hex');
    if (String(payload.sourceEventKey) !== expectedSourceEventKey || event.aggregateId !== expectedSourceEventKey) {
      invalid('hub_sync_temperature_key_invalid', 'The temperature observation identity does not match its source fields');
    }
    if (existing) {
      if (existing.homeId !== homeId || existing.deviceId !== device.id || Number(existing.temperature) !== Number(payload.temperature)
        || existing.sourceObservedAt.getTime() !== observedAt.getTime() || existing.validUntil.getTime() !== validUntil.getTime()) {
        invalid('hub_sync_temperature_key_conflict', 'A temperature observation key was reused with different data');
      }
      return;
    }
    const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId: String(payload.osAreaId) } }, select: { id: true } });
    if (!area) invalid('hub_sync_temperature_area_invalid', 'The temperature observation area is not part of this home');
    await requireAreaAssignmentAt(tx, { homeId, deviceId: device.id, areaId: area.id, at: observedAt });
    const recent = device.radiatorReadingAt && device.radiatorReadingAt.getTime() >= observedAt.getTime();
    await tx.nativeTemperatureSample.create({ data: {
      homeId, deviceId: device.id, areaId: area.id, sourceEventKey: String(payload.sourceEventKey),
      temperature: Number(payload.temperature), sourceObservedAt: observedAt, validUntil,
      sourceGeneration: Number(payload.sourceGeneration), purgeAt: oneCalendarYearAfter(observedAt),
    } });
    if (!recent) await tx.nativeDevice.update({ where: { id: device.id }, data: { radiatorTemperature: Number(payload.temperature), radiatorReadingAt: observedAt } });
    return;
  }

  if (event.type === 'automation.outcome') {
    const automation = await tx.nativeAutomation.findUnique({ where: { id: String(payload.automationId) }, select: { id: true, homeId: true, revision: true } });
    if (!automation || automation.homeId !== homeId) invalid('hub_sync_automation_invalid', 'The automation outcome does not belong to this enrolled home');
    if (Number(payload.automationRevision) > automation.revision) invalid('hub_sync_automation_revision_invalid', 'The automation outcome is ahead of the current Platform definition');
    const idempotencyKey = `hub:${hubInstallationId}:${String(payload.occurrenceId)}`;
    const status = payload.status === 'succeeded' ? 'SUCCEEDED' : payload.status === 'partial' ? 'PARTIAL' : payload.status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
    const safeOutcome = { actionCount: Number(payload.actionCount), actionStatuses: payload.actionStatuses } as Prisma.InputJsonValue;
    const existing = await tx.nativeAutomationExecution.findUnique({ where: { idempotencyKey }, select: { automationId: true, homeId: true, status: true, safeOutcome: true, startedAt: true, completedAt: true } });
    if (existing) {
      if (existing.automationId !== automation.id || existing.homeId !== homeId || existing.status !== status
        || JSON.stringify(existing.safeOutcome) !== JSON.stringify(safeOutcome)
        || existing.startedAt.getTime() !== Date.parse(String(payload.startedAt))
        || existing.completedAt?.getTime() !== Date.parse(String(payload.completedAt))) {
        invalid('hub_sync_automation_outcome_conflict', 'An automation occurrence was reused with different outcome data');
      }
      return;
    }
    await tx.nativeAutomationExecution.create({ data: {
      automationId: automation.id, homeId, idempotencyKey, status,
      startedAt: strictDate(payload.startedAt, now), completedAt: strictDate(payload.completedAt, now), safeOutcome,
      purgeAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    } });
    return;
  }

  if (event.type === 'incident.transition') {
    const incidentKey = String(payload.incidentKey);
    const revision = Number(payload.revision);
    const prior = await tx.nativeDeviceOutageIncident.findUnique({
      where: { hubInstallationId_sourceIncidentKey: { hubInstallationId, sourceIncidentKey: incidentKey } },
      select: { id: true, sourceRevision: true },
    });
    if (prior && prior.sourceRevision >= revision) return;
    let deviceId: string | null = null;
    if (payload.osDeviceId !== null) {
      const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId: String(payload.osDeviceId) } }, select: { id: true, homeId: true } });
      if (!device || device.homeId !== homeId) invalid('hub_sync_incident_device_invalid', 'The incident device is not part of this enrolled home');
      deviceId = device.id;
    }
    const firstObservedAt = strictDate(payload.firstObservedAt, now);
    strictDate(payload.lastObservedAt, now);
    const resolvedAt = payload.state === 'resolved' && payload.resolvedAt !== null ? strictDate(payload.resolvedAt, now) : null;
    const isHubIncident = /^(hub|integration)_/.test(String(payload.kind));
    const alertEligibleAt = new Date(firstObservedAt.getTime() + (isHubIncident ? 7 * 60_000 : 60 * 60_000));
    const data = {
      homeId,
      sourceIncidentKey: incidentKey,
      sourceRevision: revision,
      sourceEventId: event.id,
      deviceId,
      hubInstallationId,
      offlineObservedAt: firstObservedAt,
      alertEligibleAt,
      state: payload.state === 'resolved' ? 'RESOLVED' : 'OPEN',
      recoveredAt: resolvedAt,
    };
    if (prior) {
      await tx.nativeDeviceOutageIncident.updateMany({ where: { id: prior.id, sourceRevision: { lt: revision } }, data });
    } else {
      await tx.nativeDeviceOutageIncident.create({ data });
    }
    return;
  }

  if (event.type === 'update.status') {
    const revision = Number(payload.revision);
    const current = await tx.hubInstallation.findUnique({ where: { id: hubInstallationId }, select: {
      updateStatusRevision: true, updaterTrustState: true, updatePhase: true, updateAttemptId: true,
      updateReleaseId: true, activeReleaseVersion: true, updateResultCode: true, updateStatusAt: true, updateBusy: true,
    } });
    if (!current) invalid('hub_sync_update_status_hub_invalid', 'The updater status does not belong to the active hub');
    if (revision < current.updateStatusRevision) invalid('hub_sync_update_status_stale', 'A newer updater status revision is already recorded');
    const trustState = String(payload.trustState).toUpperCase();
    const phase = String(payload.phase);
    if (revision === current.updateStatusRevision) {
      const same = current.updaterTrustState === trustState && current.updatePhase === phase
        && current.updateAttemptId === payload.attemptId && current.updateReleaseId === payload.releaseId
        && current.activeReleaseVersion === payload.activeReleaseVersion && current.updateResultCode === payload.resultCode
        && current.updateBusy === payload.busy;
      if (!same) invalid('hub_sync_update_status_conflict', 'This updater status revision was already used for different state');
      return;
    }
    const phaseRank: Record<string, number> = { idle: 0, downloading: 1, verifying: 2, staged: 3, maintenance: 4, activating: 5, health_check: 6, active: 7, failed: 7, rolled_back: 7 };
    if (payload.attemptId && current.updateAttemptId === payload.attemptId) {
      const priorPhase = String(current.updatePhase);
      if (phaseRank[phase] !== undefined && phaseRank[priorPhase] !== undefined && phaseRank[phase] < phaseRank[priorPhase]) {
        invalid('hub_sync_update_status_regression', 'Updater attempt phases cannot move backwards');
      }
      if (['active', 'failed', 'rolled_back'].includes(priorPhase) && phase !== priorPhase) {
        invalid('hub_sync_update_status_terminal', 'A terminal updater attempt cannot return to an active phase');
      }
    }
    if (phase === 'active' && trustState !== 'ready') invalid('hub_sync_update_untrusted_active', 'An untrusted updater cannot report a release as active');
    await tx.hubInstallation.update({ where: { id: hubInstallationId }, data: {
      updateStatusRevision: revision,
      updaterTrustState: trustState,
      updatePhase: phase,
      updateAttemptId: payload.attemptId === null ? null : String(payload.attemptId),
      updateReleaseId: payload.releaseId === null ? null : String(payload.releaseId),
      activeReleaseVersion: payload.activeReleaseVersion === null ? null : String(payload.activeReleaseVersion),
      updateResultCode: payload.resultCode === null ? null : String(payload.resultCode),
      updateStatusAt: payload.updatedAt === null ? null : strictDate(payload.updatedAt, now),
      updateBusy: payload.busy === true,
    } });
    return;
  }

  invalid('hub_sync_event_unsupported', 'The sync event type is not supported');
}
