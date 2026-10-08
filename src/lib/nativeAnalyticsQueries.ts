import { prisma } from './prisma';
import { currentNativeDisplayName } from './nativeDisplayNames';
import { aggregateNativeTemperature, aggregateNativeUsage, parseAnalyticsWindow, retentionStart, type NativeAnalyticsLevel, type NativeUsageRow } from './nativeAnalytics';
import { ANALYTICS_MAX_AREAS, ANALYTICS_MAX_DEVICES, ANALYTICS_MAX_ROWS, currentAnalyticsGroups, metricCategory, parseUuidList, type AnalyticsArea } from './nativeAnalyticsAccess';
import { Stage1AuthError } from './stage1Auth';

const displayName = (row: { originalName: string; overrideName: string | null }) => currentNativeDisplayName(row.originalName, row.overrideName);

function level(value: string | null): NativeAnalyticsLevel {
  const normalized = String(value ?? 'day').toLowerCase();
  if (['hour', 'day', 'week', 'month', 'year'].includes(normalized)) return normalized as NativeAnalyticsLevel;
  throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose a supported analytics interval');
}

function boundedQueryError() { return new Stage1AuthError(413, 'VALIDATION_FAILED', 'This history window is too large; choose a shorter period or fewer devices'); }

function inWindowAssignment(row: { deviceId: string; areaId: string; bucketStart: Date }, assignments: Array<{ deviceId: string; areaId: string; validFrom: Date; validUntil: Date | null }>) {
  const time = row.bucketStart.getTime();
  return assignments.some((assignment) => assignment.deviceId === row.deviceId && assignment.areaId === row.areaId
    && assignment.validFrom.getTime() <= time && (assignment.validUntil === null || assignment.validUntil.getTime() > time));
}

export async function readNativeAnalyticsBootstrap(homeId: string, timezone: string, now = new Date()) {
  const cutoff = retentionStart(now);
  const [areaRows, devices, earliestUsage, earliestTemperature, latestTemperature, retiredDevices] = await Promise.all([
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
    prisma.nativeTemperatureSample.findFirst({ where: { homeId, sourceObservedAt: { gte: cutoff, lte: now }, purgeAt: { gt: now },
      device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR' } } }, orderBy: { sourceObservedAt: 'desc' },
      select: { temperature: true, sourceObservedAt: true, validUntil: true } }),
    prisma.nativeDevice.findMany({ where: { homeId, managementClass: 'PROPERTY_DEVICE', lifecycle: 'RETIRED',
      usageBuckets: { some: { homeId, bucketStart: { gte: cutoff, lte: now }, purgeAt: { gt: now } } } },
      orderBy: [{ retiredAt: 'desc' }, { id: 'asc' }], take: 100,
      select: { id: true, originalName: true, overrideName: true, analyticsCategory: true, retiredAt: true } }),
  ]);
  if (areaRows.length > ANALYTICS_MAX_AREAS || devices.length > ANALYTICS_MAX_DEVICES) throw boundedQueryError();
  const areas = areaRows as AnalyticsArea[];
  const groups = currentAnalyticsGroups(homeId, areas);
  const sevenDays = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const summaries = await Promise.all((['LIGHT', 'RADIATOR', 'BOILER'] as const).map(async (category) => {
    const rows = await prisma.nativeDeviceUsageBucket.findMany({ where: { homeId, analyticsCategory: category,
      bucketStart: { gte: sevenDays, lte: now }, purgeAt: { gt: now },
      device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: category } }, area: { is: { homeId } } },
      orderBy: { bucketStart: 'asc' }, take: ANALYTICS_MAX_ROWS + 1,
      select: { deviceId: true, areaId: true, bucketStart: true, closedAt: true, onSeconds: true, offSeconds: true, unknownSeconds: true } });
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
    summaries, temperature: { latestCelsius: latestTemperature && now < latestTemperature.validUntil ? Number(latestTemperature.temperature) : null,
      quality: !latestTemperature ? 'unknown' : now < latestTemperature.validUntil ? 'fresh' : 'stale',
      sourceAt: latestTemperature?.sourceObservedAt.toISOString() ?? null },
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
    const matches = await prisma.nativeDevice.findMany({ where: { id: { in: deviceIds }, homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: metric === 'TEMPERATURE' ? 'RADIATOR' : metric }, select: { id: true } });
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
    device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: metric } }, area: { is: { homeId } } },
    orderBy: [{ bucketStart: 'asc' }, { deviceId: 'asc' }], take: ANALYTICS_MAX_ROWS + 1,
    select: { deviceId: true, areaId: true, bucketStart: true, closedAt: true, onSeconds: true, offSeconds: true, unknownSeconds: true } });
  if (rows.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const candidateDeviceIds = [...new Set(rows.map((row) => row.deviceId))];
  const areaIds = [...new Set(rows.map((row) => row.areaId))];
  const assignments = candidateDeviceIds.length ? await prisma.deviceAreaAssignment.findMany({ where: { homeId, deviceId: { in: candidateDeviceIds }, areaId: { in: areaIds } },
    select: { deviceId: true, areaId: true, validFrom: true, validUntil: true }, take: ANALYTICS_MAX_ROWS + 1 }) : [];
  if (assignments.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const eligible = rows.filter((row) => inWindowAssignment(row, assignments));
  const deviceIds = [...new Set(eligible.map((row) => row.deviceId))];
  const buckets = aggregateNativeUsage(eligible as NativeUsageRow[], interval, timezone);
  const responseDevices = deviceIds.length ? await prisma.nativeDevice.findMany({ where: { id: { in: deviceIds }, homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: metric },
    select: { id: true, originalName: true, overrideName: true, lifecycle: true, customerLabel: true } }) : [];
  return { schemaVersion: 'dinodia.v1', ok: true, homeId, metric: metric.toLowerCase(), level: interval, timezone,
    from: window.from.toISOString(), to: window.to.toISOString(), retentionStartAt: window.retentionStart.toISOString(), generatedAt: now.toISOString(),
    selectedDeviceCount: responseDevices.length, devices: responseDevices.map((device) => ({ id: device.id,
      label: ['RETIRED', 'REMOVED'].includes(device.lifecycle) ? 'Retired device' : device.customerLabel ?? displayName(device),
      historicalOnly: ['RETIRED', 'REMOVED'].includes(device.lifecycle) })), buckets };
}

export async function readNativeTemperatureDetail(homeId: string, timezone: string, search: URLSearchParams, now = new Date()) {
  const interval = level(search.get('level')); const window = parseAnalyticsWindow({ from: search.get('from'), to: search.get('to') }, now);
  const filters = await resolveFilters(homeId, search, 'TEMPERATURE');
  const rows = await prisma.nativeTemperatureSample.findMany({ where: { homeId, sourceObservedAt: { gte: window.from, lt: window.to }, purgeAt: { gt: now },
    device: { is: { homeId, managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR' } }, area: { is: { homeId } },
    ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}), ...(filters.deviceIds ? { deviceId: { in: filters.deviceIds } } : {}) },
    orderBy: [{ sourceObservedAt: 'asc' }, { deviceId: 'asc' }], take: ANALYTICS_MAX_ROWS + 1,
    select: { deviceId: true, areaId: true, sourceObservedAt: true, validUntil: true, temperature: true } });
  if (rows.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const candidateDeviceIds = [...new Set(rows.map((row) => row.deviceId))];
  const areaIds = [...new Set(rows.map((row) => row.areaId))];
  const assignments = candidateDeviceIds.length ? await prisma.deviceAreaAssignment.findMany({ where: { homeId, deviceId: { in: candidateDeviceIds }, areaId: { in: areaIds } }, select: { deviceId: true, areaId: true, validFrom: true, validUntil: true }, take: ANALYTICS_MAX_ROWS + 1 }) : [];
  if (assignments.length > ANALYTICS_MAX_ROWS) throw boundedQueryError();
  const eligible = rows.filter((row) => inWindowAssignment({ deviceId: row.deviceId, areaId: row.areaId, bucketStart: row.sourceObservedAt }, assignments));
  const deviceIds = [...new Set(eligible.map((row) => row.deviceId))];
  const points = aggregateNativeTemperature(eligible.map((row) => ({ ...row, temperature: Number(row.temperature) })), interval, timezone, now);
  return { schemaVersion: 'dinodia.v1', ok: true, homeId, metric: 'temperature', level: interval, timezone,
    from: window.from.toISOString(), to: window.to.toISOString(), retentionStartAt: window.retentionStart.toISOString(), generatedAt: now.toISOString(),
    selectedDeviceCount: deviceIds.length, points };
}
