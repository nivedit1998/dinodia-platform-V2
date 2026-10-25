import { usagePeriod, type NativeAnalyticsLevel } from './nativeAnalytics';
import { historyDay } from './analyticsHistoryCalendar';

export type DailyRow = {
  deviceId: string; areaId: string; timezone: string; dayStartAt: Date; dayEndAt: Date;
  coverageStartAt: Date; coverageEndAt: Date;
  onSeconds: number; offSeconds: number; unknownSeconds: number;
  knownMilliseconds: bigint | number; celsiusMilliseconds: unknown;
  minimumCelsius: unknown; maximumCelsius: unknown; sampleCount: number;
  lastObservedAt: Date | null; lastValidUntil: Date | null; lastCelsius: unknown;
};
type Period = ReturnType<typeof usagePeriod>;
const round = (value: number) => Math.round(value * 100) / 100;
const wholeMinutes = (value: number) => Math.floor(value + 0.5);
function periodFor(row: DailyRow, level: NativeAnalyticsLevel, timezone: string) {
  if (level === 'hour') throw new TypeError('Daily summaries cannot reconstruct hourly history');
  if (row.timezone !== timezone) throw new TypeError('Compacted history cannot be reinterpreted in another timezone');
  const day = historyDay(row.dayStartAt.getTime(), timezone);
  if (day.start !== row.dayStartAt.getTime() || day.end !== row.dayEndAt.getTime()) throw new TypeError('Invalid daily calendar boundary');
  return usagePeriod({ deviceId: row.deviceId, areaId: row.areaId, bucketStart: row.dayStartAt,
    closedAt: null, onSeconds: 0, offSeconds: 0, unknownSeconds: 0 }, level, timezone);
}

/** Epoch fragments share one device-local-day denominator. Never average averages. */
export function aggregateDailyUsage(rows: readonly DailyRow[], level: NativeAnalyticsLevel, timezone: string, now: Date) {
  const periods = new Map<string, { period: Period; samples: Set<string>; on: number; off: number; unknown: number;
    partial: boolean; coverageByDay: Map<string, number>; expectedByDay: Map<string, number> }>();
  for (const row of rows) {
    const period = periodFor(row, level, timezone);
    const span = row.coverageEndAt.getTime() - row.coverageStartAt.getTime();
    const counters = [row.onSeconds, row.offSeconds, row.unknownSeconds];
    if (counters.some(n => !Number.isSafeInteger(n) || n < 0) || counters.reduce((a, b) => a + b, 0) * 1000 !== span
      || row.coverageStartAt < row.dayStartAt || row.coverageEndAt > row.dayEndAt || row.coverageEndAt > now)
      throw new TypeError('Invalid daily usage coverage');
    const entry = periods.get(period.key) || { period, samples: new Set(), on: 0, off: 0, unknown: 0, partial: false,
      coverageByDay: new Map(), expectedByDay: new Map() };
    const identity = `${row.deviceId}|${row.dayStartAt.toISOString()}`;
    entry.samples.add(identity);
    entry.on += row.onSeconds; entry.off += row.offSeconds; entry.unknown += row.unknownSeconds;
    entry.coverageByDay.set(identity, (entry.coverageByDay.get(identity) || 0) + span);
    entry.expectedByDay.set(identity, row.dayEndAt.getTime() - row.dayStartAt.getTime());
    // Present-day contributions are provisional, not 24 hours of Unknown.
    entry.partial ||= row.dayEndAt > now;
    periods.set(period.key, entry);
  }
  return [...periods.values()].sort((a, b) => a.period.start.localeCompare(b.period.start)).map(entry => {
    const count = entry.samples.size;
    const incomplete = [...entry.coverageByDay].some(([identity, covered]) => covered < entry.expectedByDay.get(identity)!);
    return { id: entry.period.key, start: entry.period.start, end: entry.period.end, label: entry.period.label,
      // Clients decode minutes as integers; match the hourly path rounding exactly.
      onMinutes: wholeMinutes(entry.on / 60 / count), offMinutes: wholeMinutes(entry.off / 60 / count), unknownMinutes: wholeMinutes(entry.unknown / 60 / count),
      coverageSeconds: entry.on + entry.off + entry.unknown, contributingDeviceDays: count, isPartial: entry.partial || incomplete };
  });
}

/** Owner-approved device-duration mean; no invented wall-clock segments. */
export function aggregateDailyTemperature(rows: readonly DailyRow[], level: NativeAnalyticsLevel, timezone: string) {
  const periods = new Map<string, { period: Period; integral: number; known: number; count: number;
    min: number; max: number; latest: DailyRow }>();
  for (const row of rows) {
    const period = periodFor(row, level, timezone);
    const known = Number(row.knownMilliseconds), integral = Number(row.celsiusMilliseconds);
    if (!Number.isSafeInteger(known) || known <= 0 || !Number.isFinite(integral)
      || !row.lastObservedAt || !row.lastValidUntil) throw new TypeError('Invalid daily temperature statistics');
    const entry = periods.get(period.key) || { period, integral: 0, known: 0, count: 0,
      min: Infinity, max: -Infinity, latest: row };
    entry.integral += integral; entry.known += known; entry.count += row.sampleCount;
    entry.min = Math.min(entry.min, Number(row.minimumCelsius)); entry.max = Math.max(entry.max, Number(row.maximumCelsius));
    if (row.lastObservedAt > entry.latest.lastObservedAt!) entry.latest = row;
    periods.set(period.key, entry);
  }
  return [...periods.values()].sort((a, b) => a.period.start.localeCompare(b.period.start)).map(entry => ({
    id: entry.period.key, start: entry.period.start, end: entry.period.end, label: entry.period.label,
    celsius: round(entry.integral / entry.known), sampleCount: entry.count,
    sourceAt: entry.latest.lastObservedAt!.toISOString(), validUntil: entry.latest.lastValidUntil!.toISOString(),
    currentFresh: false, coverageSeconds: Math.floor(entry.known / 1000), knownDeviceSeconds: entry.known / 1000,
    coverageBasis: 'device_time', averageSemantics: 'duration_weighted_device_readings',
    minimumCelsius: entry.min, maximumCelsius: entry.max, segments: [],
  }));
}
