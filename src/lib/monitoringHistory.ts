// Architecture: Shared platform helper src/lib/monitoringHistory.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export type HistoryBucket = 'daily' | 'weekly' | 'monthly';

export type HistoryPoint = {
  bucketStart: string;
  label: string;
  value: number;
  count: number;
};

export type BucketInfo = {
  key: string;
  bucketStart: Date;
  label: string;
};

const DEFAULT_DAYS: Record<HistoryBucket, number> = {
  daily: 30,
  weekly: 7 * 12,
  monthly: 365,
};

export function parseBucket(value: string | null): HistoryBucket {
  if (value === 'weekly' || value === 'monthly') return value;
  return 'daily';
}

export function parseDays(bucket: HistoryBucket, rawDays: string | null): number {
  if (rawDays) {
    const parsed = parseInt(rawDays, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_DAYS[bucket];
}

function startOfDayLocal(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateLabel(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatMonthLabel(date: Date) {
  const y = date.getFullYear();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[date.getMonth()]} ${y}`;
}

function getIsoWeekInfo(date: Date) {
  const temp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = temp.getUTCDay() || 7;
  temp.setUTCDate(temp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((temp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  const weekStart = new Date(Date.UTC(temp.getUTCFullYear(), temp.getUTCMonth(), temp.getUTCDate()));
  const weekStartDay = weekStart.getUTCDay() || 7;
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStartDay - 1));

  return { year: temp.getUTCFullYear(), week, weekStart };
}

export function getBucketInfo(bucket: HistoryBucket, capturedAt: Date): BucketInfo {
  if (bucket === 'weekly') {
    const { year, week, weekStart } = getIsoWeekInfo(capturedAt);
    const label = `Week of ${formatDateLabel(new Date(weekStart))}`;
    return {
      key: `${year}-W${String(week).padStart(2, '0')}`,
      bucketStart: new Date(weekStart),
      label,
    };
  }

  if (bucket === 'monthly') {
    const start = new Date(capturedAt.getFullYear(), capturedAt.getMonth(), 1);
    return {
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      bucketStart: start,
      label: formatMonthLabel(start),
    };
  }

  const start = startOfDayLocal(capturedAt);
  return {
    key: formatDateLabel(start),
    bucketStart: start,
    label: formatDateLabel(start),
  };
}

type ReadingInput = {
  numericValue: number | null;
  unit?: string | null;
  capturedAt: Date;
};

type BaselineInput = {
  numericValue: number | null;
  unit?: string | null;
  capturedAt: Date;
} | null;

function firstUnit(baseline: BaselineInput, readings: ReadingInput[]): string | null {
  const candidates = [];
  if (baseline) candidates.push(baseline.unit);
  for (const reading of readings) {
    candidates.push(reading.unit);
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

export function aggregateMonitoringHistory({
  readings,
  baseline,
  bucket,
  omitFirstIfNoBaseline = true,
  entityId,
}: {
  readings: ReadingInput[];
  baseline?: BaselineInput;
  bucket: HistoryBucket;
  omitFirstIfNoBaseline?: boolean;
  entityId: string;
}): { unit: string | null; points: HistoryPoint[] } {
  const unit = firstUnit(baseline ?? null, readings);
  const isEnergyUnit = typeof unit === 'string' && unit.toLowerCase() === 'kwh';
  const isBattery = entityId.toLowerCase().includes('battery');

  if (readings.length === 0) {
    return { unit, points: [] };
  }

  if (isBattery) {
    // Build per-day latest reading first.
    const dailyLatest: Record<
      string,
      { bucketStart: Date; label: string; value: number; capturedAt: Date }
    > = {};
    for (const reading of readings) {
      const numeric = typeof reading.numericValue === 'number' ? reading.numericValue : NaN;
      if (!Number.isFinite(numeric)) continue;
      const capturedAt = new Date(reading.capturedAt);
      const info = getBucketInfo('daily', capturedAt);
      const existing = dailyLatest[info.key];
      if (!existing || capturedAt.getTime() >= existing.capturedAt.getTime()) {
        dailyLatest[info.key] = {
          bucketStart: info.bucketStart,
          label: info.label,
          value: numeric,
          capturedAt,
        };
      }
    }

    const dailyPoints = Object.values(dailyLatest).sort(
      (a, b) => a.bucketStart.getTime() - b.bucketStart.getTime()
    );

    if (bucket === 'daily') {
      return {
        unit,
        points: dailyPoints.map((p) => ({
          bucketStart: p.bucketStart.toISOString(),
          label: p.label,
          value: p.value,
          count: 1,
        })),
      };
    }

    const buckets: Record<string, { sum: number; count: number; bucketStart: Date; label: string }> = {};
    for (const day of dailyPoints) {
      const info = getBucketInfo(bucket, day.bucketStart);
      const existing = buckets[info.key];
      if (!existing) {
        buckets[info.key] = {
          sum: day.value,
          count: 1,
          bucketStart: info.bucketStart,
          label: info.label,
        };
      } else {
        existing.sum += day.value;
        existing.count += 1;
      }
    }

    const points = Object.values(buckets)
      .filter((b) => b.count > 0)
      .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
      .map((b) => ({
        bucketStart: b.bucketStart.toISOString(),
        label: b.label,
        value: b.sum / b.count,
        count: b.count,
      }));

    return { unit, points };
  }

  if (isEnergyUnit) {
    const bucketEnds: Record<
      string,
      { bucketStart: Date; label: string; endValue: number; capturedAt: Date; count: number }
    > = {};

    for (const reading of readings) {
      const numeric = typeof reading.numericValue === 'number' ? reading.numericValue : NaN;
      if (!Number.isFinite(numeric)) continue;
      const capturedAt = new Date(reading.capturedAt);
      const info = getBucketInfo(bucket, capturedAt);
      const current = bucketEnds[info.key];
      if (!current || capturedAt.getTime() >= current.capturedAt.getTime()) {
        bucketEnds[info.key] = {
          bucketStart: info.bucketStart,
          label: info.label,
          endValue: numeric,
          capturedAt,
          count: current ? current.count + 1 : 1,
        };
      } else {
        current.count += 1;
      }
    }

    const sorted = Object.values(bucketEnds).sort(
      (a, b) => a.bucketStart.getTime() - b.bucketStart.getTime()
    );

    const points: HistoryPoint[] = [];
    const baselineValue =
      baseline && typeof baseline.numericValue === 'number' && Number.isFinite(baseline.numericValue)
        ? baseline.numericValue
        : null;
    let prevValue: number | null = baselineValue;

    for (const bucketEntry of sorted) {
      const end = bucketEntry.endValue;
      if (!Number.isFinite(end)) continue;

      if (prevValue === null) {
        prevValue = end;
        if (omitFirstIfNoBaseline) {
          continue;
        }
      }

      let delta = end - prevValue;
      if (!Number.isFinite(delta)) delta = 0;
      if (delta < 0) {
        delta = 0;
      }
      prevValue = end;

      points.push({
        bucketStart: bucketEntry.bucketStart.toISOString(),
        label: bucketEntry.label,
        value: delta,
        count: bucketEntry.count,
      });
    }

    return { unit, points };
  }

  const buckets: Record<string, { sum: number; count: number; bucketStart: Date; label: string }> = {};

  for (const reading of readings) {
    const numeric = typeof reading.numericValue === 'number' ? reading.numericValue : NaN;
    if (!Number.isFinite(numeric)) continue;
    const capturedAt = new Date(reading.capturedAt);
    const info = getBucketInfo(bucket, capturedAt);
    const existing = buckets[info.key];
    if (!existing) {
      buckets[info.key] = {
        sum: numeric,
        count: 1,
        bucketStart: info.bucketStart,
        label: info.label,
      };
    } else {
      existing.sum += numeric;
      existing.count += 1;
    }
  }

  const points = Object.values(buckets)
    .filter((b) => b.count > 0)
    .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
    .map((b) => ({
      bucketStart: b.bucketStart.toISOString(),
      label: b.label,
      value: b.sum / b.count,
      count: b.count,
    }));

  return { unit, points };
}
