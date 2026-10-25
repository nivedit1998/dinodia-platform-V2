import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { canonicalSyncJson, type HubSyncEvent } from './hubSyncEnvelope';
import { isAutomationEligibilityUpgrade } from './catalogAutomationEligibility';
import { queueAutomationFailureNotices } from './nativeAutomations/failureNotifications';
import { suspendAutomationsForDeviceChange } from './nativeAutomations/revalidation';
import { retireNativeAutomations } from './nativeAutomations/lifecycle';
import { currentCustomerPolicy } from './customerPolicyConfig';
import { allowedAnalyticsControls, classifyUsageAuthority } from './analyticsIntervals';
import { suppressedSyncEvents } from './deletionReferences';
import { ingestDailyAnalytics, quarantineDailyAnalytics, sealedLegacyEvent } from './dailyAnalyticsIngestion';

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

async function requireAreaAssignmentForCoverage(tx: Prisma.TransactionClient, input: {
  homeId: string; deviceId: string; areaId: string; start: Date; end: Date;
}) {
  // Usage is attributed to one canonical Area for its whole half-open covered
  // interval. Checking the containing hour's bucketStart incorrectly rejects
  // a device first assigned at (for example) 10:30, and can attribute earlier
  // history to an Area after a move.
  const assignment = await tx.deviceAreaAssignment.findFirst({ where: {
    homeId: input.homeId, deviceId: input.deviceId, areaId: input.areaId,
    validFrom: { lte: input.start },
    OR: [{ validUntil: null }, { validUntil: { gte: input.end } }],
  }, select: { id: true } });
  if (!assignment) invalid('hub_sync_area_assignment_invalid', 'The device was not assigned to this area for the complete covered interval');
}

export async function assertUsageClosureRecoveryCurrent(tx: Prisma.TransactionClient, input: {
  homeId: string; hubInstallationId: string; identityGeneration: number; payload: Record<string, unknown>;
}): Promise<void> {
  const payload = input.payload;
  const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: {
    hubInstallationId: input.hubInstallationId, osDeviceId: String(payload.osDeviceId),
  } }, select: { id: true, homeId: true, managementClass: true, analyticsCategory: true, lifecycle: true,
    descriptorRevision: true, capabilitySummary: true } });
  const category = String(payload.analyticsCategory);
  if (!device || device.homeId !== input.homeId || device.managementClass !== 'PROPERTY_DEVICE'
    || device.analyticsCategory !== category || !['LIGHT', 'BOILER', 'RADIATOR'].includes(category)
    || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)
    || Number(payload.sourceGeneration) !== input.identityGeneration) {
    invalid('hub_sync_usage_recovery_policy_changed', 'Current permanent-device analytics authority no longer permits this bucket');
  }
  const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
    ? device.capabilitySummary as Record<string, unknown> : {};
  const catalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
    ? summary.controlCatalog as Record<string, unknown> : {};
  const controls = Array.isArray(catalog.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
  const roles = category === 'LIGHT' ? ['power', 'brightness'] : category === 'RADIATOR' ? ['active_heat_demand'] : ['active_heat_production'];
  if (Number(catalog.revision) !== Number(device.descriptorRevision)
    || !controls.some((control) => control.controlId === payload.controlId
      && roles.includes(String(control.semanticRole)) && control.observable === true)) {
    invalid('hub_sync_usage_recovery_policy_changed', 'The current descriptor does not authorize this Radiator observation');
  }
  const area = await tx.area.findUnique({ where: { homeId_osAreaId: {
    homeId: input.homeId, osAreaId: String(payload.osAreaId),
  } }, select: { id: true, status: true } });
  const coverageStart = new Date(String(payload.coverageStartAt));
  const coverageEnd = new Date(String(payload.coverageEndAt));
  if (!area || area.status !== 'ACTIVE') invalid('hub_sync_usage_recovery_policy_changed', 'The source Area is no longer active');
  await requireAreaAssignmentForCoverage(tx, { homeId: input.homeId, deviceId: device.id, areaId: area.id,
    start: coverageStart, end: coverageEnd });
  const bucket = await tx.nativeDeviceUsageBucket.findUnique({ where: {
    deviceId_areaId_analyticsCategory_controlId_bucketStart_sourceGeneration: {
      deviceId: device.id, areaId: area.id, analyticsCategory: category as 'LIGHT' | 'BOILER' | 'RADIATOR', controlId: String(payload.controlId),
      bucketStart: new Date(String(payload.bucketStart)), sourceGeneration: Number(payload.sourceGeneration), bindingRevision: Number(payload.bindingRevision || 0),
    },
  }, select: { revision: true, onSeconds: true, offSeconds: true, unknownSeconds: true, closedAt: true } });
  if (bucket && (bucket.closedAt || bucket.revision >= Number(payload.revision)
    || bucket.onSeconds > Number(payload.onSeconds) || bucket.offSeconds > Number(payload.offSeconds)
    || bucket.unknownSeconds > Number(payload.unknownSeconds))) {
    invalid('hub_sync_usage_recovery_state_changed', 'The cloud already contains this or a newer usage revision');
  }
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

function oneCalendarYearBefore(source: Date): Date {
  const result = new Date(source);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCFullYear(result.getUTCFullYear() - 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

type SyncEventInput = {
  event: HubSyncEvent; homeId: string; hubInstallationId: string; identityGeneration?: number; now: Date;
  suppressedEventIds?: Set<string>; streamId?: string;
};

// Only validated, authenticated usage events enter this boundary. A savepoint is
// essential: PostgreSQL constraint errors otherwise poison the outer batch even
// if JavaScript catches them. Never consume malformed envelopes or database outages.
export async function applyHubSyncEvent(tx: Prisma.TransactionClient, input: SyncEventInput) {
  const suppressed = input.suppressedEventIds ?? await suppressedSyncEvents(tx, input.hubInstallationId, [input.event]);
  // The envelope and stream identity have already been authenticated/validated. Acknowledge
  // erased targets without storing their payloads or blocking an immutable signed batch.
  if (suppressed.has(input.event.id)) return;
  if (input.event.type === 'analytics.day') {
    await tx.$executeRawUnsafe('SAVEPOINT analytics_daily_event');
    try {
      await applyHubSyncEventInner(tx, input);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT analytics_daily_event');
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT analytics_daily_event');
      const code = error instanceof Stage1AuthError ? error.code : '';
      if (!['hub_sync_daily_authority_invalid', 'hub_sync_daily_assignment_invalid', 'hub_sync_daily_coverage_regression',
        'hub_sync_daily_overlap', 'hub_sync_daily_writer_invalid', 'hub_sync_daily_disabled'].includes(code)) throw error;
      await quarantineDailyAnalytics(tx, input, code);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT analytics_daily_event');
    }
    return;
  }
  if (input.event.type !== 'usage.bucket') return applyHubSyncEventInner(tx, input);
  await tx.$executeRawUnsafe('SAVEPOINT analytics_usage_event');
  try {
    await applyHubSyncEventInner(tx, input);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT analytics_usage_event');
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT analytics_usage_event');
    const code = error instanceof Stage1AuthError ? error.code : '';
    const reasons = new Set(['hub_sync_usage_generation_invalid', 'hub_sync_analytics_interval_invalid',
      'hub_sync_analytics_control_invalid', 'hub_sync_analytics_interval_limit']);
    const dbError = error as { code?: string; meta?: { code?: string; message?: string; database_error?: string }; message?: string };
    const constraintMessage = String(dbError.meta?.database_error || dbError.meta?.message || dbError.message || '');
    // Prisma model writes can surface PL/pgSQL RAISE as an UnknownRequestError
    // (SQLSTATE E23514 in its message), not only P2004/P2010.
    const constraint = (dbError.code === 'P2004' || dbError.code === 'P2010' && dbError.meta?.code === '23514'
      || /\bE?23514\b/.test(constraintMessage))
      && /physical-device usage coverage cannot overlap|usage requires its exact authorized analytics interval|legacy usage requires authorized category coverage|analytics intervals cannot overlap/.test(constraintMessage);
    if (!reasons.has(code) && !constraint
      && !(code === 'hub_sync_area_assignment_invalid' && input.event.payload.analyticsIntervalId)) throw error;
    const { event, homeId, hubInstallationId } = input;
    const payload = event.payload;
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: {
      hubInstallationId, osDeviceId: String(payload.osDeviceId),
    } }, select: { id: true, homeId: true, managementClass: true, ownerMembershipId: true } });
    const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId: String(payload.osAreaId) } }, select: { id: true } });
    // Archival never grants authority to a private/cross-Home device or Area.
    if (!device || device.homeId !== homeId || device.managementClass !== 'PROPERTY_DEVICE' || device.ownerMembershipId || !area) throw error;
    const digest = createHash('sha256').update(canonicalSyncJson(payload)).digest('hex');
    const prior = await tx.nativeAnalyticsUnallocated.findUnique({ where: { hubInstallationId_eventId: { hubInstallationId, eventId: event.id } } });
    // Event-id/body conflicts are forged/reused identities, not stale analytics authority.
    if (prior && prior.evidenceDigest !== digest) invalid('hub_sync_unallocated_conflict', 'An authenticated event identity was reused');
    if (!prior) await tx.nativeAnalyticsUnallocated.create({ data: { homeId, hubInstallationId, deviceId: device.id, areaId: area.id,
      analyticsCategory: payload.analyticsCategory as 'LIGHT' | 'RADIATOR' | 'BOILER', eventId: event.id, payload: payload as Prisma.InputJsonValue,
      evidenceDigest: digest, reason: constraint ? 'analytics_constraint_unallocated' : code,
      coverageStartAt: new Date(String(payload.coverageStartAt ?? new Date(Date.parse(String(payload.closedAt || payload.bucketStart))
        + (payload.closedAt ? -1 : 0) * (Number(payload.onSeconds) + Number(payload.offSeconds) + Number(payload.unknownSeconds)) * 1000).toISOString())),
      coverageEndAt: new Date(String(payload.coverageEndAt ?? payload.closedAt ?? new Date(Date.parse(String(payload.bucketStart))
        + (Number(payload.onSeconds) + Number(payload.offSeconds) + Number(payload.unknownSeconds)) * 1000).toISOString())),
      purgeAt: new Date(String(payload.purgeAt)) } });
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT analytics_usage_event');
  }
}

async function applyHubSyncEventInner(tx: Prisma.TransactionClient, input: SyncEventInput) {
  const { event, homeId, hubInstallationId, now } = input;
  const payload = event.payload;
  if (event.type === 'sync.compacted') return;
  if (process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED === 'true' && await sealedLegacyEvent(tx, input)) return;
  if (event.type === 'analytics.day' || event.type === 'analytics.daily.barrier') return ingestDailyAnalytics(tx, input);

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
    await retireNativeAutomations(tx, { homeId, losingAreaIds: [area.id], now, actorId: null, reason: 'original_area_retired' });
    await tx.area.update({ where: { id: area.id }, data: { status: 'RETIRED', retiredAt: strictDate(payload.removedAt, now), revision: { increment: 1 } } });
    await tx.deviceAreaAssignment.updateMany({ where: { homeId, areaId: area.id, validUntil: null }, data: { validUntil: now } });
    await tx.areaSourceAlias.updateMany({ where: { homeId, areaId: area.id, retiredAt: null }, data: { retiredAt: now } });
    return;
  }

  if (event.type === 'device.upsert') {
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, managementClass: true, lifecycle: true, descriptorRevision: true, descriptorDigest: true, protocol: true, originalName: true,
      capabilitySummary: true,
      assignments: { where: { validUntil: null }, select: { id: true, areaId: true, validFrom: true } },
    } });
    // OS discovery is not itself authority to decide whether an unknown device
    // belongs to the property or a tenant. Commissioning must create the
    // platform-owned classification before its inventory is accepted.
    if (!device || device.homeId !== homeId || device.managementClass !== 'PROPERTY_DEVICE') invalid('hub_sync_device_uncommissioned', 'The device is not bound to a current permanent property record');
    if (device.lifecycle === 'RETIRED'
      && (device.capabilitySummary as Record<string, unknown> | null)?.logicalConversion) return;
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
    const descriptorChanged = descriptorRevision !== device.descriptorRevision || descriptorDigest !== String(device.descriptorDigest || '');
    const currentAreaIds = device.assignments.map((assignment) => assignment.areaId).sort();
    const nextAreaIds = areaId === null ? [] : [areaId];
    const areaChanged = currentAreaIds.length !== nextAreaIds.length || currentAreaIds.some((id, index) => id !== nextAreaIds[index]);
    if (descriptorChanged || areaChanged) await suspendAutomationsForDeviceChange(tx, { homeId, deviceId: device.id, now,
      reason: descriptorChanged ? 'descriptor_changed' : 'area_changed' });
    const priorSummary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
      ? device.capabilitySummary as Record<string, unknown> : {};
    const nextSummary: Record<string, unknown> = { ...priorSummary, protocol: payload.protocol, technicalLabel: payload.technicalLabel, descriptorDigest };
    if (descriptorChanged) {
      delete nextSummary.controlCatalog;
      delete nextSummary.alexaStateByControl;
    }
    await tx.nativeDevice.update({ where: { id: device.id }, data: {
      originalName: String(payload.name), technicalLabel: String(payload.technicalLabel), protocol: String(payload.protocol),
      deviceType: String(payload.deviceType), descriptorRevision, descriptorDigest,
      capabilitySummary: nextSummary as Prisma.InputJsonValue,
      onlineState: payload.available === true ? 'ONLINE' : 'OFFLINE',
      ...(observedAt ? { lastSeenAt: observedAt } : {}),
    } });
    const assignmentBoundary = strictDate(event.occurredAt, now);
    // A signed, trusted OFFLINE transition ends currentness for previously
    // checked temperature evidence. Keep the immutable reported validity,
    // measured value and source time; persist a separate earliest end boundary.
    // A later ONLINE inventory event cannot revive it; only a newly admitted
    // temperature.sample can establish new evidence.
    // Do not clip a sample reported at or after this boundary, or one whose
    // validity already ended. The policy-3 database check permits equality.
    if (payload.available === false) {
      await tx.nativeTemperatureSample.updateMany({
        where: {
          deviceId: device.id,
          analyticsPolicyVersion: 3,
          sourceObservedAt: { lt: assignmentBoundary },
          validUntil: { gt: assignmentBoundary },
          OR: [{ currentnessEndedAt: null }, { currentnessEndedAt: { gt: assignmentBoundary } }],
        },
        data: { currentnessEndedAt: assignmentBoundary },
      });
    }
    // Delivery time is not the assignment time. An older queued inventory
    // event must not resurrect an Area after a newer canonical move, nor
    // create a zero-length assignment when both events share a transaction.
    const latestAssignment = areaChanged ? await tx.deviceAreaAssignment.findFirst({ where: { deviceId: device.id, homeId },
      orderBy: [{ validFrom: 'desc' }, { id: 'desc' }], select: { validFrom: true, validUntil: true } }) : null;
    const assignmentCanAdvance = !latestAssignment || (latestAssignment.validUntil
      ? latestAssignment.validUntil <= assignmentBoundary : latestAssignment.validFrom < assignmentBoundary);
    if (areaId !== null && assignmentCanAdvance && !device.assignments.some((assignment) => assignment.areaId === areaId)) {
      await tx.deviceAreaAssignment.updateMany({ where: { deviceId: device.id, validUntil: null }, data: { validUntil: assignmentBoundary } });
      await tx.deviceAreaAssignment.create({ data: { homeId, deviceId: device.id, areaId, source: 'DINODIA_OS_SYNC', validFrom: assignmentBoundary } });
    } else if (areaId === null && assignmentCanAdvance && device.assignments.length) {
      await tx.deviceAreaAssignment.updateMany({ where: { deviceId: device.id, validUntil: null }, data: { validUntil: assignmentBoundary } });
    }
    return;
  }

  if (event.type === 'device.tombstone') {
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId: String(payload.osDeviceId) } }, select: { id: true, homeId: true, lifecycle: true, capabilitySummary: true } });
    if (!device || device.homeId !== homeId) return;
    if (device.lifecycle === 'RETIRED'
      && (device.capabilitySummary as Record<string, unknown> | null)?.logicalConversion) return;
    if (device.lifecycle === 'REMOVED') return;
    await suspendAutomationsForDeviceChange(tx, { homeId, deviceId: device.id, now, reason: 'device_removed' });
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
    if (device.lifecycle === 'RETIRED'
      && (device.capabilitySummary as Record<string, unknown> | null)?.logicalConversion) return;
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
      // PostgreSQL JSONB may return object keys in a different order from the
      // signed OS payload. Compare canonical structure while retaining array
      // order, so an exact descriptor retry is idempotent but changed controls
      // at the same revision still conflict.
      if (priorCatalog.descriptorDigest === payload.descriptorDigest && canonicalSyncJson(priorCatalog.controls) !== canonicalSyncJson(controls)
        && isAutomationEligibilityUpgrade(priorCatalog.controls, controls)) {
        // Same revision and digest; only owner-approved controls became schedulable.
        await tx.nativeDevice.update({ where: { id: device.id }, data: {
          capabilitySummary: { ...summary, controlCatalog: { revision, descriptorDigest: payload.descriptorDigest, controls } } as Prisma.InputJsonValue,
        } });
        return;
      }
      if (canonicalSyncJson(priorCatalog.controls) !== canonicalSyncJson(controls) || priorCatalog.descriptorDigest !== payload.descriptorDigest) {
        invalid('hub_sync_catalog_conflict', 'This catalogue revision was already used for different controls');
      }
      return;
    }
    await tx.nativeDevice.update({ where: { id: device.id }, data: {
      capabilitySummary: { ...summary, controlCatalog: { revision, descriptorDigest: payload.descriptorDigest, controls } } as Prisma.InputJsonValue,
    } });
    const initialInterval = await tx.nativeAnalyticsInterval.findFirst({ where: { deviceId: device.id, validUntil: null, newWriterFrom: null } });
    if (initialInterval && Array.isArray(initialInterval.authorizedControls) && initialInterval.authorizedControls.length === 0) {
      await tx.nativeAnalyticsInterval.update({ where: { id: initialInterval.id }, data: { authorizedControls: controls as Prisma.InputJsonValue } });
    }
    return;
  }

  if (event.type === 'control.catalog.tombstone') {
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, lifecycle: true, managementClass: true, descriptorRevision: true, descriptorDigest: true, capabilitySummary: true,
    } });
    if (device?.homeId === homeId && device.lifecycle === 'RETIRED'
      && (device.capabilitySummary as Record<string, unknown> | null)?.logicalConversion) return;
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
    await suspendAutomationsForDeviceChange(tx, { homeId, deviceId: device.id, now, reason: 'control_removed', controlIds: [...removed] });
    await tx.nativeDevice.update({ where: { id: device.id }, data: {
      capabilitySummary: { ...summary, controlCatalog: { revision, descriptorDigest: payload.descriptorDigest, controls } } as Prisma.InputJsonValue,
    } });
    return;
  }

  if (event.type === 'device.state') {
    const changeCauses = new Set(['APP_INTERACTION', 'PERIODIC_POLL', 'PHYSICAL_INTERACTION', 'VOICE_INTERACTION']);
    const causeType = changeCauses.has(String(payload.causeType ?? '')) ? String(payload.causeType) : null;
    const osDeviceId = String(payload.osDeviceId);
    const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId } }, select: {
      id: true, homeId: true, osDeviceId: true, managementClass: true, ownerMembershipId: true, lifecycle: true,
      descriptorRevision: true, descriptorDigest: true, capabilitySummary: true,
    } });
    if (!device || device.homeId !== homeId) invalid('hub_sync_state_device_invalid', 'The state observation does not belong to this enrolled Home');
    const tenantOwned = device.managementClass === 'TENANT_DEVICE';
    if (!['PROPERTY_DEVICE', 'TENANT_DEVICE'].includes(device.managementClass)
      || tenantOwned && !device.ownerMembershipId
      || !tenantOwned && device.ownerMembershipId !== null
      || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)
      || Number(payload.sourceGeneration) !== Number(input.identityGeneration)) return;
    const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
      ? device.capabilitySummary as Record<string, unknown> : {};
    const catalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
      ? summary.controlCatalog as Record<string, unknown> : null;
    const controls = Array.isArray(catalog?.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
    const control = controls.find((candidate) => candidate.controlId === payload.controlId);
    const safeRoles = new Set(['power', 'brightness', 'target_temperature', 'ambient_temperature', 'opening_percentage', 'position']);
    if (Number(catalog?.revision) !== device.descriptorRevision || catalog?.descriptorDigest !== device.descriptorDigest
      || Number(payload.descriptorRevision) !== device.descriptorRevision || !control
      || !safeRoles.has(String(control.semanticRole)) || control.readable !== true || control.observable !== true
      || control.stepUpPolicy === 'required' || ['sensitive', 'critical'].includes(String(control.riskLevel))
      || control.interactionKind === 'momentary_action') return;
    const observedAt = strictDate(payload.observedAt, now);
    const receivedAt = strictDate(payload.receivedAt, now);
    // validUntil is intentionally in the future. Validate its calendar value
    // here, then constrain it against observedAt and the live descriptor below;
    // strictDate's two-minute future-observation guard is for source/receipt
    // timestamps, not a descriptor-authorized validity deadline.
    const validUntil = new Date(String(payload.validUntil));
    if (!Number.isFinite(validUntil.getTime())) invalid('hub_sync_state_validity_invalid', 'The state validity deadline is invalid');
    const maximumValidity = Number(control.maxStateValiditySeconds) * 1000;
    if (!Number.isSafeInteger(control.maxStateValiditySeconds) || maximumValidity <= 0
      || validUntil <= observedAt || validUntil.getTime() > observedAt.getTime() + maximumValidity
      || receivedAt < observedAt) invalid('hub_sync_state_validity_invalid', 'The state observation validity does not match its current descriptor');
    const expectedAggregate = createHash('sha256').update(`${osDeviceId}\n${String(payload.controlId)}`, 'utf8').digest('hex');
    if (event.aggregateId !== expectedAggregate) invalid('hub_sync_state_identity_invalid', 'The state observation identity is invalid');
    const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId: String(payload.osAreaId) } }, select: { id: true, status: true } });
    if (!area || area.status !== 'ACTIVE') return;
    await requireAreaAssignmentAt(tx, { homeId, deviceId: device.id, areaId: area.id, at: observedAt });
    const activeAssignment = await tx.deviceAreaAssignment.findFirst({ where: {
      homeId, deviceId: device.id, areaId: area.id, validUntil: null, area: { status: 'ACTIVE' },
    }, select: { id: true } });
    if (!activeAssignment) return;
    if (tenantOwned) {
      const owner = await tx.homeMembership.findFirst({ where: {
        id: device.ownerMembershipId!, homeId, role: 'TENANT', status: 'ACTIVE',
        tenantAreaGrants: { some: { areaId: area.id, revokedAt: null, area: { status: 'ACTIVE' } } },
      }, select: { id: true } });
      if (!owner) return;
    }
    const allowedValue = payload.value === null || typeof payload.value === 'boolean'
      || typeof payload.value === 'number' && Number.isFinite(payload.value)
      || typeof payload.value === 'string' && [...payload.value].length <= 160;
    const valueMatches = payload.value === null
      ? ['unknown', 'unavailable'].includes(String(payload.quality))
      : control.valueType === 'boolean' ? typeof payload.value === 'boolean'
        : control.valueType === 'number' ? typeof payload.value === 'number'
          : control.valueType === 'option' ? ['string', 'number', 'boolean'].includes(typeof payload.value) : false;
    if (!allowedValue || !valueMatches) invalid('hub_sync_state_value_invalid', 'The state value does not match its current descriptor');
    const nextState: Record<string, unknown> = {
      deviceId: device.osDeviceId, controlId: String(payload.controlId), homeId,
      descriptorRevision: device.descriptorRevision, sourceGeneration: Number(payload.sourceGeneration),
      revision: Number(payload.revision),
      observedAt: observedAt.toISOString(), receivedAt: receivedAt.toISOString(), validUntil: validUntil.toISOString(),
      quality: String(payload.quality), value: payload.value,
      deviceAvailability: String(payload.deviceAvailability),
    };
    if (causeType) nextState.causeType = causeType;
    if (!tenantOwned) {
      const priorStates = summary.alexaStateByControl && typeof summary.alexaStateByControl === 'object' && !Array.isArray(summary.alexaStateByControl)
        ? summary.alexaStateByControl as Record<string, unknown> : {};
      const prior = priorStates[String(payload.controlId)] && typeof priorStates[String(payload.controlId)] === 'object'
        ? priorStates[String(payload.controlId)] as Record<string, unknown> : null;
      if (prior) {
        const priorObserved = Date.parse(String(prior.observedAt ?? ''));
        const priorRevision = Number(prior.revision);
        if (Number.isFinite(priorObserved) && (priorObserved > observedAt.getTime() || priorRevision > Number(payload.revision))) return;
        if (priorObserved === observedAt.getTime() && priorRevision === Number(payload.revision)) {
          // receivedAt describes transport delivery, not the underlying
          // observation. An exact source observation replay may arrive later
          // with a different receipt time; every authority/state field must
          // still match before it is treated as a duplicate.
          const priorComparable = { ...prior, receivedAt: nextState.receivedAt };
          if (canonicalSyncJson(priorComparable) !== canonicalSyncJson(nextState)) invalid('hub_sync_state_replay_conflict', 'A state observation revision was reused with different content');
          return;
        }
      }
      const nextStates = { ...priorStates, [String(payload.controlId)]: nextState };
      const boundedStates = Object.fromEntries(Object.entries(nextStates).slice(-64));
      await tx.nativeDevice.update({ where: { id: device.id }, data: {
        capabilitySummary: { ...summary, alexaStateByControl: boundedStates } as Prisma.InputJsonValue,
      } });
    }

    // Only queue a proactive report while its source observation can still be
    // considered current. The operations dispatcher performs full authority
    // revalidation again immediately before delivery.
    const policy = currentCustomerPolicy();
    if (!causeType || process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true' || !policy
      || observedAt.getTime() < now.getTime() - 120_000 || validUntil <= now) return;
    const endpoints = await tx.alexaNativeEndpointProjection.findMany({ where: {
      homeId, deviceId: device.id, areaId: area.id, status: 'ACTIVE', descriptorRevision: device.descriptorRevision,
      ...(tenantOwned ? { membershipId: device.ownerMembershipId! } : {}),
    }, select: { id: true, endpointId: true, linkId: true, homeId: true, membershipId: true, areaId: true } });
    for (const endpoint of endpoints) {
      const link = await tx.alexaNativeLink.findFirst({ where: {
        id: endpoint.linkId, status: 'ACTIVE', revokedAt: null,
        accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null },
        customerAccount: { status: 'ACTIVE', emailVerifiedAt: { not: null }, policyAcceptances: { some: {
          policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
        } } },
      }, select: { id: true, customerAccountId: true } });
      if (!link) continue;
      const membership = await tx.homeMembership.findFirst({ where: {
        id: endpoint.membershipId, homeId, customerAccountId: link.customerAccountId, role: 'TENANT', status: 'ACTIVE',
        tenantAreaGrants: { some: { areaId: area.id, revokedAt: null, area: { status: 'ACTIVE' } } },
      }, select: { id: true } });
      if (!membership) continue;
      const scope = await tx.alexaNativeHomeScope.findFirst({ where: {
        linkId: link.id, homeId, membershipId: membership.id, revokedAt: null,
        areaSelections: { some: { areaId: area.id, revokedAt: null } },
      }, select: { id: true } });
      if (!scope) continue;
      const observationKey = createHash('sha256').update([
        endpoint.id, event.id, String(payload.controlId), String(payload.revision), observedAt.toISOString(),
      ].join('\n'), 'utf8').digest('hex');
      await tx.nativeDomainOutbox.createMany({ data: [{
        homeId, hubInstallationId, aggregateType: 'AlexaChangeReport', aggregateId: endpoint.endpointId,
        eventType: 'ALEXA_CHANGE_REPORT', idempotencyKey: `alexa-change:${observationKey}`,
        payload: { endpointProjectionId: endpoint.id, linkId: link.id, homeId, membershipId: membership.id,
          areaId: area.id, deviceId: device.id, controlId: String(payload.controlId),
          descriptorRevision: device.descriptorRevision, sourceGeneration: Number(payload.sourceGeneration),
          stateRevision: Number(payload.revision), observedAt: observedAt.toISOString(), causeType,
          ...(tenantOwned ? { tenantOwned: true, ownerMembershipId: device.ownerMembershipId, tenantOwnedState: nextState } : {}) } as Prisma.InputJsonValue,
        state: 'PENDING', attempts: 0, nextAttemptAt: now,
        expiresAt: new Date(Math.min(validUntil.getTime(), now.getTime() + 24 * 60 * 60 * 1000)),
      }], skipDuplicates: true });
    }
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
    const retainedSummary = device.capabilitySummary as Record<string, unknown> | null;
    const conversion = retainedSummary?.logicalConversion as Record<string, unknown> | undefined;
    const convertedHistory = device.lifecycle === 'RETIRED' && conversion?.version === 1
      && Number.isFinite(Date.parse(String(conversion.cutoverAt)));
    if (device.managementClass !== 'PROPERTY_DEVICE'
      || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle) && !convertedHistory) return;
    if (Number(payload.sourceGeneration) !== Number(input.identityGeneration)) {
      if (payload.analyticsIntervalId) invalid('hub_sync_usage_generation_invalid', 'The analytics writer generation is not current');
      return;
    }
    const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
      ? device.capabilitySummary as Record<string, unknown> : {};
    const catalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
      ? summary.controlCatalog as Record<string, unknown> : null;
    const controls = Array.isArray(catalog?.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
    const roles = payload.analyticsCategory === 'LIGHT' ? ['power', 'brightness'] : payload.analyticsCategory === 'RADIATOR' ? ['active_heat_demand'] : ['active_heat_production'];
    const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId: String(payload.osAreaId) } }, select: { id: true } });
    if (!area) invalid('hub_sync_usage_area_invalid', 'The usage bucket area is not part of this home');
    const bucketStart = strictDate(payload.bucketStart, now);
    const where = { deviceId_areaId_analyticsCategory_controlId_bucketStart_sourceGeneration: {
      deviceId: device.id, areaId: area.id, analyticsCategory: payload.analyticsCategory as 'LIGHT' | 'BOILER' | 'RADIATOR',
      controlId: String(payload.controlId), bucketStart, sourceGeneration: Number(payload.sourceGeneration),
      bindingRevision: Number(payload.bindingRevision || 0),
    } };
    const previous = await tx.nativeDeviceUsageBucket.findUnique({ where, select: {
      id: true, revision: true, onSeconds: true, offSeconds: true, unknownSeconds: true,
      coverageStartAt: true, coverageEndAt: true, closedAt: true, purgeAt: true,
    } });
    const incomingRevision = Number(payload.revision);
    const closedAt = payload.closedAt === null ? null : strictDate(payload.closedAt, now);
    const purgeAt = new Date(String(payload.purgeAt));
    if (!Number.isFinite(purgeAt.getTime()) || purgeAt.getTime() !== oneCalendarYearAfter(bucketStart).getTime()) invalid('hub_sync_usage_purge_invalid', 'The usage bucket retention deadline is invalid');
    const data: { onSeconds: number; offSeconds: number; unknownSeconds: number; coverageStartAt: Date; coverageEndAt: Date; closedAt: Date | null; purgeAt: Date; revision: number } = {
      onSeconds: Number(payload.onSeconds), offSeconds: Number(payload.offSeconds), unknownSeconds: Number(payload.unknownSeconds),
      coverageStartAt: bucketStart, coverageEndAt: bucketStart, closedAt, purgeAt, revision: incomingRevision,
    };
    const totalSeconds = data.onSeconds + data.offSeconds + data.unknownSeconds;
    const legacyEnd = closedAt ?? new Date(bucketStart.getTime() + totalSeconds * 1000);
    const coverageStartAt = Object.hasOwn(payload, 'coverageStartAt') ? strictDate(payload.coverageStartAt, now)
      : new Date(legacyEnd.getTime() - totalSeconds * 1000);
    const coverageEndAt = Object.hasOwn(payload, 'coverageEndAt') ? strictDate(payload.coverageEndAt, now) : legacyEnd;
    // A converted parent is historical only: no post-cutover activity may be
    // accepted as measured. A boundary-straddling signed aggregate remains
    // unallocated under the original identity, never copied into its children.
    if (convertedHistory && coverageStartAt >= new Date(String(conversion!.cutoverAt))) return;
    const coveredMilliseconds = coverageEndAt.getTime() - coverageStartAt.getTime();
    if (coverageStartAt < bucketStart || coverageEndAt > new Date(bucketStart.getTime() + 3600000)
      || coverageEndAt <= coverageStartAt || coveredMilliseconds !== totalSeconds * 1000
      || closedAt && (closedAt.getTime() !== bucketStart.getTime() + 3600000 || coverageEndAt.getTime() !== closedAt.getTime())
      || !closedAt && totalSeconds >= 3600) {
      invalid('hub_sync_usage_bucket_closure_invalid', 'Usage counters must partition exactly their bounded covered span; closed buckets must end at the hour boundary');
    }
    await requireAreaAssignmentForCoverage(tx, { homeId, deviceId: device.id, areaId: area.id, start: coverageStartAt, end: coverageEndAt });
    const intervals = await tx.nativeAnalyticsInterval.findMany({ where: { deviceId: device.id, homeId, hubInstallationId }, orderBy: { revision: 'asc' }, take: 1001 });
    if (intervals.length > 1000) invalid('hub_sync_analytics_interval_limit', 'Analytics policy history requires maintenance');
    const newWriterFrom = intervals.map(row => row.newWriterFrom).filter((value): value is Date => value !== null).sort((a, b) => a.getTime() - b.getTime())[0];
    const authority = classifyUsageAuthority({ intervals, start: coverageStartAt, end: coverageEndAt, category: String(payload.analyticsCategory),
      controlId: String(payload.controlId), generation: Number(payload.sourceGeneration), intervalId: payload.analyticsIntervalId ? String(payload.analyticsIntervalId) : undefined,
      bindingRevision: Number(payload.bindingRevision || 0), newWriterFrom, analyticsPolicyVersion: Number(payload.analyticsPolicyVersion || 1) });
    if (authority.status === 'denied') invalid('hub_sync_analytics_interval_invalid', 'The usage interval does not authorize these measurements');
    const installationWriter = payload.analyticsIntervalId ? await tx.hubInstallation.findUnique({ where: { id: hubInstallationId }, select: { analyticsWriterEnabled: true } }) : null;
    const writerDisabled = Boolean(payload.analyticsIntervalId) && installationWriter?.analyticsWriterEnabled !== true;
    if (authority.status === 'unallocated' || writerDisabled || intervals.length === 0 && device.analyticsCategory !== payload.analyticsCategory) {
      const digest = createHash('sha256').update(canonicalSyncJson(payload)).digest('hex');
      const prior = await tx.nativeAnalyticsUnallocated.findUnique({ where: { hubInstallationId_eventId: { hubInstallationId, eventId: event.id } } });
      if (prior && prior.evidenceDigest !== digest) invalid('hub_sync_unallocated_conflict', 'Unallocated evidence is immutable');
      if (!prior) await tx.nativeAnalyticsUnallocated.create({ data: { homeId, hubInstallationId, deviceId: device.id, areaId: area.id,
        analyticsCategory: payload.analyticsCategory as 'LIGHT' | 'RADIATOR' | 'BOILER', eventId: event.id,
        evidenceDigest: digest, payload: payload as Prisma.InputJsonValue, reason: authority.reason || (writerDisabled ? 'writer_disabled' : 'legacy_authority_unverified'), coverageStartAt, coverageEndAt, purgeAt } });
      return;
    }
    const interval = intervals.find(row => payload.analyticsIntervalId ? row.id === payload.analyticsIntervalId
      : row.analyticsCategory === payload.analyticsCategory && row.sourceGeneration === Number(payload.sourceGeneration)
        && row.validFrom <= coverageStartAt && (!row.validUntil || row.validUntil >= coverageEndAt));
    const authorizedControls = interval && Array.isArray(interval.authorizedControls) ? interval.authorizedControls as Array<Record<string, unknown>> : controls;
    if (payload.analyticsIntervalId ? !allowedAnalyticsControls(String(payload.analyticsCategory), authorizedControls, interval?.selectedControlId ?? null).includes(String(payload.controlId))
      : !authorizedControls.some(control => control.controlId === payload.controlId && roles.includes(String(control.semanticRole)) && control.observable === true)) {
      invalid('hub_sync_analytics_control_invalid', 'The historical policy does not authorize this activity control');
    }
    if (payload.analyticsIntervalId) await tx.nativeAnalyticsInterval.updateMany({ where: { id: String(payload.analyticsIntervalId), newWriterFrom: null }, data: { newWriterFrom: coverageStartAt } });
    data.coverageStartAt = coverageStartAt; data.coverageEndAt = coverageEndAt;
    if (previous) {
      if (previous.revision > incomingRevision) return;
      if (previous.revision === incomingRevision) {
        const previousCoverageStart = previous.coverageStartAt ?? new Date((previous.closedAt ?? new Date(bucketStart.getTime() + totalSeconds * 1000)).getTime() - totalSeconds * 1000);
        const previousCoverageEnd = previous.coverageEndAt ?? previous.closedAt ?? new Date(bucketStart.getTime() + totalSeconds * 1000);
        if (previous.onSeconds !== data.onSeconds || previous.offSeconds !== data.offSeconds || previous.unknownSeconds !== data.unknownSeconds
          || previous.coverageStartAt && previous.coverageStartAt.getTime() !== coverageStartAt.getTime()
          || previous.coverageEndAt && previous.coverageEndAt.getTime() !== coverageEndAt.getTime()
          || previousCoverageStart.getTime() !== coverageStartAt.getTime() || previousCoverageEnd.getTime() !== coverageEndAt.getTime()
          || previous.closedAt?.getTime() !== closedAt?.getTime() || previous.purgeAt.getTime() !== purgeAt.getTime()) {
          invalid('hub_sync_usage_revision_conflict', 'A usage revision was reused with different absolute counters');
        }
        return;
      }
      if (previous.closedAt) invalid('hub_sync_usage_bucket_closed', 'A closed historical usage bucket is immutable');
      if (data.onSeconds < previous.onSeconds || data.offSeconds < previous.offSeconds || data.unknownSeconds < previous.unknownSeconds) {
        invalid('hub_sync_usage_counter_regression', 'Absolute usage counters cannot move backwards');
      }
      await tx.nativeDeviceUsageBucket.update({ where: { id: previous.id }, data });
      return;
    }
    await tx.nativeDeviceUsageBucket.create({ data: {
      homeId, deviceId: device.id, areaId: area.id, analyticsCategory: payload.analyticsCategory as 'LIGHT' | 'BOILER' | 'RADIATOR',
      controlId: String(payload.controlId), bucketStart, sourceGeneration: Number(payload.sourceGeneration), bindingRevision: Number(payload.bindingRevision || 0),
      analyticsPolicyVersion: Number(payload.analyticsPolicyVersion || 1), analyticsIntervalId: payload.analyticsIntervalId ? String(payload.analyticsIntervalId) : null, ...data,
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
    const historicalConversion = (device.capabilitySummary as Record<string, unknown> | null)?.logicalConversion as Record<string, unknown> | undefined;
    const conversionBoundary = historicalConversion?.version === 1 ? Date.parse(String(historicalConversion.cutoverAt)) : NaN;
    const historicalSample = device.lifecycle === 'RETIRED' && Number.isFinite(conversionBoundary)
      && Date.parse(String(payload.sourceObservedAt)) < conversionBoundary;
    if (device.managementClass !== 'PROPERTY_DEVICE' || device.analyticsCategory !== 'RADIATOR'
      || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle) && !historicalSample
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
    const evidencePolicy = payload.analyticsPolicyVersion === 3;
    const maximumValidityMs = evidencePolicy ? Math.min(65595 * 1000, Number(control.maxStateValiditySeconds) * 1000)
      : Math.min(30 * 60 * 1000, Number(control.maxStateValiditySeconds) * 1000);
    if (!Number.isSafeInteger(control.maxStateValiditySeconds) || maximumValidityMs <= 0
      || (evidencePolicy ? validUntil < observedAt : validUntil <= observedAt) || validUntil.getTime() > observedAt.getTime() + maximumValidityMs
      || observedAt > now || observedAt < oneCalendarYearBefore(now) || now >= oneCalendarYearAfter(observedAt)) return;
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
    const recent = historicalSample || device.radiatorReadingAt && device.radiatorReadingAt.getTime() >= observedAt.getTime();
    await tx.nativeTemperatureSample.create({ data: {
      homeId, deviceId: device.id, areaId: area.id, sourceEventKey: String(payload.sourceEventKey),
      temperature: Number(payload.temperature), sourceObservedAt: observedAt, validUntil,
      sourceGeneration: Number(payload.sourceGeneration), analyticsPolicyVersion: evidencePolicy ? 3 : 2, purgeAt: oneCalendarYearAfter(observedAt),
      ...(historicalSample && evidencePolicy && validUntil.getTime() > conversionBoundary
        ? { currentnessEndedAt: new Date(conversionBoundary) } : {}),
    } });
    if (!recent && now < validUntil) await tx.nativeDevice.update({ where: { id: device.id }, data: { radiatorTemperature: Number(payload.temperature), radiatorReadingAt: observedAt } });
    return;
  }

  if (event.type === 'automation.outcome') {
    const automation = await tx.nativeAutomation.findUnique({ where: { id: String(payload.automationId) }, select: { id: true, homeId: true, revision: true, createdByMembershipId: true } });
    if (!automation || automation.homeId !== homeId) invalid('hub_sync_automation_invalid', 'The automation outcome does not belong to this enrolled home');
    if (Number(payload.automationRevision) > automation.revision) invalid('hub_sync_automation_revision_invalid', 'The automation outcome is ahead of the current Platform definition');
    const idempotencyKey = `hub:${hubInstallationId}:${String(payload.occurrenceId)}`;
    const status = payload.status === 'succeeded' ? 'SUCCEEDED' : payload.status === 'partial' ? 'PARTIAL' : payload.status === 'interrupted' ? 'INTERRUPTED' : payload.status === 'skipped' ? 'SKIPPED' : 'FAILED';
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
    const execution = await tx.nativeAutomationExecution.create({ data: {
      automationId: automation.id, homeId, idempotencyKey, status,
      startedAt: strictDate(payload.startedAt, now), completedAt: strictDate(payload.completedAt, now), safeOutcome,
      purgeAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    } });
    if (['PARTIAL', 'FAILED', 'SKIPPED', 'INTERRUPTED'].includes(execution.status)) {
      await queueAutomationFailureNotices(tx, { homeId, automationId: automation.id,
        membershipId: automation.createdByMembershipId, occurrenceKey: idempotencyKey, now });
    }
    return;
  }

  if (event.type === 'incident.transition') {
    const incidentKey = String(payload.incidentKey);
    const revision = Number(payload.revision);
    const sourceKind = String(payload.kind);
    const prior = await tx.nativeDeviceOutageIncident.findUnique({
      where: { hubInstallationId_sourceIncidentKey: { hubInstallationId, sourceIncidentKey: incidentKey } },
      select: { id: true, sourceKind: true, sourceRevision: true },
    });
    if (prior && prior.sourceKind !== 'hub_unknown' && prior.sourceKind !== sourceKind) {
      invalid('hub_sync_incident_kind_conflict', 'A stable incident identity cannot change its source kind');
    }
    if (prior && prior.sourceRevision >= revision) {
      // Stage 5 introduced sourceKind after the original incident table. A
      // current signed revision can safely classify an older row without
      // rewinding its revision or replacing its original source event.
      if (prior.sourceKind === 'hub_unknown') await tx.nativeDeviceOutageIncident.updateMany({
        where: { id: prior.id, sourceKind: 'hub_unknown' }, data: { sourceKind },
      });
      return;
    }
    let deviceId: string | null = null;
    if (payload.osDeviceId !== null) {
      const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId, osDeviceId: String(payload.osDeviceId) } }, select: { id: true, homeId: true } });
      if (!device || device.homeId !== homeId) invalid('hub_sync_incident_device_invalid', 'The incident device is not part of this enrolled home');
      deviceId = device.id;
    }
    const firstObservedAt = strictDate(payload.firstObservedAt, now);
    strictDate(payload.lastObservedAt, now);
    const resolvedAt = payload.state === 'resolved' && payload.resolvedAt !== null ? strictDate(payload.resolvedAt, now) : null;
    const isHubIncident = /^(hub|integration)_/.test(sourceKind);
    const alertEligibleAt = new Date(firstObservedAt.getTime() + (isHubIncident ? 7 * 60_000 : 60 * 60_000));
    const data = {
      homeId,
      sourceIncidentKey: incidentKey,
      sourceKind,
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
