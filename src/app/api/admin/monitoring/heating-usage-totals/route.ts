// Architecture: API boundary /admin/monitoring/heating-usage-totals; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getGroupLabel } from '@/lib/deviceLabels';
import { buildMonitoringDisplayContext } from '@/lib/adminMonitoringDisplay';

type Bucket = 'daily' | 'weekly' | 'monthly';
type HeatingLabel = 'Boiler' | 'Radiator';
type Metric = 'minutesOn' | 'kwh' | 'costGbp';
type GroupBy = 'total' | 'entity';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_DAYS = 365;

const startOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));

const endOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

const parseDateOnly = (value: string | null, endOfDay = false): Date | null => {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map((v) => Number(v));
  const base = new Date(Date.UTC(y, m - 1, d));
  const date = endOfDay ? endOfDayUtc(base) : startOfDayUtc(base);
  return Number.isNaN(date.getTime()) ? null : date;
};

function parseMulti(searchParams: URLSearchParams, key: string): string[] {
  const direct = searchParams.getAll(key);
  const bracketed = searchParams.getAll(`${key}[]`);
  const combined = [...direct, ...bracketed]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0);
  return Array.from(new Set(combined));
}

function normalizeLabel(value: string | null): HeatingLabel | null {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'boiler') return 'Boiler';
  if (normalized === 'radiator') return 'Radiator';
  return null;
}

function normalizeBucket(value: string | null): Bucket {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'weekly') return 'weekly';
  if (normalized === 'monthly') return 'monthly';
  return 'daily';
}

function normalizeMetric(value: string | null): Metric {
  const normalized = (value ?? '').trim();
  if (normalized === 'kwh') return 'kwh';
  if (normalized === 'costGbp') return 'costGbp';
  return 'minutesOn';
}

function normalizeGroupBy(value: string | null): GroupBy {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'entity') return 'entity';
  return 'total';
}

const prettyEntityId = (id: string) => id.replace(/^[^.]+\./i, '').replace(/_/g, ' ');

const parseEnvNumber = (raw?: string | null) => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const getIsoWeekInfoUtc = (date: Date) => {
  const temp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = temp.getUTCDay() || 7;
  temp.setUTCDate(temp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((temp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  const weekStart = new Date(Date.UTC(temp.getUTCFullYear(), temp.getUTCMonth(), temp.getUTCDate()));
  const weekStartDay = weekStart.getUTCDay() || 7;
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStartDay - 1));

  return { year: temp.getUTCFullYear(), week, weekStart };
};

const formatDateUtc = (date: Date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const getBucketInfoUtc = (bucket: Bucket, capturedAt: Date) => {
  if (bucket === 'weekly') {
    const { year, week, weekStart } = getIsoWeekInfoUtc(capturedAt);
    return {
      key: `${year}-W${String(week).padStart(2, '0')}`,
      bucketStart: new Date(weekStart),
      label: `Week of ${formatDateUtc(new Date(weekStart))}`,
    };
  }

  if (bucket === 'monthly') {
    const start = new Date(Date.UTC(capturedAt.getUTCFullYear(), capturedAt.getUTCMonth(), 1));
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return {
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      bucketStart: start,
      label: `${monthNames[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
    };
  }

  const start = startOfDayUtc(capturedAt);
  return { key: formatDateUtc(start), bucketStart: start, label: formatDateUtc(start) };
};

type TotalsPoint = { bucketStart: string; label: string; value: number };
type TotalsSeries = { entityId: string; name: string; area: string | null; displayAreaKey?: string | null; points: TotalsPoint[] };

function sumOnSecondsByBucket(rows: Array<{ entityId: string; capturedAt: Date; onForSeconds: number | null }>, bucket: Bucket) {
  const bucketsByEntity = new Map<string, Map<string, { bucketStart: Date; label: string; sumSeconds: number }>>();
  for (const row of rows) {
    const date = row.capturedAt instanceof Date ? row.capturedAt : new Date(row.capturedAt);
    if (Number.isNaN(date.getTime())) continue;
    const info = getBucketInfoUtc(bucket, date);
    const seconds = typeof row.onForSeconds === 'number' && Number.isFinite(row.onForSeconds) ? Math.max(0, row.onForSeconds) : 0;
    if (!bucketsByEntity.has(row.entityId)) bucketsByEntity.set(row.entityId, new Map());
    const entityBuckets = bucketsByEntity.get(row.entityId)!;
    const existing = entityBuckets.get(info.key);
    if (!existing) {
      entityBuckets.set(info.key, { bucketStart: info.bucketStart, label: info.label, sumSeconds: seconds });
    } else {
      existing.sumSeconds += seconds;
    }
  }
  return bucketsByEntity;
}

function sumKwhByBucket(
  rows: Array<{ entityId: string; capturedAt: Date; onForSeconds: number | null; kwhOnEstimated: number | null }>,
  bucket: Bucket,
  resolveBoilerPowerKw: (entityId: string) => number | null
) {
  const bucketsByEntity = new Map<string, Map<string, { bucketStart: Date; label: string; sumKwh: number }>>();
  for (const row of rows) {
    const date = row.capturedAt instanceof Date ? row.capturedAt : new Date(row.capturedAt);
    if (Number.isNaN(date.getTime())) continue;
    const info = getBucketInfoUtc(bucket, date);

    let kwh = 0;
    if (typeof row.kwhOnEstimated === 'number' && Number.isFinite(row.kwhOnEstimated) && row.kwhOnEstimated >= 0) {
      kwh = row.kwhOnEstimated;
    } else {
      const seconds = typeof row.onForSeconds === 'number' && Number.isFinite(row.onForSeconds) ? Math.max(0, row.onForSeconds) : 0;
      const power = resolveBoilerPowerKw(row.entityId);
      kwh = power != null ? (seconds / 3600) * power : 0;
    }

    const key = info.bucketStart.toISOString();
    if (!bucketsByEntity.has(row.entityId)) bucketsByEntity.set(row.entityId, new Map());
    const entityBuckets = bucketsByEntity.get(row.entityId)!;
    const existing = entityBuckets.get(key);
    if (!existing) {
      entityBuckets.set(key, { bucketStart: info.bucketStart, label: info.label, sumKwh: kwh });
    } else {
      existing.sumKwh += kwh;
    }
  }
  return bucketsByEntity;
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  }

  let haConnectionId: number;
  try {
    const { haConnection } = await getUserWithHaConnection(me.id);
    haConnectionId = haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Dinodia Hub connection is missing for this home.' },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(req.url);
  const label = normalizeLabel(searchParams.get('label'));
  if (!label) {
    return NextResponse.json({ error: 'label must be Boiler or Radiator.' }, { status: 400 });
  }

  const bucket = normalizeBucket(searchParams.get('bucket'));
  const metric = normalizeMetric(searchParams.get('metric'));
  const groupBy = normalizeGroupBy(searchParams.get('groupBy'));

  const rawDays = searchParams.get('days');
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const isAllTime = rawDays === 'all';
  const daysParsed = Number.parseInt(rawDays || '', 10);
  const days = Number.isFinite(daysParsed) && daysParsed > 0 ? Math.min(daysParsed, MAX_DAYS) : 30;

  let from = startOfDayUtc(new Date(Date.now() - (days - 1) * MS_PER_DAY));
  let to = endOfDayUtc(new Date());

  if (rawFrom || rawTo) {
    const parsedFrom = parseDateOnly(rawFrom, false);
    const parsedTo = parseDateOnly(rawTo, true);
    if (!parsedFrom || !parsedTo) {
      return NextResponse.json({ error: 'Invalid from/to date. Use YYYY-MM-DD.' }, { status: 400 });
    }
    if (parsedTo.getTime() < parsedFrom.getTime()) {
      return NextResponse.json({ error: 'from must be on or before to.' }, { status: 400 });
    }
    const spanDays = Math.floor((endOfDayUtc(parsedTo).getTime() - startOfDayUtc(parsedFrom).getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_DAYS && !isAllTime) {
      return NextResponse.json({ error: `Date range too large. Max ${MAX_DAYS} days.` }, { status: 400 });
    }
    from = startOfDayUtc(parsedFrom);
    to = endOfDayUtc(parsedTo);
  }

  const selectedEntityIds = parseMulti(searchParams, 'entityIds');
  const boilerEntityIdsOverride = parseMulti(searchParams, 'boilerEntityIds');
  const areasFilter = new Set(parseMulti(searchParams, 'areas'));

  if (isAllTime) {
    const oldest = await prisma.boilerTemperatureReading.findFirst({
      where: { haConnectionId, capturedAt: { lte: to } },
      orderBy: { capturedAt: 'asc' },
      select: { capturedAt: true },
    });
    const nowEnd = endOfDayUtc(new Date());
    from = oldest ? startOfDayUtc(oldest.capturedAt) : nowEnd;
    to = nowEnd;
  }

  const [haDevices, overrides] = await Promise.all([
    getDevicesForHaConnection(haConnectionId, { cacheTtlMs: 2000 }).catch(() => []),
    prisma.device.findMany({
      where: { haConnectionId },
      select: { entityId: true, name: true, area: true, label: true, boilerPowerKw: true, heatingPricePerKwh: true },
    }),
  ]);

  const haMap = new Map(haDevices.map((d) => [d.entityId, d]));
  const overrideMap = new Map(overrides.map((d) => [d.entityId, d]));
  const displayCtx = await buildMonitoringDisplayContext({
    haConnectionId,
    entityIds: Array.from(
      new Set([
        ...haDevices.map((device) => device.entityId),
        ...overrides.map((device) => device.entityId),
        ...selectedEntityIds,
        ...boilerEntityIdsOverride,
      ])
    ),
  });

  const resolveName = (entityId: string) => {
    return displayCtx.displayName(entityId) || prettyEntityId(entityId);
  };

  const resolveArea = (entityId: string) => {
    const ha = haMap.get(entityId);
    const override = overrideMap.get(entityId);
    return (override?.area ?? ha?.area ?? ha?.areaName ?? '').trim() || null;
  };

  const resolveLabel = (entityId: string) => {
    const ha = haMap.get(entityId);
    const override = overrideMap.get(entityId);
    const overrideLabel = (override?.label ?? '').trim();
    if (overrideLabel) return overrideLabel;
    return getGroupLabel(ha ?? { labels: [], label: null, labelCategory: null }) ?? null;
  };

  const allLabeledEntities = haDevices
    .filter((d) => getGroupLabel(d) === label)
    .map((d) => d.entityId);

  const baseEntityIds = selectedEntityIds.length > 0 ? selectedEntityIds : allLabeledEntities;
  const allowedEntityIds = baseEntityIds.filter((id) => {
    if ((resolveLabel(id) || '').toLowerCase() !== label.toLowerCase()) return false;
    if (areasFilter.size > 0 && !displayCtx.matchesRequestedDisplayAreas(id, areasFilter)) return false;
    return true;
  });

  if (allowedEntityIds.length === 0) {
    return NextResponse.json({ ok: true, unit: metric === 'minutesOn' ? 'min' : metric === 'kwh' ? 'kWh' : 'GBP', bucket, metric, label, groupBy, seriesByEntity: [], meta: { from: from.toISOString(), to: to.toISOString() } });
  }

  const readings = await prisma.boilerTemperatureReading.findMany({
    where: {
      haConnectionId,
      entityId: { in: allowedEntityIds },
      capturedAt: { gte: from, lte: to },
    },
    orderBy: { capturedAt: 'asc' },
    select: { entityId: true, capturedAt: true, onForSeconds: true, kwhOnEstimated: true },
  });

  const bucketsByEntity = sumOnSecondsByBucket(readings, bucket);

  const defaultBoilerPowerKw = parseEnvNumber(process.env.BOILER_POWER_KW);
  const defaultPricePerKwh = parseEnvNumber(process.env.HEATING_PRICE_PER_KWH ?? process.env.ELECTRICITY_PRICE_PER_KWH);

  const resolveBoilerPowerKw = (entityId: string) => {
    const override = overrideMap.get(entityId);
    const value = typeof override?.boilerPowerKw === 'number' && Number.isFinite(override.boilerPowerKw) ? override.boilerPowerKw : null;
    return value != null && value > 0 ? value : defaultBoilerPowerKw;
  };

  const resolveHeatingPricePerKwh = (entityId: string) => {
    const override = overrideMap.get(entityId);
    const value = typeof override?.heatingPricePerKwh === 'number' && Number.isFinite(override.heatingPricePerKwh) ? override.heatingPricePerKwh : null;
    return value != null && value >= 0 ? value : defaultPricePerKwh;
  };

  const unit = metric === 'minutesOn' ? 'min' : metric === 'kwh' ? 'kWh' : 'GBP';

  const kwhBucketsByEntity = metric !== 'minutesOn' ? sumKwhByBucket(readings, bucket, resolveBoilerPowerKw) : null;

  // Boiler metrics are direct; radiator kWh/cost are allocated from boiler totals by minutesOn share.
  if (metric === 'minutesOn' || label === 'Boiler') {
    const series: TotalsSeries[] =
      groupBy === 'entity'
        ? allowedEntityIds.map((entityId) => {
            const buckets = bucketsByEntity.get(entityId) ?? new Map();
            const power = resolveBoilerPowerKw(entityId);
            const price = resolveHeatingPricePerKwh(entityId);
            const kwhBuckets = kwhBucketsByEntity?.get(entityId) ?? new Map();
            const points = Array.from(buckets.values())
              .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
              .map((p) => {
                if (metric === 'minutesOn') {
                  return { bucketStart: p.bucketStart.toISOString(), label: p.label, value: p.sumSeconds / 60 };
                }
                const kwh = kwhBuckets.get(p.bucketStart.toISOString())?.sumKwh ?? (power != null ? (p.sumSeconds / 3600) * power : 0);
                if (metric === 'kwh') {
                  return { bucketStart: p.bucketStart.toISOString(), label: p.label, value: kwh };
                }
                const cost = price != null ? kwh * price : 0;
                return { bucketStart: p.bucketStart.toISOString(), label: p.label, value: cost };
              });
            return {
              entityId,
              name: resolveName(entityId),
              area: displayCtx.displayArea(entityId),
              displayAreaKey: displayCtx.displayAreaKey(entityId),
              points,
            };
          })
        : [
            (() => {
              const combined = new Map<string, { bucketStart: Date; label: string; value: number }>();
              for (const entityId of allowedEntityIds) {
                const buckets = bucketsByEntity.get(entityId) ?? new Map();
                const power = resolveBoilerPowerKw(entityId);
                const price = resolveHeatingPricePerKwh(entityId);
                const kwhBuckets = kwhBucketsByEntity?.get(entityId) ?? new Map();
                for (const p of buckets.values()) {
                  const key = p.bucketStart.toISOString();
                  const existing = combined.get(key);
                  let value = 0;
                  if (metric === 'minutesOn') {
                    value = p.sumSeconds / 60;
                  } else {
                    const kwh = kwhBuckets.get(key)?.sumKwh ?? (power != null ? (p.sumSeconds / 3600) * power : 0);
                    value = metric === 'kwh' ? kwh : (price != null ? kwh * price : 0);
                  }
                  if (!existing) combined.set(key, { bucketStart: p.bucketStart, label: p.label, value });
                  else existing.value += value;
                }
              }

              const points = Array.from(combined.values())
                .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
                .map((p) => ({ bucketStart: p.bucketStart.toISOString(), label: p.label, value: p.value }));

              return { entityId: 'total', name: 'Total', area: null, displayAreaKey: null, points };
            })(),
          ];

    return NextResponse.json({
      ok: true,
      unit,
      bucket,
      metric,
      label,
      groupBy,
      seriesByEntity: series,
      meta: {
        from: from.toISOString(),
        to: to.toISOString(),
        defaultBoilerPowerKw,
        defaultPricePerKwh,
      },
    });
  }

  // label === Radiator && (metric === kwh || costGbp)
  const boilerEntityIds = (boilerEntityIdsOverride.length > 0 ? boilerEntityIdsOverride : haDevices.filter((d) => getGroupLabel(d) === 'Boiler').map((d) => d.entityId)).filter(
    (id) => (resolveLabel(id) || '').toLowerCase() === 'boiler'
  );

  const boilerReadings = boilerEntityIds.length
    ? await prisma.boilerTemperatureReading.findMany({
        where: { haConnectionId, entityId: { in: boilerEntityIds }, capturedAt: { gte: from, lte: to } },
        orderBy: { capturedAt: 'asc' },
        select: { entityId: true, capturedAt: true, onForSeconds: true, kwhOnEstimated: true },
      })
    : [];

  const boilerBucketsByEntity = sumOnSecondsByBucket(boilerReadings, bucket);
  const boilerKwhBucketsByEntity = sumKwhByBucket(boilerReadings, bucket, resolveBoilerPowerKw);

  const boilerTotalsByBucket = new Map<
    string,
    { bucketStart: Date; label: string; kwh: number; cost: number }
  >();

  for (const [entityId, buckets] of boilerBucketsByEntity.entries()) {
    const price = resolveHeatingPricePerKwh(entityId);
    const kwhBuckets = boilerKwhBucketsByEntity.get(entityId) ?? new Map();
    for (const entry of buckets.values()) {
      const key = entry.bucketStart.toISOString();
      const kwh = kwhBuckets.get(key)?.sumKwh ?? 0;
      const cost = price != null ? kwh * price : 0;
      const existing = boilerTotalsByBucket.get(key);
      if (!existing) {
        boilerTotalsByBucket.set(key, { bucketStart: entry.bucketStart, label: entry.label, kwh, cost });
      } else {
        existing.kwh += kwh;
        existing.cost += cost;
      }
    }
  }

  const radiatorMinutesByBucketByEntity = new Map<string, Map<string, { bucketStart: Date; label: string; minutes: number }>>();
  const radiatorMinutesTotalByBucket = new Map<string, number>();

  for (const entityId of allowedEntityIds) {
    const buckets = bucketsByEntity.get(entityId) ?? new Map();
    for (const entry of buckets.values()) {
      const key = entry.bucketStart.toISOString();
      const minutes = entry.sumSeconds / 60;
      if (!radiatorMinutesByBucketByEntity.has(entityId)) radiatorMinutesByBucketByEntity.set(entityId, new Map());
      radiatorMinutesByBucketByEntity.get(entityId)!.set(key, { bucketStart: entry.bucketStart, label: entry.label, minutes });
      radiatorMinutesTotalByBucket.set(key, (radiatorMinutesTotalByBucket.get(key) ?? 0) + minutes);
    }
  }

  const seriesEntities = groupBy === 'entity' ? allowedEntityIds : ['total'];
  const series: TotalsSeries[] = seriesEntities.map((entityId) => {
    const points: TotalsPoint[] = [];
    const keys = Array.from(
      new Set([
        ...Array.from(boilerTotalsByBucket.keys()),
        ...Array.from(radiatorMinutesTotalByBucket.keys()),
      ])
    ).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

    for (const key of keys) {
      const boilerTotals = boilerTotalsByBucket.get(key);
      const totalMinutes = radiatorMinutesTotalByBucket.get(key) ?? 0;
      const labelText = boilerTotals?.label ?? (radiatorMinutesByBucketByEntity.get(entityId === 'total' ? allowedEntityIds[0] : entityId)?.get(key)?.label ?? key);
      const bucketStart = boilerTotals?.bucketStart ?? new Date(key);
      if (Number.isNaN(bucketStart.getTime())) continue;

      const numeratorMinutes =
        entityId === 'total'
          ? totalMinutes
          : radiatorMinutesByBucketByEntity.get(entityId)?.get(key)?.minutes ?? 0;
      const ratio = totalMinutes > 0 ? numeratorMinutes / totalMinutes : 0;
      const allocated = metric === 'kwh' ? (boilerTotals?.kwh ?? 0) * ratio : (boilerTotals?.cost ?? 0) * ratio;
      points.push({ bucketStart: bucketStart.toISOString(), label: labelText, value: allocated });
    }

    return {
      entityId,
      name: entityId === 'total' ? 'Total' : resolveName(entityId),
      area: entityId === 'total' ? null : displayCtx.displayArea(entityId),
      displayAreaKey: entityId === 'total' ? null : displayCtx.displayAreaKey(entityId),
      points,
    };
  });

  return NextResponse.json({
    ok: true,
    unit,
    bucket,
    metric,
    label,
    groupBy,
    seriesByEntity: series,
    meta: {
      from: from.toISOString(),
      to: to.toISOString(),
      defaultBoilerPowerKw,
      defaultPricePerKwh,
      boilerEntityIdsUsed: boilerEntityIds,
    },
  });
}
