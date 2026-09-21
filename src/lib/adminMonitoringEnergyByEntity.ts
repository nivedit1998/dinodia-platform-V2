// Architecture: Shared platform helper src/lib/adminMonitoringEnergyByEntity.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import { buildMonitoringDisplayContext } from '@/lib/adminMonitoringDisplay';

type HistoryBucket = 'daily' | 'weekly' | 'monthly';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_DAYS = 90;
const MAX_ENTITIES = 200;
const UNASSIGNED = 'Unassigned';

const startOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));

const endOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

const formatDateUtc = (date: Date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

function getIsoWeekInfoUtc(date: Date) {
  const temp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = temp.getUTCDay() || 7;
  temp.setUTCDate(temp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((temp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  const weekStart = new Date(Date.UTC(temp.getUTCFullYear(), temp.getUTCMonth(), temp.getUTCDate()));
  const weekStartDay = weekStart.getUTCDay() || 7;
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStartDay - 1));

  return { year: temp.getUTCFullYear(), week, weekStart };
}

const getBucketInfoUtc = (bucket: HistoryBucket, capturedAt: Date) => {
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

function parseDateOnly(value: string | null, endOfDay = false): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map((v) => Number(v));
  const date = endOfDay ? endOfDayUtc(new Date(Date.UTC(y, m - 1, d))) : startOfDayUtc(new Date(Date.UTC(y, m - 1, d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeBucket(value: string | null): HistoryBucket {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'weekly') return 'weekly';
  if (normalized === 'monthly') return 'monthly';
  return 'daily';
}

function parseMulti(searchParams: URLSearchParams, key: string, max = MAX_ENTITIES): string[] {
  const direct = searchParams.getAll(key);
  const bracketed = searchParams.getAll(`${key}[]`);
  const combined = [...direct, ...bracketed]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0);
  return Array.from(new Set(combined)).slice(0, max);
}

const isFiniteNumber = (val: unknown): val is number =>
  typeof val === 'number' && Number.isFinite(val);

function isGasLabel(label: string | null | undefined, entityId: string) {
  const normalized = (label ?? '').trim().toLowerCase();
  if (normalized === 'boiler' || normalized === 'radiator') return true;
  const id = (entityId ?? '').toLowerCase();
  return id.includes('boiler') || id.includes('radiator');
}

export async function buildAdminMonitoringEnergyByEntity(args: {
  haConnectionId: number;
  searchParams: URLSearchParams;
}) {
  const { haConnectionId, searchParams } = args;
  const bucket = normalizeBucket(searchParams.get('bucket'));
  const rawDays = searchParams.get('days');
  const isAllTime = rawDays === 'all';
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const daysParsed = Number.parseInt(rawDays || '', 10);
  const days = Number.isFinite(daysParsed) && daysParsed > 0 ? Math.min(daysParsed, MAX_DAYS) : 30;

  const areasFilter = new Set(parseMulti(searchParams, 'areas', 2000));
  const excludeLabels = new Set(parseMulti(searchParams, 'excludeLabels', 10).map((v) => v.trim().toLowerCase()));
  const includeEntityIds = parseMulti(searchParams, 'entityIds', MAX_ENTITIES);

  let from = startOfDayUtc(new Date(Date.now() - (days - 1) * MS_PER_DAY));
  let to = endOfDayUtc(new Date());
  if (rawFrom || rawTo) {
    const parsedFrom = parseDateOnly(rawFrom, false);
    const parsedTo = parseDateOnly(rawTo, true);
    if (!parsedFrom || !parsedTo) {
      throw new Error('Invalid from/to date. Use YYYY-MM-DD.');
    }
    if (parsedTo.getTime() < parsedFrom.getTime()) {
      throw new Error('from must be on or before to.');
    }
    const spanDays = Math.floor((endOfDayUtc(parsedTo).getTime() - startOfDayUtc(parsedFrom).getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_DAYS) {
      throw new Error(`Date range too large. Max ${MAX_DAYS} days.`);
    }
    from = startOfDayUtc(parsedFrom);
    to = endOfDayUtc(parsedTo);
  }

  const devices = await prisma.device.findMany({
    where: { haConnectionId },
    select: { entityId: true, name: true, area: true, label: true },
  });
  const deviceByEntity = new Map(devices.map((d) => [d.entityId, d]));

  const entityAllowed = (entityId: string) => {
    const device = deviceByEntity.get(entityId);
    const label = (device?.label ?? '').trim();
    if (excludeLabels.has('boiler') || excludeLabels.has('radiator')) {
      if (excludeLabels.has('boiler') && isGasLabel(label, entityId) && (label.toLowerCase() === 'boiler' || entityId.toLowerCase().includes('boiler'))) return false;
      if (excludeLabels.has('radiator') && isGasLabel(label, entityId) && (label.toLowerCase() === 'radiator' || entityId.toLowerCase().includes('radiator'))) return false;
    }
    if (excludeLabels.size > 0 && label) {
      if (excludeLabels.has(label.toLowerCase())) return false;
    }
    return true;
  };

  const entityIds = includeEntityIds.length > 0 ? includeEntityIds : devices.map((d) => d.entityId);
  const displayCtx = await buildMonitoringDisplayContext({
    haConnectionId,
    entityIds,
  });
  const areaAllowed = (entityId: string) => {
    if (areasFilter.size === 0) return true;
    return displayCtx.matchesRequestedDisplayAreas(entityId, areasFilter);
  };
  const filteredEntityIds = entityIds.filter((id) => areaAllowed(id) && entityAllowed(id));

  if (filteredEntityIds.length === 0) {
    return {
      ok: true,
      bucket,
      range: { from: from.toISOString(), to: to.toISOString() },
      seriesByEntity: [],
      meta: {
        hasRowsInWindow: false,
        rowCount: 0,
        selectedEntityCount: filteredEntityIds.length,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  if (isAllTime) {
    const oldest = await prisma.monitoringReading.findFirst({
      where: { haConnectionId, unit: 'kWh', entityId: { in: filteredEntityIds } },
      orderBy: { capturedAt: 'asc' },
      select: { capturedAt: true },
    });
    const nowEnd = endOfDayUtc(new Date());
    from = oldest ? startOfDayUtc(oldest.capturedAt) : nowEnd;
    to = nowEnd;
  }

  const rows = await prisma.monitoringReading.findMany({
    where: {
      haConnectionId,
      unit: 'kWh',
      entityId: { in: filteredEntityIds },
      capturedAt: { gte: from, lte: to },
    },
    orderBy: [{ entityId: 'asc' }, { capturedAt: 'asc' }],
    select: { entityId: true, numericValue: true, capturedAt: true },
  });

  const entityIdSet = new Set(rows.map((r) => r.entityId));
  const baselines = entityIdSet.size
    ? await prisma.monitoringReading.findMany({
        where: { haConnectionId, unit: 'kWh', entityId: { in: Array.from(entityIdSet) }, capturedAt: { lt: from } },
        orderBy: [{ entityId: 'asc' }, { capturedAt: 'desc' }],
        select: { entityId: true, numericValue: true },
      })
    : [];
  const baselineByEntity = new Map<string, number | null>();
  for (const row of baselines) {
    if (!baselineByEntity.has(row.entityId)) {
      baselineByEntity.set(row.entityId, isFiniteNumber(row.numericValue) ? row.numericValue : null);
    }
  }

  type BucketTotal = { bucketStart: Date; label: string; total: number };
  const entityBucketTotals = new Map<string, Map<string, BucketTotal>>();
  const entityTotals = new Map<string, number>();

  let currentEntity: string | null = null;
  let buffer: Array<{ entityId: string; numericValue: number | null; capturedAt: Date }> = [];

  const flushEntity = (entityId: string, readings: typeof buffer) => {
    if (readings.length === 0) return;
    const baseline = baselineByEntity.get(entityId);
    const baselineValue = baseline != null && Number.isFinite(baseline) ? baseline : null;
    let prev: number | null = baselineValue;
    const hasBaseline = prev !== null;
    let totalDelta = 0;

    const buckets = entityBucketTotals.get(entityId) ?? new Map<string, BucketTotal>();

    for (const reading of readings) {
      const numeric = isFiniteNumber(reading.numericValue) ? reading.numericValue : null;
      if (numeric === null) continue;
      if (prev === null) {
        prev = numeric;
        if (!hasBaseline) continue;
      }
      let delta = numeric - (prev ?? 0);
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      prev = numeric;
      if (delta === 0) continue;

      totalDelta += delta;
      const info = getBucketInfoUtc(bucket, reading.capturedAt);
      const existing = buckets.get(info.key);
      if (existing) {
        existing.total += delta;
      } else {
        buckets.set(info.key, { bucketStart: info.bucketStart, label: info.label, total: delta });
      }
    }

    if (totalDelta > 0) {
      entityTotals.set(entityId, totalDelta);
      entityBucketTotals.set(entityId, buckets);
    }
  };

  for (const row of rows) {
    if (currentEntity === null) {
      currentEntity = row.entityId;
      buffer = [row];
      continue;
    }
    if (row.entityId !== currentEntity) {
      flushEntity(currentEntity, buffer);
      currentEntity = row.entityId;
      buffer = [row];
    } else {
      buffer.push(row);
    }
  }
  if (currentEntity) flushEntity(currentEntity, buffer);

  const seriesByEntity = Array.from(entityBucketTotals.entries())
    .map(([entityId, buckets]) => {
      const points = Array.from(buckets.values())
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
        .map((b) => ({ bucketStart: b.bucketStart.toISOString(), label: b.label, totalKwhDelta: b.total }));
      return {
        entityId,
        name: displayCtx.displayName(entityId),
        label: displayCtx.displayLabel(entityId),
        area: displayCtx.displayArea(entityId) || UNASSIGNED,
        displayAreaKey: displayCtx.displayAreaKey(entityId),
        totalKwhDelta: entityTotals.get(entityId) ?? 0,
        points,
      };
    })
    .filter((s) => s.points.length > 0 && s.totalKwhDelta > 0)
    .sort((a, b) => b.totalKwhDelta - a.totalKwhDelta)
    .slice(0, MAX_ENTITIES);

  return {
    ok: true,
    bucket,
    range: { from: from.toISOString(), to: to.toISOString() },
    seriesByEntity,
    meta: {
      hasRowsInWindow: rows.length > 0,
      rowCount: rows.length,
      selectedEntityCount: filteredEntityIds.length,
      generatedAt: new Date().toISOString(),
    },
  };
}
