import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { canonicalSyncJson, type HubSyncEvent } from './hubSyncEnvelope';
import { allowedAnalyticsControls, classifyUsageAuthority } from './analyticsIntervals';
import { historyYearCutoff } from './analyticsHistoryCalendar';

function reject(code: string): never {
  throw new Stage1AuthError(409, code, 'The daily analytics upload does not match its authorized history writer');
}

export async function ingestDailyAnalytics(tx: Prisma.TransactionClient, input: {
  event: HubSyncEvent; homeId: string; hubInstallationId: string; identityGeneration?: number;
  streamId?: string; now: Date;
}) {
  if (process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED !== 'true') reject('hub_sync_daily_disabled');
  const { homeId, hubInstallationId, event, now } = input;
  const p = event.payload;
  // The authenticated sync cursor serializes envelopes; this lock also serializes
  // writer activation/backfill and prevents a concurrent cutover during admission.
  await tx.$queryRaw`SELECT "hubInstallationId" FROM "NativeAnalyticsRetention"
    WHERE "hubInstallationId" = ${hubInstallationId}::uuid FOR UPDATE`;
  const retention = await tx.nativeAnalyticsRetention.findUnique({ where: { hubInstallationId } });
  const hub = await tx.hubInstallation.findUnique({ where: { id: hubInstallationId },
    select: { homeId: true, analyticsWriterEnabled: true } });
  if (!retention || retention.homeId !== homeId || hub?.homeId !== homeId
    || !retention.writerEnabled || !hub.analyticsWriterEnabled
    || retention.writerFrom.toISOString() !== p.writerFrom || retention.timezone !== p.timezone
    || retention.writerFrom > now) reject('hub_sync_daily_writer_invalid');

  if (event.type === 'analytics.daily.barrier') {
    if (!input.streamId) reject('hub_sync_daily_stream_invalid');
    if (retention.barrierStreamId) {
      if (retention.barrierStreamId !== input.streamId || retention.barrierSequence !== BigInt(event.sequence))
        reject('hub_sync_daily_barrier_conflict');
      return;
    }
    await tx.nativeAnalyticsRetention.update({ where: { hubInstallationId }, data: {
      barrierStreamId: input.streamId, barrierSequence: BigInt(event.sequence), legacySealedThrough: retention.writerFrom,
    } });
    return;
  }
  if (!retention.barrierStreamId || retention.barrierStreamId !== input.streamId
    || BigInt(event.sequence) <= retention.barrierSequence!) reject('hub_sync_daily_barrier_missing');

  const start = new Date(String(p.coverageStartAt)), end = new Date(String(p.coverageEndAt));
  const dayStart = new Date(String(p.dayStartAt));
  if (end > now || dayStart.getTime() < historyYearCutoff(now.getTime(), retention.timezone)
    || Number(p.sourceGeneration) !== input.identityGeneration) reject('hub_sync_daily_coverage_invalid');
  const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: {
    hubInstallationId, osDeviceId: String(p.osDeviceId),
  } } });
  if (!device || device.homeId !== homeId || device.managementClass !== 'PROPERTY_DEVICE'
    || device.ownerMembershipId || ['REMOVAL_PENDING', 'REMOVED'].includes(device.lifecycle)) reject('hub_sync_daily_device_invalid');
  const area = await tx.area.findUnique({ where: { homeId_osAreaId: { homeId, osAreaId: String(p.osAreaId) } } });
  if (!area || area.status !== 'ACTIVE') reject('hub_sync_daily_area_invalid');
  const assignment = await tx.deviceAreaAssignment.findFirst({ where: { homeId, deviceId: device.id, areaId: area.id,
    validFrom: { lte: start }, OR: [{ validUntil: null }, { validUntil: { gte: end } }],
  } });
  // Epoch identity must describe this assignment, not just a matching Area name
  // after a switch-back. The initial writer may start partway through an epoch.
  if (!assignment || new Date(String(p.assignmentEpochAt)).getTime() !== Math.max(Math.floor(assignment.validFrom.getTime() / 1000) * 1000, retention.writerFrom.getTime()))
    reject('hub_sync_daily_assignment_invalid');
  const intervals = await tx.nativeAnalyticsInterval.findMany({ where: { homeId, hubInstallationId, deviceId: device.id },
    orderBy: { revision: 'asc' }, take: 1001 });
  if (intervals.length > 1000) reject('hub_sync_daily_interval_limit');
  const interval = intervals.find(row => row.id === p.analyticsIntervalId && row.revision === p.bindingRevision
    && row.sourceGeneration === p.sourceGeneration && row.analyticsCategory === p.analyticsCategory
    && row.analyticsPolicyVersion === p.analyticsPolicyVersion && row.validFrom <= start && (!row.validUntil || row.validUntil >= end));
  const authority = classifyUsageAuthority({ intervals, start, end, category: String(p.analyticsCategory), controlId: String(p.controlId),
    generation: Number(p.sourceGeneration), intervalId: p.analyticsIntervalId ? String(p.analyticsIntervalId) : undefined,
    bindingRevision: Number(p.bindingRevision), analyticsPolicyVersion: Number(p.analyticsPolicyVersion) });
  const catalog = (device.capabilitySummary as Record<string, unknown> | null)?.controlCatalog as Record<string, unknown> | undefined;
  const controls = interval && Array.isArray(interval.authorizedControls)
    ? interval.authorizedControls as Array<Record<string, unknown>>
    : Array.isArray(catalog?.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
  const controlAllowed = p.kind === 'USAGE'
    ? allowedAnalyticsControls(String(p.analyticsCategory), controls, interval?.selectedControlId ?? null).includes(String(p.controlId))
    : String(p.analyticsCategory) === 'RADIATOR' && Array.isArray(catalog?.controls)
      && (catalog.controls as Array<Record<string, unknown>>).some(control => control.controlId === p.controlId
        && control.semanticRole === 'ambient_temperature' && control.observable === true && control.valueType === 'number');
  // Temperature has its own control, not the interval's selected activity signal.
  const temperatureIntervalAllowed = p.kind === 'TEMPERATURE' && intervals.some(row => row.id === p.analyticsIntervalId
    && row.revision === p.bindingRevision && row.analyticsCategory === 'RADIATOR' && row.sourceGeneration === p.sourceGeneration
    && row.analyticsPolicyVersion === p.analyticsPolicyVersion && row.validFrom <= start && (!row.validUntil || row.validUntil >= end));
  if (!controlAllowed || (p.kind === 'USAGE' ? authority.status !== 'accepted' : !temperatureIntervalAllowed && intervals.length > 0)
    || !intervals.length && device.analyticsCategory !== p.analyticsCategory) reject('hub_sync_daily_authority_invalid');
  const digest = createHash('sha256').update(canonicalSyncJson(p)).digest('hex');
  const where = { deviceId_areaId_kind_analyticsCategory_controlId_sourceGeneration_bindingRevision_dayStartAt_writerFrom_assignmentEpochAt_origin: {
    deviceId: device.id, areaId: area.id, kind: String(p.kind), analyticsCategory: p.analyticsCategory as 'LIGHT' | 'RADIATOR' | 'BOILER',
    controlId: String(p.controlId), sourceGeneration: Number(p.sourceGeneration), bindingRevision: Number(p.bindingRevision),
    dayStartAt: dayStart, writerFrom: retention.writerFrom, assignmentEpochAt: new Date(String(p.assignmentEpochAt)), origin: 'HUB',
  } };
  await tx.$queryRaw`SELECT id FROM "NativeDevice" WHERE id = ${device.id}::uuid FOR UPDATE`;
  const previous = await tx.nativeAnalyticsDay.findUnique({ where });
  if (previous && previous.revision > Number(p.revision)) return;
  if (previous?.revision === Number(p.revision)) {
    if (previous.payloadDigest !== digest) reject('hub_sync_daily_revision_conflict');
    return;
  }
  if (previous && (start.getTime() !== previous.coverageStartAt.getTime() || end < previous.coverageEndAt))
    reject('hub_sync_daily_coverage_regression');
  const overlapping = await tx.nativeAnalyticsDay.findFirst({ where: { deviceId: device.id, kind: String(p.kind), origin: 'HUB',
    ...(previous ? { id: { not: previous.id } } : {}), coverageStartAt: { lt: end }, coverageEndAt: { gt: start },
  }, select: { id: true } });
  if (overlapping) reject('hub_sync_daily_overlap');
  const purgeAt = new Date(dayStart); purgeAt.setUTCFullYear(purgeAt.getUTCFullYear() + 1);
  const data = { homeId, ...where.deviceId_areaId_kind_analyticsCategory_controlId_sourceGeneration_bindingRevision_dayStartAt_writerFrom_assignmentEpochAt_origin,
    analyticsIntervalId: p.analyticsIntervalId ? String(p.analyticsIntervalId) : null, analyticsPolicyVersion: Number(p.analyticsPolicyVersion),
    timezone: retention.timezone, dayEndAt: new Date(String(p.dayEndAt)), revision: Number(p.revision),
    onSeconds: Number(p.onSeconds), offSeconds: Number(p.offSeconds), unknownSeconds: Number(p.unknownSeconds),
    knownMilliseconds: BigInt(Number(p.knownMilliseconds)), celsiusMilliseconds: Number(p.celsiusMilliseconds),
    minimumCelsius: p.minimumCelsius === null ? null : Number(p.minimumCelsius), maximumCelsius: p.maximumCelsius === null ? null : Number(p.maximumCelsius),
    sampleCount: Number(p.sampleCount), lastCelsius: p.lastCelsius === null ? null : Number(p.lastCelsius),
    lastObservedAt: p.lastObservedAt === null ? null : new Date(String(p.lastObservedAt)),
    lastValidUntil: p.lastValidUntil === null ? null : new Date(String(p.lastValidUntil)),
    coverageStartAt: start, coverageEndAt: end, payloadDigest: digest, verifiedAt: null, purgeAt,
  };
  // Newer absolute snapshots replace a fragment. They are never added to its
  // earlier revision, including after a lost response or a delayed correction.
  if (previous) await tx.nativeAnalyticsDay.update({ where: { id: previous.id }, data });
  else await tx.nativeAnalyticsDay.create({ data });
}
