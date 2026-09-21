// Architecture: Shared platform helper src/lib/electricUsageConfig.ts; owns the server-side assumptions and deterministic time/math primitives for estimated lighting usage.

export const DEFAULT_TIME_ZONE = 'Europe/London';
export const MAX_AVERAGE_WATTS = 500;
export const MAX_ELECTRIC_PRICE_PER_KWH = 5;
export const DETAIL_RETENTION_DAYS = 400;
export const MAX_RETAINED_DAILY_YEARS = 7;

export type ElectricUsageConfig = {
  averageWatts: number | null;
  electricPricePerKwh: number | null;
  assumptionScope: 'portfolio_default';
};

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function readElectricUsageConfig(env: Record<string, unknown> = process.env): ElectricUsageConfig {
  const watts = finiteNumber(env.average_watts);
  const price = finiteNumber(env.electric_price_pkwh);
  return {
    averageWatts: watts != null && watts > 0 && watts <= MAX_AVERAGE_WATTS ? watts : null,
    electricPricePerKwh: price != null && price >= 0 && price <= MAX_ELECTRIC_PRICE_PER_KWH ? price : null,
    assumptionScope: 'portfolio_default',
  };
}

export function estimateLightKwh(averageWatts: number | null, onSeconds: number): number | null {
  if (averageWatts == null || !Number.isFinite(averageWatts) || averageWatts <= 0) return null;
  const seconds = Number(onSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return (averageWatts / 1000) * (seconds / 3600);
}

export function estimateLightCostGbp(
  estimatedKwh: number | null,
  electricPricePerKwh: number | null
): number | null {
  if (estimatedKwh == null || electricPricePerKwh == null) return null;
  if (!Number.isFinite(estimatedKwh) || !Number.isFinite(electricPricePerKwh) || estimatedKwh < 0 || electricPricePerKwh < 0) return null;
  return estimatedKwh * electricPricePerKwh;
}

export function normalizeTimeZone(value: unknown): string {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function localParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimeZone(timeZone),
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parsed = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parsed.year),
    month: Number(parsed.month),
    day: Number(parsed.day),
    hour: Number(parsed.hour),
    minute: Number(parsed.minute),
    second: Number(parsed.second),
  };
}

export function localDateKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localBucketKey(date: Date, bucket: 'daily' | 'weekly' | 'monthly', timeZone: string): string {
  const p = localParts(date, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (bucket === 'weekly') {
    const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    day.setUTCDate(day.getUTCDate() - (isoDay - 1));
  } else if (bucket === 'monthly') {
    day.setUTCDate(1);
  }
  return `${String(day.getUTCFullYear()).padStart(4, '0')}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
}

export function localBucketLabel(key: string, bucket: 'daily' | 'weekly' | 'monthly'): string {
  if (bucket === 'weekly') return `Week of ${key}`;
  if (bucket === 'monthly') {
    const [year, month] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
  }
  return key;
}

/** Convert a local calendar date at 00:00:00 into its UTC instant, including DST. */
export function localDateStartUtc(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) throw new Error('Invalid local date.');
  let guess = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 4; i += 1) {
    const p = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const wanted = Date.UTC(year, month - 1, day);
    guess += wanted - represented;
  }
  return new Date(guess);
}

export function localDateRangeToUtc(fromKey: string, toKey: string, timeZone: string): { from: Date; to: Date } {
  const from = localDateStartUtc(fromKey, timeZone);
  const nextDay = new Date(Date.UTC(Number(toKey.slice(0, 4)), Number(toKey.slice(5, 7)) - 1, Number(toKey.slice(8, 10)) + 1));
  const nextKey = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`;
  return { from, to: new Date(localDateStartUtc(nextKey, timeZone).getTime() - 1) };
}

function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function allocateInteger(total: number, weights: number[]): number[] {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const sum = weights.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (!safeTotal || !sum) return weights.map(() => 0);
  const exact = weights.map((weight) => (safeTotal * Math.max(0, weight)) / sum);
  const result = exact.map((value) => Math.floor(value));
  let remainder = safeTotal - result.reduce((acc, value) => acc + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) result[order[index % order.length].index] += 1;
  return result;
}

/**
 * Split one UTC interval into home-local calendar days. Duration fields keep
 * integer-second totals exactly; nullable estimates are split by the same
 * elapsed-time ratio and are not recalculated from rounded durations.
 */
export function splitElectricUsageRowByLocalDay<T extends {
  windowStartedAt: Date;
  windowEndedAt: Date;
  onForSeconds: number;
  offForSeconds: number;
  unknownForSeconds: number;
  estimatedKwh?: number | null;
  estimatedCostGbp?: number | null;
}>(row: T, timeZone: string) {
  const start = row.windowStartedAt instanceof Date ? row.windowStartedAt : new Date(row.windowStartedAt);
  const end = row.windowEndedAt instanceof Date ? row.windowEndedAt : new Date(row.windowEndedAt);
  const totalMs = end.getTime() - start.getTime();
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];
  const dates: Array<{ localDate: string; start: Date; end: Date; weight: number }> = [];
  let key = localDateKey(start, timeZone);
  for (let guard = 0; guard < 4 && key; guard += 1) {
    const nextKey = addCalendarDays(key, 1);
    const dayStart = localDateStartUtc(key, timeZone);
    const dayEnd = localDateStartUtc(nextKey, timeZone);
    const overlapStart = new Date(Math.max(start.getTime(), dayStart.getTime()));
    const overlapEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));
    if (overlapEnd.getTime() > overlapStart.getTime()) dates.push({ localDate: key, start: overlapStart, end: overlapEnd, weight: overlapEnd.getTime() - overlapStart.getTime() });
    if (end.getTime() <= dayEnd.getTime()) break;
    key = nextKey;
  }
  if (!dates.length) return [];
  const on = allocateInteger(row.onForSeconds, dates.map((item) => item.weight));
  const off = allocateInteger(row.offForSeconds, dates.map((item) => item.weight));
  const unknown = allocateInteger(row.unknownForSeconds, dates.map((item) => item.weight));
  return dates.map((item, index) => {
    const ratio = item.weight / totalMs;
    return {
      localDate: item.localDate,
      windowStartedAt: item.start,
      windowEndedAt: item.end,
      onForSeconds: on[index],
      offForSeconds: off[index],
      unknownForSeconds: unknown[index],
      estimatedKwh: row.estimatedKwh == null ? null : row.estimatedKwh * ratio,
      estimatedCostGbp: row.estimatedCostGbp == null ? null : row.estimatedCostGbp * ratio,
    };
  });
}
