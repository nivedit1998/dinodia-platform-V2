export type NativeAnalyticsMetric = 'LIGHT' | 'RADIATOR' | 'BOILER' | 'TEMPERATURE';
export type NativeAnalyticsLevel = 'hour' | 'day' | 'week' | 'month' | 'year';

export type NativeUsageRow = {
  deviceId: string; areaId: string; bucketStart: Date | string; closedAt: Date | string | null;
  coverageStartAt?: Date | string | null; coverageEndAt?: Date | string | null;
  onSeconds: number; offSeconds: number; unknownSeconds: number;
};

export type NativeTemperatureRow = {
  deviceId: string; areaId: string; sourceObservedAt: Date | string;
  validUntil: Date | string; temperature: number | string; analyticsPolicyVersion?: number;
};

export const NATIVE_TEMPERATURE_MAX_VALIDITY_MS = 30 * 60 * 1000;
export const NATIVE_EVIDENCE_TEMPERATURE_MAX_VALIDITY_MS = 65595 * 1000;

export function validAnalyticsTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}

function parts(date: Date, timezone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

function localMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  // Resolve local midnight by correcting the difference between the requested
  // wall-clock and the actual wall-clock at the candidate instant. This keeps
  // 23/25-hour DST days as real elapsed-time periods.
  for (let index = 0; index < 4; index += 1) {
    const actual = parts(new Date(guess), timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const delta = target - represented;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

function localDateKey(p: ReturnType<typeof parts>) { return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }

function localWeekStart(p: ReturnType<typeof parts>) {
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function usagePeriod(row: NativeUsageRow, level: NativeAnalyticsLevel, timezone: string) {
  const start = new Date(row.bucketStart);
  const p = parts(start, timezone);
  if (level === 'hour') {
    const iso = start.toISOString();
    return { key: iso, start: iso, end: new Date(start.getTime() + 3_600_000).toISOString(), label: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(start), localDay: localDateKey(p) };
  }
  let first: { year: number; month: number; day: number };
  let next: { year: number; month: number; day: number };
  let key: string;
  let label: string;
  if (level === 'day') {
    first = { year: p.year, month: p.month, day: p.day };
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1)); next = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    key = localDateKey(p); label = key;
  } else if (level === 'week') {
    first = localWeekStart(p);
    const d = new Date(Date.UTC(first.year, first.month - 1, first.day + 7)); next = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    key = `week:${first.year}-${String(first.month).padStart(2, '0')}-${String(first.day).padStart(2, '0')}`; label = key.slice(5);
  } else if (level === 'month') {
    first = { year: p.year, month: p.month, day: 1 };
    const d = new Date(Date.UTC(p.year, p.month, 1)); next = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 };
    key = `${p.year}-${String(p.month).padStart(2, '0')}`; label = key;
  } else {
    first = { year: p.year, month: 1, day: 1 }; next = { year: p.year + 1, month: 1, day: 1 };
    key = String(p.year); label = key;
  }
  const periodStart = localMidnightUtc(first.year, first.month, first.day, timezone);
  const periodEnd = localMidnightUtc(next.year, next.month, next.day, timezone);
  return { key, start: periodStart.toISOString(), end: periodEnd.toISOString(), label, localDay: localDateKey(p) };
}

const rounded = (value: number) => Math.floor(value + 0.5);

/**
 * Mirrors the frozen V2 rules: hourly buckets sum selected-device durations;
 * larger buckets average each contributing device's local-day sample. Missing
 * source rows remain gaps and are never synthesized as Off/zero.
 */
export function reconcileNativeUsageCoverage(rows: readonly NativeUsageRow[]) {
  const spansByDeviceHour = new Map<string, Array<[number, number]>>();
  const excluded = new Set<string>();
  const validated: Array<{ row: NativeUsageRow; identity: string; sum: number }> = [];
  for (const row of rows) {
    const start = new Date(row.bucketStart);
    if (!Number.isFinite(start.getTime()) || ![row.onSeconds, row.offSeconds, row.unknownSeconds].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('Invalid usage row');
    const sum = row.onSeconds + row.offSeconds + row.unknownSeconds;
    if (sum > 3600) throw new TypeError('Invalid usage partition');
    const closed = row.closedAt === null ? null : new Date(row.closedAt);
    const hasStart = row.coverageStartAt !== undefined && row.coverageStartAt !== null;
    const hasEnd = row.coverageEndAt !== undefined && row.coverageEndAt !== null;
    if (hasStart !== hasEnd) throw new TypeError('Incomplete usage coverage metadata');
    const coverageEnd = hasEnd ? new Date(row.coverageEndAt!) : closed ?? new Date(start.getTime() + sum * 1000);
    const coverageStart = hasStart ? new Date(row.coverageStartAt!) : new Date(coverageEnd.getTime() - sum * 1000);
    if (!Number.isFinite(coverageStart.getTime()) || !Number.isFinite(coverageEnd.getTime())
      || coverageStart < start || coverageEnd > new Date(start.getTime() + 3600000) || coverageEnd <= coverageStart
      || coverageEnd.getTime() - coverageStart.getTime() !== sum * 1000
      || (closed && (closed.getTime() !== start.getTime() + 3600000 || closed.getTime() !== coverageEnd.getTime()))) throw new TypeError('Invalid usage coverage span');
    const identity = `${row.deviceId}:${start.toISOString()}`;
    const spans = spansByDeviceHour.get(identity) ?? [];
    if (spans.some(([from, to]) => from < coverageEnd.getTime() && to > coverageStart.getTime())) excluded.add(identity);
    spans.push([coverageStart.getTime(), coverageEnd.getTime()]); spansByDeviceHour.set(identity, spans);
    validated.push({ row, identity, sum });
  }
  // Absolute counters cannot be truthfully split to resolve overlapping spans.
  // Exclude the entire affected physical device-hour, independently of row order.
  // Do not leak device identities or fabricate Unknown/Off measurements.
  if (excluded.size) console.warn('analytics_usage_overlap_excluded', { deviceHourCount: excluded.size });
  return { rows: validated.filter(item => !excluded.has(item.identity)).map(item => item.row), excludedDeviceHours: excluded.size };
}

export function aggregateNativeUsage(rows: readonly NativeUsageRow[], level: NativeAnalyticsLevel, timezone: string) {
  if (!validAnalyticsTimezone(timezone) || !['hour', 'day', 'week', 'month', 'year'].includes(level)) throw new TypeError('Invalid analytics period');
  const byPeriod = new Map<string, { period: ReturnType<typeof usagePeriod>; samples: Map<string, { on: number; off: number; unknown: number; coverage: number; count: number }>; openBucket: boolean; partialCoverage: boolean }>();
  const reconciled = reconcileNativeUsageCoverage(rows);
  for (const row of reconciled.rows) {
    const sum = row.onSeconds + row.offSeconds + row.unknownSeconds;
    const period = usagePeriod(row, level, timezone);
    const result = byPeriod.get(period.key) ?? { period, samples: new Map(), openBucket: false, partialCoverage: false };
    result.openBucket ||= row.closedAt === null;
    result.partialCoverage ||= sum < 3600 || reconciled.excludedDeviceHours > 0;
    const sampleKey = level === 'hour' ? row.deviceId : `${row.deviceId}:${period.localDay}`;
    const sample = result.samples.get(sampleKey) ?? { on: 0, off: 0, unknown: 0, coverage: 0, count: 0 };
    sample.on += row.onSeconds; sample.off += row.offSeconds; sample.unknown += row.unknownSeconds; sample.coverage += sum; sample.count += 1;
    result.samples.set(sampleKey, sample); byPeriod.set(period.key, result);
  }
  return [...byPeriod.entries()].sort((a, b) => a[1].period.start.localeCompare(b[1].period.start)).map(([id, result]) => {
    const samples = [...result.samples.values()];
    const totals = samples.reduce((sum, sample) => ({ on: sum.on + sample.on, off: sum.off + sample.off, unknown: sum.unknown + sample.unknown, coverage: sum.coverage + sample.coverage }), { on: 0, off: 0, unknown: 0, coverage: 0 });
    const divisor = level === 'hour' ? 1 : samples.length;
    return { id, start: result.period.start, end: result.period.end, label: result.period.label,
      onMinutes: rounded(totals.on / 60 / divisor), offMinutes: rounded(totals.off / 60 / divisor), unknownMinutes: rounded(totals.unknown / 60 / divisor),
      coverageSeconds: totals.coverage, contributingDeviceDays: level === 'hour' ? samples.length : samples.length,
      isPartial: result.openBucket || result.partialCoverage,
    };
  });
}

export function aggregateNativeTemperature(rows: readonly NativeTemperatureRow[], level: NativeAnalyticsLevel, timezone: string, now: Date,
  window?: { from: Date; to: Date; retentionStart?: Date }) {
  if (!validAnalyticsTimezone(timezone) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid temperature query');
  const grouped = new Map<string, { period: ReturnType<typeof usagePeriod>; rows: Array<{ deviceId: string; source: number; validUntil: number; value: number;
    analyticsPolicyVersion: number; intervalStart: number; intervalEnd: number }> }>();
  for (const row of rows) {
    const source = new Date(row.sourceObservedAt); const validUntil = new Date(row.validUntil); const value = Number(row.temperature);
    if (!Number.isFinite(source.getTime()) || !Number.isFinite(validUntil.getTime()) || !Number.isFinite(value) || value < -50 || value > 80
      || validUntil <= source || validUntil.getTime() - source.getTime() > (row.analyticsPolicyVersion === 3
        ? NATIVE_EVIDENCE_TEMPERATURE_MAX_VALIDITY_MS : NATIVE_TEMPERATURE_MAX_VALIDITY_MS)) continue;
    const requestedStart = window?.from.getTime() ?? Number.NEGATIVE_INFINITY;
    const requestedEnd = Math.min(window?.to.getTime() ?? now.getTime(), now.getTime());
    const retentionStart = window?.retentionStart?.getTime() ?? Number.NEGATIVE_INFINITY;
    let cursor = Math.max(source.getTime(), requestedStart, retentionStart);
    const end = Math.min(validUntil.getTime(), requestedEnd);
    // A valid observation may cross one or more calendar periods. Partition
    // its original bounded validity interval rather than assigning all of it
    // to the period containing sourceObservedAt. The window and maximum
    // validity keep this expansion tightly bounded.
    while (cursor < end) {
      const period = usagePeriod({ ...row, bucketStart: new Date(cursor), closedAt: null, onSeconds: 0, offSeconds: 0, unknownSeconds: 0 }, level, timezone);
      const periodEnd = Date.parse(period.end);
      const clippedEnd = Math.min(end, periodEnd);
      if (!Number.isFinite(periodEnd) || clippedEnd <= cursor) break;
      const entry = grouped.get(period.key) ?? { period, rows: [] };
      entry.rows.push({ deviceId: row.deviceId, source: source.getTime(), validUntil: validUntil.getTime(), value,
        analyticsPolicyVersion: row.analyticsPolicyVersion ?? 2,
        intervalStart: cursor, intervalEnd: clippedEnd });
      grouped.set(period.key, entry);
      cursor = clippedEnd;
    }
  }
  return [...grouped.entries()].sort((a, b) => a[1].period.start.localeCompare(b[1].period.start)).map(([id, entry]) => {
    const periodStart = Date.parse(entry.period.start), periodEnd = Date.parse(entry.period.end);
    const events = new Map<number, { starts: number[]; ends: number[] }>();
    entry.rows.forEach((row, rowIndex) => {
      const start = Math.max(periodStart, row.intervalStart), end = Math.min(periodEnd, row.intervalEnd);
      if (end <= start) return;
      const atStart = events.get(start) ?? { starts: [], ends: [] }; atStart.starts.push(rowIndex); events.set(start, atStart);
      const atEnd = events.get(end) ?? { starts: [], ends: [] }; atEnd.ends.push(rowIndex); events.set(end, atEnd);
    });
    const boundaries = [...events.keys()].sort((a, b) => a - b);
    const active = new Map<string, Map<number, { source: number; value: number }>>();
    const segments: Array<{ id: string; start: string; end: string; celsius: number }> = [];
    let weighted = 0, covered = 0;
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index], end = boundaries[index + 1];
      if (end <= start) continue;
      const boundary = events.get(start);
      for (const rowIndex of boundary?.ends ?? []) {
        const row = entry.rows[rowIndex]; const values = active.get(row.deviceId);
        values?.delete(rowIndex); if (values?.size === 0) active.delete(row.deviceId);
      }
      for (const rowIndex of boundary?.starts ?? []) {
        const row = entry.rows[rowIndex]; const values = active.get(row.deviceId) ?? new Map();
        values.set(rowIndex, { source: row.source, value: row.value }); active.set(row.deviceId, values);
      }
      const activeByDevice = new Map<string, { source: number; value: number }>();
      for (const [deviceId, values] of active) {
        const latest = [...values.values()].reduce((best, sample) => !best || sample.source > best.source ? sample : best, null as { source: number; value: number } | null);
        if (latest) activeByDevice.set(deviceId, latest);
      }
      if (!activeByDevice.size) continue;
      const celsius = [...activeByDevice.values()].reduce((sum, sample) => sum + sample.value, 0) / activeByDevice.size;
      const roundedCelsius = Math.round(celsius * 100) / 100;
      const previous = segments.at(-1);
      if (previous && previous.end === new Date(start).toISOString() && previous.celsius === roundedCelsius) previous.end = new Date(end).toISOString();
      else segments.push({ id: `${id}:${segments.length}`, start: new Date(start).toISOString(), end: new Date(end).toISOString(), celsius: roundedCelsius });
      weighted += celsius * (end - start); covered += end - start;
    }
    const latest = entry.rows.reduce((candidate, row) => row.source > candidate.source ? row : candidate, entry.rows[0]);
    return { id, start: entry.period.start, end: entry.period.end, label: entry.period.label,
      celsius: Math.round((covered ? weighted / covered : latest.value) * 100) / 100,
      sampleCount: entry.rows.length, sourceAt: new Date(latest.source).toISOString(), validUntil: new Date(latest.validUntil).toISOString(),
      currentFresh: latest.analyticsPolicyVersion === 3 && now.getTime() < latest.validUntil,
      coverageSeconds: Math.floor(covered / 1000), segments };
  });
}

export function retentionStart(now: Date): Date {
  const cutoff = new Date(now); const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1); cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay)); return cutoff;
}

export function parseAnalyticsWindow(input: { from?: string | null; to?: string | null }, now: Date) {
  const from = input.from ? new Date(input.from) : null; const to = input.to ? new Date(input.to) : now;
  if ((input.from && !Number.isFinite(from!.getTime())) || !Number.isFinite(to.getTime()) || (from && from.toISOString() !== input.from)
    || (input.to && to.toISOString() !== input.to) || (from && from >= to) || to > now) {
    throw Object.assign(new Error('Choose a valid analytics window of no more than 12 months'), { status: 400, code: 'VALIDATION_FAILED' });
  }
  const earliest = retentionStart(now);
  if (from && from < earliest) throw Object.assign(new Error('The requested period is outside retained history'), { status: 400, code: 'VALIDATION_FAILED' });
  return { from: from ?? earliest, to, retentionStart: earliest };
}
