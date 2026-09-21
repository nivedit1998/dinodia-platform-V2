// Architecture: API boundary /admin/monitoring/boiler-history; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getGroupLabel } from '@/lib/deviceLabels';
import { buildMonitoringDisplayContext } from '@/lib/adminMonitoringDisplay';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_DAYS = 365;
const UNASSIGNED = 'Unassigned';

type HistoryBucket = 'daily' | 'weekly' | 'monthly';

const startOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));

const endOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

const parseDateOnly = (value: string | null, endOfDay = false): Date | null => {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map((v) => Number(v));
  const date = endOfDay ? endOfDayUtc(new Date(Date.UTC(y, m - 1, d))) : startOfDayUtc(new Date(Date.UTC(y, m - 1, d)));
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

function normalizeHeatingLabel(value: string | null) {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'boiler') return 'Boiler';
  if (normalized === 'radiator') return 'Radiator';
  return null;
}

function parseEnvNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const formatDateUtc = (date: Date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const startOfWeekUtc = (date: Date) => {
  const d = startOfDayUtc(date);
  const day = d.getUTCDay();
  const isoDay = day === 0 ? 7 : day; // 1..7 (Mon..Sun)
  d.setUTCDate(d.getUTCDate() - (isoDay - 1));
  return d;
};

const startOfMonthUtc = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));

const bucketStartUtc = (bucket: HistoryBucket, date: Date) => {
  if (bucket === 'weekly') return startOfWeekUtc(date);
  if (bucket === 'monthly') return startOfMonthUtc(date);
  return startOfDayUtc(date);
};

const bucketLabel = (bucket: HistoryBucket, start: Date) => {
  if (bucket === 'weekly') return `Week of ${formatDateUtc(start)}`;
  if (bucket === 'monthly') {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${monthNames[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  }
  return formatDateUtc(start);
};

function normalizeBucket(value: string | null): HistoryBucket {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'weekly') return 'weekly';
  if (normalized === 'monthly') return 'monthly';
  return 'daily';
}

const prettyEntityId = (id: string) => id.replace(/^[^.]+\./i, '').replace(/_/g, ' ');

type ValueBucket = {
  bucketStart: Date;
  label: string;
  sum: number;
  count: number;
};

type TemperatureBucket = {
  bucketStart: Date;
  label: string;
  currentSum: number;
  currentCount: number;
  targetSum: number;
  targetCount: number;
  offCount: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

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
  const requestedLabel = normalizeHeatingLabel(searchParams.get('label'));
  const bucket = normalizeBucket(searchParams.get('bucket'));
  const rawDays = searchParams.get('days');
  const isAllTime = rawDays === 'all';
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const daysParsed = Number.parseInt(rawDays || '', 10);
  const days = Number.isFinite(daysParsed) && daysParsed > 0 ? Math.min(daysParsed, MAX_DAYS) : 90;
  const groupBy = searchParams.get('groupBy');
  const groupByArea = groupBy === 'area';
  const toleranceC = 0.1;

  const selectedEntityIds = parseMulti(searchParams, 'entityIds');
  const areasFilter = new Set(parseMulti(searchParams, 'areas'));

  if (!groupByArea && selectedEntityIds.length === 0) {
    return NextResponse.json({
      ok: true,
      unit: '°C',
      points: [],
      seriesByArea: [],
      seriesByEntity: [],
      seriesTemperatureByEntity: [],
      seriesHeatingStateByEntity: [],
    });
  }

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

  if (isAllTime) {
    const oldest = await prisma.boilerTemperatureReading.findFirst({
      where: { haConnectionId },
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
      select: { entityId: true, name: true, area: true, label: true },
    }),
  ]);

  const haMap = new Map(
    haDevices.map((d) => [d.entityId, { name: d.name ?? '', area: d.area ?? d.areaName ?? null }])
  );
  const groupLabelByEntityId = new Map(haDevices.map((d) => [d.entityId, getGroupLabel(d)]));
  const overrideMap = new Map(overrides.map((d) => [d.entityId, d]));
  const overrideLabelByEntityId = new Map(
    overrides
      .map((d) => [d.entityId, (d.label ?? '').trim()] as const)
      .filter(([, label]) => label.length > 0)
  );
  const displayCtx = await buildMonitoringDisplayContext({
    haConnectionId,
    entityIds: Array.from(new Set([...haMap.keys(), ...overrideMap.keys(), ...selectedEntityIds])),
  });

  const resolveArea = (entityId: string) => {
    const ha = haMap.get(entityId);
    const override = overrideMap.get(entityId);
    return (override?.area ?? ha?.area ?? '').trim() || null;
  };
  const resolveName = (entityId: string) => {
    return displayCtx.displayName(entityId) || prettyEntityId(entityId);
  };
  const hasEntityFilter = selectedEntityIds.length > 0;
  const selectedEntitySet = new Set(selectedEntityIds);
  const hasAreaFilter = areasFilter.size > 0;
  const isAssignedArea = (area: string | null) => {
    const normalized = (area ?? '').trim();
    return normalized.length > 0 && normalized.toLowerCase() !== UNASSIGNED.toLowerCase();
  };
  const matchesArea = (area: string | null) => {
    if (!isAssignedArea(area)) return false;
    if (!hasAreaFilter) return true;
    return displayCtx.matchesRequestedAreaValue(area, areasFilter);
  };

  const allKnownEntityIds = Array.from(new Set([...haMap.keys(), ...overrideMap.keys()]));
  const labelFilterEnabled = requestedLabel !== null;
  const labelFilterHasData = groupLabelByEntityId.size > 0 || overrideLabelByEntityId.size > 0;
  const labelFilterDegraded = labelFilterEnabled && !labelFilterHasData;

  const matchesRequestedLabel = (entityId: string) => {
    if (!requestedLabel) return true;
    const group = groupLabelByEntityId.get(entityId);
    if (group) return group === requestedLabel;
    const override = overrideLabelByEntityId.get(entityId);
    if (override) return override.toLowerCase() === requestedLabel.toLowerCase();
    // Degrade gracefully: if we can't resolve labels right now (HA down), do not hard-filter.
    return labelFilterDegraded ? true : false;
  };

  let queryEntityIds: string[] | null = hasEntityFilter ? Array.from(selectedEntitySet) : null;
  if (hasAreaFilter) {
    queryEntityIds = (queryEntityIds ?? allKnownEntityIds).filter((id) => matchesArea(resolveArea(id)));
  }
  if (labelFilterEnabled) {
    queryEntityIds = (queryEntityIds ?? allKnownEntityIds).filter((id) => matchesRequestedLabel(id));
  }
  if (queryEntityIds && queryEntityIds.length === 0) {
    return NextResponse.json({
      ok: true,
      unit: '°C',
      points: [],
      seriesByArea: [],
      seriesByEntity: [],
      seriesTemperatureByEntity: [],
      seriesHeatingStateByEntity: [],
      meta: {
        label: requestedLabel,
        labelFilterDegraded,
        toleranceC,
      },
    });
  }

  const readings = await prisma.boilerTemperatureReading.findMany({
    where: {
      haConnectionId,
      ...(queryEntityIds ? { entityId: { in: queryEntityIds } } : {}),
      capturedAt: { gte: from, lte: to },
    },
    orderBy: { capturedAt: 'asc' },
    select: {
      entityId: true,
      numericValue: true,
      currentTemperature: true,
      targetTemperature: true,
      capturedAt: true,
    },
  });

  const areaBuckets = new Map<
    string,
    {
      displayAreaKey: string;
      area: string;
      sourceAreas: Set<string>;
      buckets: Map<string, ValueBucket>;
    }
  >();
  const entityBuckets = new Map<string, Map<string, ValueBucket>>();
  const entityTemperatureBuckets = new Map<string, Map<string, TemperatureBucket>>();
  const totalBuckets = new Map<string, ValueBucket>();
  const shouldBucket = bucket !== 'daily';

  for (const reading of readings) {
    if (labelFilterEnabled && !matchesRequestedLabel(reading.entityId)) continue;
    const sourceArea = resolveArea(reading.entityId);
    if (!matchesArea(sourceArea)) continue;
    if (hasEntityFilter && !selectedEntitySet.has(reading.entityId)) continue;

    const currentValue = isFiniteNumber(reading.currentTemperature)
      ? reading.currentTemperature
      : isFiniteNumber(reading.numericValue)
      ? reading.numericValue
      : null;
    if (currentValue == null) continue;

    const rawTarget = isFiniteNumber(reading.targetTemperature) ? reading.targetTemperature : null;
    const isOffReading = rawTarget === 0;
    const targetValue = rawTarget != null && rawTarget > 0 ? rawTarget : null;
    const bucketStart = shouldBucket ? bucketStartUtc(bucket, reading.capturedAt) : reading.capturedAt;
    const key = bucketStart.toISOString();
    const label = shouldBucket ? bucketLabel(bucket, bucketStart) : bucketLabel('daily', startOfDayUtc(reading.capturedAt));

    const displayAreaKey = displayCtx.displayAreaKey(reading.entityId);
    const displayAreaName = displayCtx.displayArea(reading.entityId);
    const areaEntry = areaBuckets.get(displayAreaKey) ?? {
      displayAreaKey,
      area: displayAreaName,
      sourceAreas: new Set<string>(),
      buckets: new Map<string, ValueBucket>(),
    };
    if (sourceArea) {
      areaEntry.sourceAreas.add(sourceArea);
    }
    const areaExisting = areaEntry.buckets.get(key);
    if (!areaExisting) {
      areaEntry.buckets.set(key, {
        bucketStart,
        label,
        sum: currentValue,
        count: 1,
      });
    } else {
      areaExisting.sum += currentValue;
      areaExisting.count += 1;
    }
    if (!areaBuckets.has(displayAreaKey)) areaBuckets.set(displayAreaKey, areaEntry);

    const perEntity = entityBuckets.get(reading.entityId) ?? new Map();
    const entityExisting = perEntity.get(key);
    if (!entityExisting) {
      perEntity.set(key, {
        bucketStart,
        label,
        sum: currentValue,
        count: 1,
      });
    } else {
      entityExisting.sum += currentValue;
      entityExisting.count += 1;
    }
    if (!entityBuckets.has(reading.entityId)) entityBuckets.set(reading.entityId, perEntity);

    const perEntityTemp = entityTemperatureBuckets.get(reading.entityId) ?? new Map();
    const tempExisting = perEntityTemp.get(key);
    if (!tempExisting) {
      perEntityTemp.set(key, {
        bucketStart,
        label,
        currentSum: currentValue,
        currentCount: 1,
        targetSum: targetValue ?? 0,
        targetCount: targetValue == null ? 0 : 1,
        offCount: isOffReading ? 1 : 0,
      });
    } else {
      tempExisting.currentSum += currentValue;
      tempExisting.currentCount += 1;
      if (targetValue != null) {
        tempExisting.targetSum += targetValue;
        tempExisting.targetCount += 1;
      }
      if (isOffReading) {
        tempExisting.offCount += 1;
      }
    }
    if (!entityTemperatureBuckets.has(reading.entityId)) entityTemperatureBuckets.set(reading.entityId, perEntityTemp);

    const totalExisting = totalBuckets.get(key);
    if (!totalExisting) {
      totalBuckets.set(key, {
        bucketStart,
        label,
        sum: currentValue,
        count: 1,
      });
    } else {
      totalExisting.sum += currentValue;
      totalExisting.count += 1;
    }
  }

  const seriesByArea = Array.from(areaBuckets.entries())
    .map(([, entry]) => ({
      area: entry.area,
      displayAreaKey: entry.displayAreaKey,
      sourceAreaNames: Array.from(entry.sourceAreas).sort((left, right) => left.localeCompare(right)),
      points: Array.from(entry.buckets.values())
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
        .map((b) => ({
          bucketStart: b.bucketStart.toISOString(),
          label: b.label,
          value: b.count > 0 ? b.sum / b.count : 0,
        })),
    }))
    .sort((a, b) => a.area.localeCompare(b.area));

  const seriesByEntity = Array.from(entityBuckets.entries())
    .map(([entityId, buckets]) => ({
      entityId,
      name: resolveName(entityId),
      area: displayCtx.displayArea(entityId) || UNASSIGNED,
      displayAreaKey: displayCtx.displayAreaKey(entityId),
      points: Array.from(buckets.values())
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
        .map((b) => ({
          bucketStart: b.bucketStart.toISOString(),
          label: b.label,
          value: b.count > 0 ? b.sum / b.count : 0,
        })),
    }))
    .filter((series) => isAssignedArea(series.area))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.entityId.localeCompare(b.entityId);
    });

  const seriesTemperatureByEntity = Array.from(entityTemperatureBuckets.entries())
    .map(([entityId, buckets]) => ({
      entityId,
      name: resolveName(entityId),
      area: displayCtx.displayArea(entityId) || UNASSIGNED,
      displayAreaKey: displayCtx.displayAreaKey(entityId),
      points: Array.from(buckets.values())
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
        .map((b) => ({
          bucketStart: b.bucketStart.toISOString(),
          label: b.label,
          currentTemperature: b.currentCount > 0 ? b.currentSum / b.currentCount : 0,
          targetTemperature: b.targetCount > 0 ? b.targetSum / b.targetCount : b.offCount > 0 ? 0 : null,
        })),
    }))
    .filter((series) => isAssignedArea(series.area))
    .filter((series) => (labelFilterEnabled ? matchesRequestedLabel(series.entityId) : true))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.entityId.localeCompare(b.entityId);
    });

  const seriesHeatingStateByEntity = seriesTemperatureByEntity.map((series) => ({
    entityId: series.entityId,
    name: series.name,
    area: series.area,
    displayAreaKey: series.displayAreaKey,
    points: series.points.map((point) => ({
      bucketStart: point.bucketStart,
      label: point.label,
      state:
        point.targetTemperature == null
          ? null
          : point.targetTemperature === 0
          ? 0
          : point.targetTemperature > point.currentTemperature + toleranceC
          ? 1
          : 0,
    })),
  }));

  const boilerPowerKw = parseEnvNumber(process.env.BOILER_POWER_KW);
  const pricePerKwh = parseEnvNumber(process.env.HEATING_PRICE_PER_KWH ?? process.env.ELECTRICITY_PRICE_PER_KWH);

  const points = Array.from(totalBuckets.values())
    .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
    .map((b) => ({
      bucketStart: b.bucketStart.toISOString(),
      label: b.label,
      value: b.count > 0 ? b.sum / b.count : 0,
    }));

  return NextResponse.json({
    ok: true,
    unit: '°C',
    points: groupByArea ? [] : points,
    seriesByArea,
    seriesByEntity,
    seriesTemperatureByEntity,
    seriesHeatingStateByEntity,
    meta: {
      label: requestedLabel,
      labelFilterDegraded,
      toleranceC,
      bucket,
      boilerPowerKw,
      pricePerKwh,
    },
  });
}
