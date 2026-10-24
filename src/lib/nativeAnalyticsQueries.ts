import { prisma } from './prisma';
import type { Prisma } from '@prisma/client';
import { currentNativeDisplayName } from './nativeDisplayNames';
import { aggregateNativeTemperature, aggregateNativeUsage, reconcileNativeUsageCoverage, NATIVE_EVIDENCE_TEMPERATURE_MAX_VALIDITY_MS, parseAnalyticsWindow, retentionStart, type NativeAnalyticsLevel, type NativeUsageRow } from './nativeAnalytics';
import { ANALYTICS_MAX_AREAS, ANALYTICS_MAX_DEVICES, ANALYTICS_MAX_ROWS, currentAnalyticsGroups, metricCategory, parseUuidList, type AnalyticsArea } from './nativeAnalyticsAccess';
import { Stage1AuthError } from './stage1Auth';

const displayName = (row: { originalName: string; overrideName: string | null }) => currentNativeDisplayName(row.originalName, row.overrideName);

function level(value: string | null): NativeAnalyticsLevel {
  const normalized = String(value ?? 'day').toLowerCase();
  if (['hour', 'day', 'week', 'month', 'year'].includes(normalized)) return normalized as NativeAnalyticsLevel;
  throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose a supported analytics interval');
}

function boundedQueryError() { return new Stage1AuthError(413, 'VALIDATION_FAILED', 'This history window is too large; choose a shorter period or fewer devices'); }

function assignmentForTemperatureSource(row: { deviceId: string; areaId: string; sourceObservedAt: Date },
  assignments: Array<{ deviceId: string; areaId: string; validFrom: Date; validUntil: Date | null }>) {
  const source = row.sourceObservedAt.getTime();
  return assignments.find((assignment) => assignment.deviceId === row.deviceId && assignment.areaId === row.areaId
    && assignment.validFrom.getTime() <= source && (assignment.validUntil === null || assignment.validUntil.getTime() > source));
}

function inCoverageAssignment(row: NativeUsageRow, assignments: Array<{ deviceId: string; areaId: string; validFrom: Date; validUntil: Date | null }>) {
  const bucketStart = new Date(row.bucketStart).getTime();
  const totalSeconds = row.onSeconds + row.offSeconds + row.unknownSeconds;
  const hasStart = row.coverageStartAt !== undefined && row.coverageStartAt !== null;
  const hasEnd = row.coverageEndAt !== undefined && row.coverageEndAt !== null;
  if (hasStart !== hasEnd || !Number.isSafeInteger(totalSeconds) || totalSeconds < 0) return false;
  const end = hasEnd ? new Date(row.coverageEndAt!).getTime()
    : row.closedAt ? new Date(row.closedAt).getTime() : bucketStart + totalSeconds * 1000;
  const start = hasStart ? new Date(row.coverageStartAt!).getTime() : end - totalSeconds * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  return assignments.some((assignment) => assignment.deviceId === row.deviceId && assignment.areaId === row.areaId
    && assignment.validFrom.getTime() <= start && (assignment.validUntil === null || assignment.validUntil.getTime() >= end));
}

export async function readNativeAnalyticsBootstrap(homeId: string, timezone: string, now = new Date()) {
  const cutoff = retentionStart(now);
  const [areaRows, devices, earliestUsage, earliestTemperature, latestTemperatureRows, retiredDevices] = await Promise.all([
    prisma.area.findMany({ where: { homeId, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: ANALYTICS_MAX_AREAS + 1,
      select: { id: true, originalName: true, overrideName: true, status: true, revision: true } }),
    prisma.nativeDevice.findMany({ where: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: { in: ['LIGHT', 'RADIATOR', 'BOILER'] },
      lifecycle: { notIn: ['RETIRED', 'REMOVED'] }, assignments: { some: { validUntil: null, area: { status: 'ACTIVE' } } } },
      orderBy: [{ installedAt: 'asc' }, { id: 'asc' }], take: ANALYTICS_MAX_DEVICES + 1,
      select: { id: true, originalName: true, overrideName: true, customerLabel: true, analyticsCategory: true, deviceType: true,
        assignments: { where: { validUntil: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } }),
    prisma.nativeDeviceUsageBucket.findFirst({ where: { homeId, bucketStart: { gte: cutoff, lte: now }, purgeAt: { gt: now },
      device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: { in: ['LIGHT', 'BOILER', 'RADIATOR'] } } }, area: { is: { homeId } } },
      orderBy: { bucketStart: 'asc' }, select: { bucketStart: true } }),
    prisma.nativeTemperatureSample.findFirst({ where: { homeId, sourceObservedAt: { gte: cutoff, lte: now }, purgeAt: { gt: now },
      device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR' } } }, orderBy: { sourceObservedAt: 'asc' }, select: { sourceObservedAt: true } }),
    prisma.nativeTemperatureSample.findMany({ where: { homeId, sourceObservedAt: { gte: new Date(Math.max(cutoff.getTime(), now.getTime() - NATIVE_EVIDENCE_TEMPERATURE_MAX_VALIDITY_MS)), lte: now }, purgeAt: { gt: now },
      device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR' } } }, orderBy: { sourceObservedAt: 'desc' }, take: ANALYTICS_MAX_ROWS + 1,
      select: { deviceId: true, areaId: true, temperature: true, sourceObservedAt: true, validUntil: true, currentnessEndedAt: true, analyticsPolicyVersion: true } }),
    prisma.nativeDevice.findMany({ where: { homeId, managementClass: 'PROPERTY_DEVICE', lifecycle: 'RETIRED',
      usageBuckets: { some: { homeId, bucketStart: { gte: cutoff, lte: now }, purgeAt: { gt: now } } } },
      orderBy: [{ retiredAt: 'desc' }, { id: 'asc' }], take: 100,
      select: { id: true, originalName: true, overrideName: true, analyticsCategory: true, retiredAt: true } }),
  ]);
  if (areaRows.length > ANALYTICS_MAX_AREAS || devices.length > ANALYTICS_MAX_DEVICES || latestTemperatureRows.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const latestTemperature = latestTemperatureRows[0] ?? null;
  const effectiveEnd = (sample: { validUntil: Date; currentnessEndedAt: Date | null }) =>
    sample.currentnessEndedAt && sample.currentnessEndedAt < sample.validUntil ? sample.currentnessEndedAt : sample.validUntil;
  const currentTemperatureCandidates = latestTemperatureRows.filter((sample) => sample.analyticsPolicyVersion === 3 && effectiveEnd(sample) > now);
  const temperatureAssignmentDeviceIds = [...new Set(currentTemperatureCandidates.map((sample) => sample.deviceId))];
  const temperatureAssignmentAreaIds = [...new Set(currentTemperatureCandidates.map((sample) => sample.areaId))];
  const currentTemperatureAssignments = temperatureAssignmentDeviceIds.length ? await prisma.deviceAreaAssignment.findMany({ where: {
    homeId, deviceId: { in: temperatureAssignmentDeviceIds }, areaId: { in: temperatureAssignmentAreaIds }, validFrom: { lte: now },
    OR: [{ validUntil: null }, { validUntil: { gte: now } }],
  }, select: { deviceId: true, areaId: true, validFrom: true, validUntil: true }, take: ANALYTICS_MAX_ROWS + 1 }) : [];
  if (currentTemperatureAssignments.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const currentTemperature = currentTemperatureCandidates.find((sample) => currentTemperatureAssignments.some((assignment) =>
    assignment.deviceId === sample.deviceId && assignment.areaId === sample.areaId
      && assignment.validFrom <= sample.sourceObservedAt && (assignment.validUntil === null || assignment.validUntil >= now))) ?? null;
  // No reading is current (the valve reports on change, so its newest value often ages past the 30-minute
  // window). Show the newest measured reading from a room this Home still uses, labelled stale with its time.
  // It is never presented as current, and nothing is inferred from an unrelated room or a removed Area.
  const activeRadiators = devices.filter((device) => device.analyticsCategory === 'RADIATOR');
  const lastTemperature = !currentTemperature && activeRadiators.length ? await prisma.nativeTemperatureSample.findFirst({ where: {
    homeId, deviceId: { in: activeRadiators.map((device) => device.id) }, sourceObservedAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), lte: now }, purgeAt: { gt: now },
    device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR' } } }, orderBy: { sourceObservedAt: 'desc' },
    select: { deviceId: true, areaId: true, temperature: true, sourceObservedAt: true, validUntil: true, currentnessEndedAt: true } }) : null;
  const lastIsCurrentlyAssigned = Boolean(lastTemperature && activeRadiators.some((device) => device.id === lastTemperature.deviceId
    && device.assignments.some((assignment) => assignment.areaId === lastTemperature.areaId)));
  const temperature = currentTemperature
    ? { latestCelsius: Number(currentTemperature.temperature), quality: 'fresh' as const,
        sourceAt: currentTemperature.sourceObservedAt.toISOString(), validUntil: effectiveEnd(currentTemperature).toISOString() }
    : lastTemperature && lastIsCurrentlyAssigned
      ? { latestCelsius: Number(lastTemperature.temperature), quality: 'stale' as const,
          sourceAt: lastTemperature.sourceObservedAt.toISOString(), validUntil: effectiveEnd(lastTemperature).toISOString() }
        : { latestCelsius: null, quality: 'unknown' as const,
          sourceAt: latestTemperature?.sourceObservedAt.toISOString() ?? null,
          validUntil: latestTemperature ? effectiveEnd(latestTemperature).toISOString() : null };
  const areas = areaRows as AnalyticsArea[];
  const groups = currentAnalyticsGroups(homeId, areas);
  const sevenDays = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const summaries = await Promise.all((['LIGHT', 'RADIATOR', 'BOILER'] as const).map(async (category) => {
    const rows = await prisma.nativeDeviceUsageBucket.findMany({ where: { homeId, analyticsCategory: category,
      bucketStart: { gte: sevenDays, lte: now }, purgeAt: { gt: now },
      device: { is: { homeId, managementClass: 'PROPERTY_DEVICE' } }, area: { is: { homeId } } },
      orderBy: { bucketStart: 'asc' }, take: ANALYTICS_MAX_ROWS + 1,
      select: { deviceId: true, areaId: true, bucketStart: true, coverageStartAt: true, coverageEndAt: true, closedAt: true, onSeconds: true, offSeconds: true, unknownSeconds: true } });
    if (rows.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
    return { metric: category.toLowerCase(), buckets: aggregateNativeUsage(rows, 'day', timezone) };
  }));
  const first = [earliestUsage?.bucketStart, earliestTemperature?.sourceObservedAt].filter((item): item is Date => Boolean(item)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return {
    schemaVersion: 'dinodia.v1', ok: true, homeId, timezone, generatedAt: now.toISOString(), retentionStartAt: cutoff.toISOString(),
    earliestAvailableAt: first?.toISOString() ?? null,
    areas: areas.filter((area) => area.status === 'ACTIVE').map((area) => ({ id: area.id, name: displayName(area), revision: area.revision })),
    displayGroups: groups,
    devices: devices.map((device) => ({ id: device.id, label: device.customerLabel ?? displayName(device), category: device.analyticsCategory.toLowerCase(), deviceType: device.deviceType,
      areaIds: device.assignments.map((assignment) => assignment.areaId) })),
    historicalDevices: retiredDevices.map((device) => ({ id: device.id, label: 'Retired device', category: device.analyticsCategory.toLowerCase(), retiredAt: device.retiredAt?.toISOString() ?? null })),
    summaries, temperature,
    historyState: first ? 'available' : 'empty',
  };
}

async function resolveFilters(homeId: string, search: URLSearchParams, metric: 'LIGHT' | 'RADIATOR' | 'BOILER' | 'TEMPERATURE') {
  const areaIds = parseUuidList(search.get('areaIds'), ANALYTICS_MAX_AREAS, 'Area');
  const deviceIds = parseUuidList(search.get('deviceIds'), ANALYTICS_MAX_DEVICES, 'device');
  const groupId = search.get('groupId');
  if (groupId && (areaIds || !/^analytics-group-[a-f0-9]{24}$/.test(groupId))) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose either current display group or Area filters');
  let resolvedAreaIds = areaIds;
  if (groupId) {
    const areas = await prisma.area.findMany({ where: { homeId, status: 'ACTIVE' }, take: ANALYTICS_MAX_AREAS + 1,
      select: { id: true, originalName: true, overrideName: true, status: true, revision: true } });
    if (areas.length > ANALYTICS_MAX_AREAS) throw boundedQueryError();
    const group = currentAnalyticsGroups(homeId, areas as AnalyticsArea[]).find((item) => item.id === groupId);
    if (!group) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Area group changed. Refresh the analytics filters.');
    resolvedAreaIds = group.areaIds;
  }
  if (resolvedAreaIds?.length) {
    const matches = await prisma.area.count({ where: { id: { in: resolvedAreaIds }, homeId } });
    if (matches !== resolvedAreaIds.length) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Analytics is not available for this selected Home');
  }
  if (deviceIds?.length) {
    const matches = await prisma.nativeDevice.findMany({ where: { id: { in: deviceIds }, homeId, managementClass: 'PROPERTY_DEVICE',
      ...(metric === 'TEMPERATURE' ? { analyticsCategory: 'RADIATOR' as const } : { OR: [{ analyticsCategory: metric }, { usageBuckets: { some: { homeId, analyticsCategory: metric } } }] }) }, select: { id: true } });
    if (matches.length !== deviceIds.length) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Analytics is not available for this selected Home');
  }
  return { areaIds: resolvedAreaIds, deviceIds };
}

export async function readNativeUsageDetail(homeId: string, timezone: string, search: URLSearchParams, now = new Date()) {
  const metric = metricCategory(search.get('metric') ?? '');
  if (metric === 'TEMPERATURE') throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Use the temperature history endpoint for Home Temperature');
  const interval = level(search.get('level'));
  const window = parseAnalyticsWindow({ from: search.get('from'), to: search.get('to') }, now);
  const filters = await resolveFilters(homeId, search, metric);
  const rows = await prisma.nativeDeviceUsageBucket.findMany({ where: { homeId, analyticsCategory: metric,
    bucketStart: { gte: window.from, lt: window.to }, purgeAt: { gt: now },
    ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}), ...(filters.deviceIds ? { deviceId: { in: filters.deviceIds } } : {}),
    device: { is: { homeId, managementClass: 'PROPERTY_DEVICE' } }, area: { is: { homeId } } },
    orderBy: [{ bucketStart: 'asc' }, { deviceId: 'asc' }], take: ANALYTICS_MAX_ROWS + 1,
      select: { deviceId: true, areaId: true, bucketStart: true, coverageStartAt: true, coverageEndAt: true, closedAt: true, onSeconds: true, offSeconds: true, unknownSeconds: true } });
  if (rows.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const candidateDeviceIds = [...new Set(rows.map((row) => row.deviceId))];
  const areaIds = [...new Set(rows.map((row) => row.areaId))];
  const assignments = candidateDeviceIds.length ? await prisma.deviceAreaAssignment.findMany({ where: { homeId, deviceId: { in: candidateDeviceIds }, areaId: { in: areaIds } },
    select: { deviceId: true, areaId: true, validFrom: true, validUntil: true }, take: ANALYTICS_MAX_ROWS + 1 }) : [];
  if (assignments.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const reconciled = reconcileNativeUsageCoverage(rows.filter((row) => inCoverageAssignment(row, assignments)));
  const eligible = reconciled.rows;
  const deviceIds = [...new Set(eligible.map((row) => row.deviceId))];
  const buckets = aggregateNativeUsage(eligible as NativeUsageRow[], interval, timezone)
    .map(bucket => reconciled.excludedDeviceHours ? { ...bucket, isPartial: true } : bucket);
  const responseDevices = deviceIds.length ? await prisma.nativeDevice.findMany({ where: { id: { in: deviceIds }, homeId, managementClass: 'PROPERTY_DEVICE' },
    select: { id: true, originalName: true, overrideName: true, lifecycle: true, customerLabel: true } }) : [];
  const coverageWhere: Prisma.NativeDeviceWhereInput = { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: metric,
    lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] }, ...(filters.deviceIds ? { id: { in: filters.deviceIds } } : {}),
    assignments: { some: { validUntil: null, area: { status: 'ACTIVE' }, ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}) } } };
  const [eligibleDeviceCount, reportingDeviceCount] = await Promise.all([
    prisma.nativeDevice.count({ where: coverageWhere }),
    prisma.nativeDevice.count({ where: { AND: [coverageWhere, { id: { in: deviceIds } }] } }),
  ]);
  const unallocatedEventCount = await prisma.nativeAnalyticsUnallocated.count({ where: { homeId, analyticsCategory: metric, coverageStartAt: { lt: window.to }, coverageEndAt: { gt: window.from },
    ...(filters.deviceIds ? { deviceId: { in: filters.deviceIds } } : {}), ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}) } });
  return { schemaVersion: 'dinodia.v1', ok: true, homeId, metric: metric.toLowerCase(), level: interval, timezone,
    from: window.from.toISOString(), to: window.to.toISOString(), retentionStartAt: window.retentionStart.toISOString(), generatedAt: now.toISOString(),
    coverageStatus: { eligibleDeviceCount, reportingDeviceCount, missingDeviceCount: Math.max(0, eligibleDeviceCount - reportingDeviceCount), unallocatedEventCount,
      excludedOverlapDeviceHours: reconciled.excludedDeviceHours },
    selectedDeviceCount: responseDevices.length, devices: responseDevices.map((device) => ({ id: device.id,
      label: ['RETIRED', 'REMOVED'].includes(device.lifecycle) ? 'Retired device' : device.customerLabel ?? displayName(device),
      historicalOnly: ['RETIRED', 'REMOVED'].includes(device.lifecycle) })), buckets };
}

export async function readNativeTemperatureDetail(homeId: string, timezone: string, search: URLSearchParams, now = new Date()) {
  const interval = level(search.get('level')); const window = parseAnalyticsWindow({ from: search.get('from'), to: search.get('to') }, now);
  const filters = await resolveFilters(homeId, search, 'TEMPERATURE');
  // Samples last at most 30 minutes. Include only this bounded look-behind
  // when their signed validity overlaps the requested window; this lets a
  // pre-midnight observation contribute to the next-day chart without
  // scanning unbounded history or extending its original deadline.
  const overlapStart = new Date(Math.max(window.retentionStart.getTime(), window.from.getTime() - NATIVE_EVIDENCE_TEMPERATURE_MAX_VALIDITY_MS));
  const rows = await prisma.nativeTemperatureSample.findMany({ where: { homeId,
    sourceObservedAt: { gte: overlapStart, lt: window.to }, validUntil: { gt: window.from },
    OR: [{ currentnessEndedAt: null }, { currentnessEndedAt: { gt: window.from } }], purgeAt: { gt: now },
    device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR' } }, area: { is: { homeId } },
    ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}), ...(filters.deviceIds ? { deviceId: { in: filters.deviceIds } } : {}) },
    orderBy: [{ sourceObservedAt: 'asc' }, { deviceId: 'asc' }], take: ANALYTICS_MAX_ROWS + 1,
    select: { deviceId: true, areaId: true, sourceObservedAt: true, validUntil: true, currentnessEndedAt: true, temperature: true, analyticsPolicyVersion: true } });
  if (rows.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const candidateDeviceIds = [...new Set(rows.map((row) => row.deviceId))];
  const areaIds = [...new Set(rows.map((row) => row.areaId))];
  const assignments = candidateDeviceIds.length ? await prisma.deviceAreaAssignment.findMany({ where: { homeId, deviceId: { in: candidateDeviceIds }, areaId: { in: areaIds } }, select: { deviceId: true, areaId: true, validFrom: true, validUntil: true }, take: ANALYTICS_MAX_ROWS + 1 }) : [];
  if (assignments.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const eligible = rows.flatMap((row) => {
    const assignment = assignmentForTemperatureSource(row, assignments);
    if (!assignment) return [];
    const evidenceEnd = row.currentnessEndedAt && row.currentnessEndedAt < row.validUntil ? row.currentnessEndedAt : row.validUntil;
    const validUntil = assignment.validUntil && assignment.validUntil < evidenceEnd ? assignment.validUntil : evidenceEnd;
    if (validUntil <= row.sourceObservedAt) return [];
    return [{ ...row, validUntil }];
  });
  const deviceIds = [...new Set(eligible.map((row) => row.deviceId))];
  const points = aggregateNativeTemperature(eligible.map((row) => ({ ...row, temperature: Number(row.temperature) })), interval, timezone, now, window);
  return { schemaVersion: 'dinodia.v1', ok: true, homeId, metric: 'temperature', level: interval, timezone,
    from: window.from.toISOString(), to: window.to.toISOString(), retentionStartAt: window.retentionStart.toISOString(), generatedAt: now.toISOString(),
    selectedDeviceCount: deviceIds.length, points };
}
