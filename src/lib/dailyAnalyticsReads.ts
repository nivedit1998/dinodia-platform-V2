import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { historyDay, historyWeek, historyYearCutoff } from './analyticsHistoryCalendar';
import { aggregateDailyUsage, aggregateDailyTemperature } from './dailyAnalyticsAggregation';
import { currentNativeDisplayName } from './nativeDisplayNames';
import { ANALYTICS_MAX_ROWS } from './nativeAnalyticsAccess';
import type { NativeAnalyticsLevel } from './nativeAnalytics';

export async function dailyReadState(homeId: string, timezone: string, now: Date) {
  const home = await prisma.home.findUnique({ where: { id: homeId }, select: { activeHubInstallationId: true } });
  const state = home?.activeHubInstallationId ? await prisma.nativeAnalyticsRetention.findUnique({ where: { hubInstallationId: home.activeHubInstallationId } }) : null;
  if (!state || (!state.readsEnabled && !state.prunedThrough && !state.compactionCursor) || !state.backfillVerifiedAt) return null;
  if (state.homeId !== homeId || state.timezone !== timezone) throw new Stage1AuthError(409, 'HISTORY_TIMEZONE_RECONCILIATION_REQUIRED', 'History retains its original Home timezone');
  const week = historyWeek(now.getTime(), timezone), cutoff = historyYearCutoff(now.getTime(), timezone);
  return { state, metadata: { historyResolutionVersion: 1, hourlyAvailableFrom: new Date(week.start).toISOString(),
    dailyAvailableFrom: new Date(cutoff).toISOString(), detailWeekEnd: new Date(week.end).toISOString(), timezone,
    temperatureAverageSemantics: 'duration_weighted_device_readings', temperatureCoverageBasis: 'device_time',
    retainedDetailDayCount: Array.isArray(state.retainedDetailDays) ? state.retainedDetailDays.length : 0,
    compactionBacklogReason: state.backlogReason } };
}
type Active = NonNullable<Awaited<ReturnType<typeof dailyReadState>>>;

export function dailyWindow(search: URLSearchParams, timezone: string, now: Date, active: Active) {
  const earliest = Date.parse(active.metadata.dailyAvailableFrom);
  const suppliedFrom = search.get('from'), suppliedTo = search.get('to');
  const from = suppliedFrom ? Date.parse(suppliedFrom) : earliest, to = suppliedTo ? Date.parse(suppliedTo) : now.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to > now.getTime() || from < earliest)
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose a retained calendar history window');
  const endDay = historyDay(to, timezone), today = historyDay(now.getTime(), timezone);
  if (to !== endDay.start && endDay.start !== today.start)
    throw new Stage1AuthError(400, 'DAILY_BOUNDARY_REQUIRED', 'Daily summaries require whole Home-local dates');
  return { from: new Date(historyDay(from, timezone).start), to: new Date(endDay.start === today.start ? now.getTime() : to), retentionStart: new Date(earliest) };
}

export function assertHourlyWindow(from: Date, active: Active) {
  if (from.getTime() < Date.parse(active.metadata.hourlyAvailableFrom)) throw new Stage1AuthError(409,
    'HISTORY_RESOLUTION_UNAVAILABLE', 'Daily history available. Hourly history is available for the current Monday–Sunday week.');
}

export async function readDailyDetail(input: { homeId: string; timezone: string; metric: 'LIGHT' | 'RADIATOR' | 'BOILER' | 'TEMPERATURE';
  interval: NativeAnalyticsLevel; search: URLSearchParams; filters: { areaIds?: string[] | null; deviceIds?: string[] | null }; active: Active; now: Date }) {
  const { homeId, timezone, metric, interval, filters, active, now } = input;
  const window = dailyWindow(input.search, timezone, now, active);
  const rows = await prisma.nativeAnalyticsDay.findMany({ where: { homeId,
    kind: metric === 'TEMPERATURE' ? 'TEMPERATURE' : 'USAGE', analyticsCategory: metric === 'TEMPERATURE' ? 'RADIATOR' : metric,
    dayStartAt: { gte: window.from, lt: window.to },
    ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}), ...(filters.deviceIds ? { deviceId: { in: filters.deviceIds } } : {}),
    device: { is: { homeId, hubInstallationId: active.state.hubInstallationId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null } },
    area: { is: { homeId } }, timezone }, orderBy: [{ dayStartAt: 'asc' }, { coverageStartAt: 'asc' }], take: ANALYTICS_MAX_ROWS + 1 });
  if (rows.length > ANALYTICS_MAX_ROWS) throw new Stage1AuthError(413, 'VALIDATION_FAILED', 'Choose a shorter history window or fewer devices');
  const candidateIds = [...new Set(rows.map(r => r.deviceId))];
  const assignments = candidateIds.length ? await prisma.deviceAreaAssignment.findMany({ where: { homeId,
    deviceId: { in: candidateIds }, validFrom: { lt: window.to }, OR: [{ validUntil: null }, { validUntil: { gt: window.from } }] }, take: ANALYTICS_MAX_ROWS + 1 }) : [];
  if (assignments.length > ANALYTICS_MAX_ROWS) throw new Stage1AuthError(413, 'VALIDATION_FAILED', 'Choose a shorter history window');
  const byDevice = new Map<string, typeof assignments>();
  for (const a of assignments) byDevice.set(a.deviceId, [...(byDevice.get(a.deviceId) || []), a]);
  const eligible = rows.filter(r => (byDevice.get(r.deviceId) || []).some(a => a.areaId === r.areaId
    && a.validFrom <= r.coverageStartAt && (!a.validUntil || a.validUntil >= r.coverageEndAt)));
  const temperatureRows = eligible.filter(r => Number(r.knownMilliseconds) > 0);
  const ids = [...new Set((metric === 'TEMPERATURE' ? temperatureRows : eligible).map(r => r.deviceId))];
  const common = { schemaVersion: 'dinodia.v1', ok: true, homeId, metric: metric.toLowerCase(), level: interval, timezone,
    from: window.from.toISOString(), to: window.to.toISOString(), retentionStartAt: window.retentionStart.toISOString(),
    generatedAt: now.toISOString(), historyResolution: active.metadata, selectedDeviceCount: ids.length };
  if (metric === 'TEMPERATURE') return { ...common, points: aggregateDailyTemperature(temperatureRows, interval, timezone) };
  const devices = ids.length ? await prisma.nativeDevice.findMany({ where: { id: { in: ids }, homeId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null },
    select: { id: true, originalName: true, overrideName: true, customerLabel: true, lifecycle: true } }) : [];
  const eligibleDeviceCount = await prisma.nativeDevice.count({ where: { homeId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null,
    analyticsCategory: metric, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] }, ...(filters.deviceIds ? { id: { in: filters.deviceIds } } : {}),
    assignments: { some: { validUntil: null, area: { status: 'ACTIVE' }, ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}) } } } });
  const reportingDeviceCount = await prisma.nativeDevice.count({ where: { homeId, id: { in: ids }, analyticsCategory: metric,
    managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] } } });
  const unallocatedEventCount = await prisma.nativeAnalyticsUnallocated.count({ where: { homeId, analyticsCategory: metric,
    coverageStartAt: { lt: window.to }, coverageEndAt: { gt: window.from },
    ...(filters.deviceIds ? { deviceId: { in: filters.deviceIds } } : {}), ...(filters.areaIds ? { areaId: { in: filters.areaIds } } : {}) } });
  return { ...common, devices: devices.map(d => ({ id: d.id, label: ['RETIRED', 'REMOVED'].includes(d.lifecycle) ? 'Retired device'
    : d.customerLabel ?? currentNativeDisplayName(d.originalName, d.overrideName), historicalOnly: ['RETIRED', 'REMOVED'].includes(d.lifecycle) })),
    coverageStatus: { eligibleDeviceCount, reportingDeviceCount, missingDeviceCount: Math.max(0, eligibleDeviceCount - reportingDeviceCount),
      unallocatedEventCount, excludedOverlapDeviceHours: 0 }, buckets: aggregateDailyUsage(eligible, interval, timezone, now) };
}
