// Architecture: Shared platform helper src/lib/adminHeatingDashboard.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getGroupLabel } from '@/lib/deviceLabels';
import { buildMonitoringDisplayContext } from '@/lib/adminMonitoringDisplay';

type HistoryBucket = 'daily' | 'weekly' | 'monthly';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_DAYS = 365;

const startOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));

const endOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

const startOfWeekUtc = (date: Date) => {
  const d = startOfDayUtc(date);
  const day = d.getUTCDay();
  const isoDay = day === 0 ? 7 : day;
  d.setUTCDate(d.getUTCDate() - (isoDay - 1));
  return d;
};

const startOfMonthUtc = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));

const formatDateUtc = (date: Date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

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

const parseDateOnly = (value: string | null, endOfDay = false): Date | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map((v) => Number(v));
  const date = endOfDay ? endOfDayUtc(new Date(Date.UTC(y, m - 1, d))) : startOfDayUtc(new Date(Date.UTC(y, m - 1, d)));
  return Number.isNaN(date.getTime()) ? null : date;
};

function parseMulti(searchParams: URLSearchParams, key: string): string[] {
  const direct = searchParams.getAll(key);
  const bracketed = searchParams.getAll(`${key}[]`);
  return Array.from(
    new Set(
      [...direct, ...bracketed]
        .map((value) => (value ?? '').trim())
        .filter((value) => value.length > 0)
    )
  );
}

function normalizeBucket(value: string | null): HistoryBucket {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'weekly') return 'weekly';
  if (normalized === 'monthly') return 'monthly';
  return 'daily';
}

function parseEnvNumber(raw?: string | null) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferHeatingLabel(entityId: string, existing?: string | null) {
  const normalized = (existing ?? '').trim().toLowerCase();
  if (normalized === 'boiler') return 'Boiler';
  if (normalized === 'radiator') return 'Radiator';
  const id = entityId.toLowerCase();
  if (id.includes('boiler')) return 'Boiler';
  if (id.includes('radiator')) return 'Radiator';
  return null;
}

type HeatingPoint = {
  ts: string;
  label: string;
  onMinutes: number | null;
  offMinutes: number | null;
  unknownMinutes: number | null;
  value: number;
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

type SeriesDescriptor = {
  entityId: string;
  name: string;
  area: string;
  displayAreaKey: string;
  label: string | null;
};

function toBucketedHeatingPoints(points: HeatingPoint[], bucket: HistoryBucket) {
  if (bucket === 'daily') {
    return points
      .slice()
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((point) => ({
        ts: point.ts,
        label: point.label,
        onMinutes: point.onMinutes,
        offMinutes: point.offMinutes,
        unknownMinutes: point.unknownMinutes,
        value: point.value,
      }));
  }

  const buckets = new Map<
    string,
    { ts: string; label: string; onMinutes: number | null; offMinutes: number | null; unknownMinutes: number | null; value: number }
  >();

  for (const point of points) {
    const date = new Date(point.ts);
    if (Number.isNaN(date.getTime())) continue;
    const start = bucketStartUtc(bucket, date);
    const key = start.toISOString();
    const existing = buckets.get(key);
    if (existing) {
      existing.value += point.value;
      if (existing.onMinutes != null && point.onMinutes != null) existing.onMinutes += point.onMinutes;
      if (existing.offMinutes != null && point.offMinutes != null) existing.offMinutes += point.offMinutes;
      if (existing.unknownMinutes != null && point.unknownMinutes != null) existing.unknownMinutes += point.unknownMinutes;
    } else {
      buckets.set(key, {
        ts: key,
        label: bucketLabel(bucket, start),
        onMinutes: point.onMinutes,
        offMinutes: point.offMinutes,
        unknownMinutes: point.unknownMinutes,
        value: point.value,
      });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
}

function buildTotalSeries(
  descriptors: Map<string, SeriesDescriptor>,
  pointsByEntity: Map<string, HeatingPoint[]>,
  bucket: HistoryBucket,
  label: string
) {
  const combined = new Map<string, HeatingPoint>();
  for (const entityId of descriptors.keys()) {
    const points = pointsByEntity.get(entityId) ?? [];
    for (const point of points) {
      const existing = combined.get(point.ts);
      if (existing) {
        existing.value += point.value;
        if (existing.onMinutes != null && point.onMinutes != null) existing.onMinutes += point.onMinutes;
        if (existing.offMinutes != null && point.offMinutes != null) existing.offMinutes += point.offMinutes;
        if (existing.unknownMinutes != null && point.unknownMinutes != null) existing.unknownMinutes += point.unknownMinutes;
      } else {
        combined.set(point.ts, { ...point });
      }
    }
  }

  const bucketedPoints = toBucketedHeatingPoints(Array.from(combined.values()), bucket);
  return bucketedPoints.length > 0
    ? [
        {
          entityId: 'total',
          name: 'Total',
          area: null,
          displayAreaKey: null,
          label,
          points: bucketedPoints,
        },
      ]
    : [];
}

function buildEntitySeries(
  descriptors: Map<string, SeriesDescriptor>,
  pointsByEntity: Map<string, HeatingPoint[]>,
  bucket: HistoryBucket
) {
  return Array.from(descriptors.values())
    .map((descriptor) => ({
      entityId: descriptor.entityId,
      name: descriptor.name,
      area: descriptor.area,
      displayAreaKey: descriptor.displayAreaKey,
      label: descriptor.label,
      points: toBucketedHeatingPoints(pointsByEntity.get(descriptor.entityId) ?? [], bucket),
    }))
    .filter((series) => series.points.length > 0)
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.entityId.localeCompare(b.entityId);
    });
}

function buildTemperatureSeries(
  descriptors: Map<string, SeriesDescriptor>,
  bucketsByEntity: Map<string, Map<string, TemperatureBucket>>
) {
  return Array.from(descriptors.values())
    .map((descriptor) => {
      const buckets = Array.from(bucketsByEntity.get(descriptor.entityId)?.values() ?? [])
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
        .map((bucket) => ({
          bucketStart: bucket.bucketStart.toISOString(),
          label: bucket.label,
          currentTemperature: bucket.currentCount > 0 ? bucket.currentSum / bucket.currentCount : 0,
          targetTemperature: bucket.targetCount > 0 ? bucket.targetSum / bucket.targetCount : bucket.offCount > 0 ? 0 : null,
        }));
      return {
        entityId: descriptor.entityId,
        name: descriptor.name,
        area: descriptor.area,
        displayAreaKey: descriptor.displayAreaKey,
        label: descriptor.label,
        points: buckets,
      };
    })
    .filter((series) => series.points.length > 0)
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.entityId.localeCompare(b.entityId);
    });
}

export async function buildAdminHeatingDashboard(args: {
  haConnectionId: number;
  searchParams: URLSearchParams;
}) {
  const { haConnectionId, searchParams } = args;
  const bucket = normalizeBucket(searchParams.get('bucket'));
  const rawDays = searchParams.get('days');
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const isAllTime = rawDays === 'all';
  const daysParsed = Number.parseInt(rawDays || '', 10);
  const days = Number.isFinite(daysParsed) && daysParsed > 0 ? Math.min(daysParsed, MAX_DAYS) : 90;

  const selectedAreas = new Set(parseMulti(searchParams, 'areas').map((value) => value.trim()).filter(Boolean));
  const selectedRadiatorEntityIds = parseMulti(searchParams, 'radiatorEntityIds');
  const selectedBoilerEntityIds = parseMulti(searchParams, 'boilerEntityIds');
  const requestedEntityIds = Array.from(new Set([...selectedRadiatorEntityIds, ...selectedBoilerEntityIds]));
  const inferredEntityIdsFrom: 'request' | 'db' | 'ha' = requestedEntityIds.length > 0 ? 'request' : 'db';

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
    if (spanDays > MAX_DAYS && !isAllTime) {
      throw new Error(`Date range too large. Max ${MAX_DAYS} days.`);
    }
    from = startOfDayUtc(parsedFrom);
    to = endOfDayUtc(parsedTo);
  }

  if (isAllTime) {
    const oldest = await prisma.boilerTemperatureReading.findFirst({
      where: {
        haConnectionId,
        ...(requestedEntityIds.length > 0 ? { entityId: { in: requestedEntityIds } } : {}),
      },
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

  const groupLabelByEntityId = new Map(haDevices.map((device) => [device.entityId, getGroupLabel(device)]));
  const overrideMap = new Map(overrides.map((device) => [device.entityId, device]));
  const overrideLabelByEntityId = new Map(
    overrides
      .map((device) => [device.entityId, (device.label ?? '').trim()] as const)
      .filter(([, label]) => label.length > 0)
  );

  let baseEntityIds: string[] = requestedEntityIds;
  if (baseEntityIds.length === 0) {
    const inferred = await prisma.boilerTemperatureReading.findMany({
      where: { haConnectionId, capturedAt: { gte: from, lte: to } },
      distinct: ['entityId'],
      orderBy: [{ entityId: 'asc' }],
      select: { entityId: true },
    });
    baseEntityIds = inferred.map((row) => row.entityId);
  }

  const displayCtx = await buildMonitoringDisplayContext({
    haConnectionId,
    entityIds: baseEntityIds,
  });

  const resolvedHeatingLabel = (entityId: string) =>
    inferHeatingLabel(entityId, groupLabelByEntityId.get(entityId) ?? overrideLabelByEntityId.get(entityId) ?? null);

  const matchesArea = (entityId: string) => {
    if (selectedAreas.size === 0) return true;
    return displayCtx.matchesRequestedDisplayAreas(entityId, selectedAreas);
  };

  const radiatorEntityIds = (selectedRadiatorEntityIds.length > 0
    ? selectedRadiatorEntityIds
    : baseEntityIds.filter((entityId) => resolvedHeatingLabel(entityId) === 'Radiator')
  ).filter((entityId) => matchesArea(entityId));

  const boilerEntityIds = (selectedBoilerEntityIds.length > 0
    ? selectedBoilerEntityIds
    : baseEntityIds.filter((entityId) => resolvedHeatingLabel(entityId) === 'Boiler')
  ).filter((entityId) => matchesArea(entityId));

  const allowedEntityIds = Array.from(new Set([...radiatorEntityIds, ...boilerEntityIds]));
  const labelFilterDegraded =
    allowedEntityIds.length > 0 &&
    allowedEntityIds.some((entityId) => !groupLabelByEntityId.get(entityId) && !overrideLabelByEntityId.get(entityId));

  const makeDescriptorMap = (entityIds: string[], fallbackLabel: 'Radiator' | 'Boiler') =>
    new Map<string, SeriesDescriptor>(
      entityIds.map((entityId) => [
        entityId,
        {
          entityId,
          name: displayCtx.displayName(entityId),
          area: displayCtx.displayArea(entityId),
          displayAreaKey: displayCtx.displayAreaKey(entityId),
          label: displayCtx.displayLabel(entityId) ?? fallbackLabel,
        },
      ])
    );

  const radiatorDescriptors = makeDescriptorMap(radiatorEntityIds, 'Radiator');
  const boilerDescriptors = makeDescriptorMap(boilerEntityIds, 'Boiler');

  if (allowedEntityIds.length === 0) {
    return {
      ok: true,
      bucket,
      range: { from: from.toISOString(), to: to.toISOString() },
      radiatorTemperatureSeriesByEntity: [],
      boilerMinutesTotalsSeries: [],
      radiatorMinutesTotalsSeries: [],
      boilerKwhTotalsSeries: [],
      radiatorKwhTotalsSeries: [],
      boilerCostTotalsSeries: [],
      radiatorCostTotalsSeries: [],
      boilerMinutesByEntitySeries: [],
      radiatorMinutesByEntitySeries: [],
      boilerKwhByEntitySeries: [],
      radiatorKwhByEntitySeries: [],
      boilerCostByEntitySeries: [],
      radiatorCostByEntitySeries: [],
      meta: {
        hasRowsInWindow: false,
        rowCount: 0,
        selectedRadiatorCount: radiatorEntityIds.length,
        selectedBoilerCount: boilerEntityIds.length,
        labelFilterDegraded,
        inferredEntityIdsFrom,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  const defaultBoilerPowerKw = parseEnvNumber(process.env.BOILER_POWER_KW);
  const defaultPricePerKwh = parseEnvNumber(process.env.HEATING_PRICE_PER_KWH ?? process.env.ELECTRICITY_PRICE_PER_KWH);
  const resolveBoilerPowerKw = (entityId: string) => {
    const override = overrideMap.get(entityId);
    const value = typeof override?.boilerPowerKw === 'number' && Number.isFinite(override.boilerPowerKw) ? override.boilerPowerKw : null;
    return value != null && value > 0 ? value : defaultBoilerPowerKw;
  };
  const resolveHeatingPricePerKwh = (entityId: string) => {
    const override = overrideMap.get(entityId);
    const value =
      typeof override?.heatingPricePerKwh === 'number' && Number.isFinite(override.heatingPricePerKwh)
        ? override.heatingPricePerKwh
        : null;
    return value != null && value >= 0 ? value : defaultPricePerKwh;
  };

  const readings = await prisma.boilerTemperatureReading.findMany({
    where: {
      haConnectionId,
      entityId: { in: allowedEntityIds },
      capturedAt: { gte: from, lte: to },
    },
    orderBy: [{ entityId: 'asc' }, { capturedAt: 'asc' }],
    select: {
      entityId: true,
      capturedAt: true,
      numericValue: true,
      currentTemperature: true,
      targetTemperature: true,
      onForSeconds: true,
      offForSeconds: true,
      unknownForSeconds: true,
      kwhOnEstimated: true,
    },
  });

  const radiatorIdSet = new Set(radiatorEntityIds);
  const boilerIdSet = new Set(boilerEntityIds);
  const shouldBucketTemperature = bucket !== 'daily';

  const radiatorTemperatureBuckets = new Map<string, Map<string, TemperatureBucket>>();
  const boilerMinutesByEntity = new Map<string, HeatingPoint[]>();
  const radiatorMinutesByEntity = new Map<string, HeatingPoint[]>();
  const boilerKwhByEntity = new Map<string, HeatingPoint[]>();
  const radiatorKwhByEntity = new Map<string, HeatingPoint[]>();
  const boilerCostByEntity = new Map<string, HeatingPoint[]>();
  const radiatorCostByEntity = new Map<string, HeatingPoint[]>();

  const boilerTotalsByTs = new Map<string, { kwh: number; cost: number }>();
  const boilerByEntityByTs = new Map<string, Map<string, { kwh: number; cost: number }>>();
  const radiatorMinutesTotalByTs = new Map<string, number>();

  for (const row of readings) {
    const ts = row.capturedAt.toISOString();
    const onMinutes = typeof row.onForSeconds === 'number' && Number.isFinite(row.onForSeconds) ? Math.max(0, row.onForSeconds) / 60 : 0;
    if (boilerIdSet.has(row.entityId)) {
      const seconds = typeof row.onForSeconds === 'number' && Number.isFinite(row.onForSeconds) ? Math.max(0, row.onForSeconds) : 0;
      const power = resolveBoilerPowerKw(row.entityId);
      const kwh =
        typeof row.kwhOnEstimated === 'number' && Number.isFinite(row.kwhOnEstimated) && row.kwhOnEstimated >= 0
          ? row.kwhOnEstimated
          : power != null
          ? (seconds / 3600) * power
          : 0;
      const price = resolveHeatingPricePerKwh(row.entityId);
      const cost = price != null ? kwh * price : 0;

      const totals = boilerTotalsByTs.get(ts);
      if (totals) {
        totals.kwh += kwh;
        totals.cost += cost;
      } else {
        boilerTotalsByTs.set(ts, { kwh, cost });
      }

      const perEntity = boilerByEntityByTs.get(row.entityId) ?? new Map<string, { kwh: number; cost: number }>();
      perEntity.set(ts, { kwh, cost });
      boilerByEntityByTs.set(row.entityId, perEntity);
    }
    if (radiatorIdSet.has(row.entityId)) {
      radiatorMinutesTotalByTs.set(ts, (radiatorMinutesTotalByTs.get(ts) ?? 0) + onMinutes);
    }
  }

  for (const row of readings) {
    const isRadiator = radiatorIdSet.has(row.entityId);
    const isBoiler = boilerIdSet.has(row.entityId);
    if (!isRadiator && !isBoiler) continue;

    const ts = row.capturedAt.toISOString();
    const dayLabel = bucketLabel('daily', startOfDayUtc(row.capturedAt));
    const onMinutes = typeof row.onForSeconds === 'number' && Number.isFinite(row.onForSeconds) ? Math.max(0, row.onForSeconds) / 60 : 0;
    const offMinutes = typeof row.offForSeconds === 'number' && Number.isFinite(row.offForSeconds) ? Math.max(0, row.offForSeconds) / 60 : 0;
    const unknownMinutes = typeof row.unknownForSeconds === 'number' && Number.isFinite(row.unknownForSeconds) ? Math.max(0, row.unknownForSeconds) / 60 : 0;

    if (isRadiator) {
      const currentValue =
        typeof row.currentTemperature === 'number' && Number.isFinite(row.currentTemperature)
          ? row.currentTemperature
          : typeof row.numericValue === 'number' && Number.isFinite(row.numericValue)
          ? row.numericValue
          : null;

      if (currentValue != null) {
        const rawTarget = typeof row.targetTemperature === 'number' && Number.isFinite(row.targetTemperature) ? row.targetTemperature : null;
        const targetValue = rawTarget != null && rawTarget > 0 ? rawTarget : null;
        const isOffReading = rawTarget === 0;
        const bucketStart = shouldBucketTemperature ? bucketStartUtc(bucket, row.capturedAt) : row.capturedAt;
        const key = bucketStart.toISOString();
        const label = shouldBucketTemperature ? bucketLabel(bucket, bucketStart) : dayLabel;
        const entityBuckets = radiatorTemperatureBuckets.get(row.entityId) ?? new Map<string, TemperatureBucket>();
        const existing = entityBuckets.get(key);
        if (existing) {
          existing.currentSum += currentValue;
          existing.currentCount += 1;
          if (targetValue != null) {
            existing.targetSum += targetValue;
            existing.targetCount += 1;
          }
          if (isOffReading) existing.offCount += 1;
        } else {
          entityBuckets.set(key, {
            bucketStart,
            label,
            currentSum: currentValue,
            currentCount: 1,
            targetSum: targetValue ?? 0,
            targetCount: targetValue == null ? 0 : 1,
            offCount: isOffReading ? 1 : 0,
          });
        }
        radiatorTemperatureBuckets.set(row.entityId, entityBuckets);
      }

      const boilerTotals = boilerTotalsByTs.get(ts);
      const totalRadiatorMinutes = radiatorMinutesTotalByTs.get(ts) ?? 0;
      const ratio = totalRadiatorMinutes > 0 ? onMinutes / totalRadiatorMinutes : 0;
      const allocatedKwh = (boilerTotals?.kwh ?? 0) * ratio;
      const allocatedCost = (boilerTotals?.cost ?? 0) * ratio;
      const minutesList = radiatorMinutesByEntity.get(row.entityId) ?? [];
      minutesList.push({ ts, label: dayLabel, onMinutes, offMinutes, unknownMinutes, value: onMinutes });
      radiatorMinutesByEntity.set(row.entityId, minutesList);
      const kwhList = radiatorKwhByEntity.get(row.entityId) ?? [];
      kwhList.push({ ts, label: dayLabel, onMinutes: null, offMinutes: null, unknownMinutes: null, value: allocatedKwh });
      radiatorKwhByEntity.set(row.entityId, kwhList);
      const costList = radiatorCostByEntity.get(row.entityId) ?? [];
      costList.push({ ts, label: dayLabel, onMinutes: null, offMinutes: null, unknownMinutes: null, value: allocatedCost });
      radiatorCostByEntity.set(row.entityId, costList);
    }

    if (isBoiler) {
      const perEntity = boilerByEntityByTs.get(row.entityId)?.get(ts);
      const minutesList = boilerMinutesByEntity.get(row.entityId) ?? [];
      minutesList.push({ ts, label: dayLabel, onMinutes, offMinutes, unknownMinutes, value: onMinutes });
      boilerMinutesByEntity.set(row.entityId, minutesList);
      const kwhList = boilerKwhByEntity.get(row.entityId) ?? [];
      kwhList.push({ ts, label: dayLabel, onMinutes: null, offMinutes: null, unknownMinutes: null, value: perEntity?.kwh ?? 0 });
      boilerKwhByEntity.set(row.entityId, kwhList);
      const costList = boilerCostByEntity.get(row.entityId) ?? [];
      costList.push({ ts, label: dayLabel, onMinutes: null, offMinutes: null, unknownMinutes: null, value: perEntity?.cost ?? 0 });
      boilerCostByEntity.set(row.entityId, costList);
    }
  }

  return {
    ok: true,
    bucket,
    range: { from: from.toISOString(), to: to.toISOString() },
    radiatorTemperatureSeriesByEntity: buildTemperatureSeries(radiatorDescriptors, radiatorTemperatureBuckets),
    boilerMinutesTotalsSeries: buildTotalSeries(boilerDescriptors, boilerMinutesByEntity, bucket, 'Boiler'),
    radiatorMinutesTotalsSeries: buildTotalSeries(radiatorDescriptors, radiatorMinutesByEntity, bucket, 'Radiator'),
    boilerKwhTotalsSeries: buildTotalSeries(boilerDescriptors, boilerKwhByEntity, bucket, 'Boiler'),
    radiatorKwhTotalsSeries: buildTotalSeries(radiatorDescriptors, radiatorKwhByEntity, bucket, 'Radiator'),
    boilerCostTotalsSeries: buildTotalSeries(boilerDescriptors, boilerCostByEntity, bucket, 'Boiler'),
    radiatorCostTotalsSeries: buildTotalSeries(radiatorDescriptors, radiatorCostByEntity, bucket, 'Radiator'),
    boilerMinutesByEntitySeries: buildEntitySeries(boilerDescriptors, boilerMinutesByEntity, bucket),
    radiatorMinutesByEntitySeries: buildEntitySeries(radiatorDescriptors, radiatorMinutesByEntity, bucket),
    boilerKwhByEntitySeries: buildEntitySeries(boilerDescriptors, boilerKwhByEntity, bucket),
    radiatorKwhByEntitySeries: buildEntitySeries(radiatorDescriptors, radiatorKwhByEntity, bucket),
    boilerCostByEntitySeries: buildEntitySeries(boilerDescriptors, boilerCostByEntity, bucket),
    radiatorCostByEntitySeries: buildEntitySeries(radiatorDescriptors, radiatorCostByEntity, bucket),
    meta: {
      hasRowsInWindow: readings.length > 0,
      rowCount: readings.length,
      selectedRadiatorCount: radiatorEntityIds.length,
      selectedBoilerCount: boilerEntityIds.length,
      labelFilterDegraded,
      inferredEntityIdsFrom,
      generatedAt: new Date().toISOString(),
    },
  };
}
