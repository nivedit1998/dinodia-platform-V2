// Architecture: Shared platform helper src/lib/adminElectricLightDashboard.ts; builds the authenticated Light-runtime estimate without touching measured-electricity or heating analytics.
import { prisma } from '@/lib/prisma';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { buildMonitoringDisplayContext, UNASSIGNED_AREA } from '@/lib/adminMonitoringDisplay';
import {
  DETAIL_RETENTION_DAYS,
  localBucketKey,
  localDateKey,
  localDateRangeToUtc,
  localDateStartUtc,
  localBucketLabel,
  normalizeTimeZone,
  readElectricUsageConfig,
  splitElectricUsageRowByLocalDay,
} from '@/lib/electricUsageConfig';

type HistoryBucket = 'daily' | 'weekly' | 'monthly';
type UsageRow = {
  entityId: string;
  entityName: string | null;
  trackingEpoch: string;
  assignmentEpoch: string;
  sourceAreaId: string | null;
  sourceAreaName: string | null;
  onForSeconds: number;
  offForSeconds: number;
  unknownForSeconds: number;
  estimatedKwh: number | null;
  estimatedCostGbp: number | null;
  averageWattsApplied?: number | null;
  electricPricePerKwh?: number | null;
  windowStartedAt: Date;
  windowEndedAt: Date;
  localDate?: string;
};

type LightSnapshot = Pick<
  import('@/types/device').UIDevice,
  'entityId' | 'name' | 'domain' | 'labels' | 'entityLabels' | 'deviceLabels' | 'label'
>;

type PointAccumulator = {
  bucketStart: string;
  label: string;
  onMinutes: number;
  offMinutes: number;
  unknownMinutes: number;
  estimatedKwh: number;
  estimatedCostGbp: number;
  hasKwh: boolean;
  hasCost: boolean;
};

type DashboardPoint = {
  bucketStart: string;
  label: string;
  onMinutes: number;
  offMinutes: number;
  unknownMinutes: number;
  estimatedKwh: number | null;
  estimatedCostGbp: number | null;
};

type EntityDescriptor = {
  entityId: string;
  name: string;
  area: string;
  displayAreaKey: string;
  label: string;
  isActive: boolean;
  retiredAt: string | null;
};

type EntitySeries = EntityDescriptor & { points: DashboardPoint[] };
type EnergyPoint = { bucketStart: string; label: string; estimatedKwh: number | null };
type CostPoint = { bucketStart: string; label: string; estimatedCostGbp: number | null };
type EnergySeries = EntityDescriptor & { points: EnergyPoint[] };
type CostSeries = EntityDescriptor & { points: CostPoint[] };

function parseBucket(value: string | null): HistoryBucket {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === 'weekly' || normalized === 'monthly' ? normalized : 'daily';
}

function parseDateKey(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function areaKeyForLocalDate(dateKey: string, bucket: HistoryBucket) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (bucket === 'weekly') {
    const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (isoDay - 1));
  } else if (bucket === 'monthly') {
    date.setUTCDate(1);
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function toDateRange(searchParams: URLSearchParams, timeZone: string) {
  const now = new Date();
  const today = localDateKey(now, timeZone);
  const rawDays = searchParams.get('days');
  const fromParam = parseDateKey(searchParams.get('from'));
  const toParam = parseDateKey(searchParams.get('to'));
  let fromKey: string;
  const toKey: string = toParam || today;
  if (fromParam || toParam) {
    if (!fromParam || !toParam || fromParam > toParam) throw new Error('from and to must be valid YYYY-MM-DD dates with from on or before to.');
    fromKey = fromParam;
  } else if (rawDays === 'all') {
    fromKey = addDays(today, -(7 * 365));
  } else {
    const days = Math.max(1, Math.min(365, Number.parseInt(rawDays || '7', 10) || 7));
    fromKey = addDays(today, -(days - 1));
  }
  if (rawDays !== 'all' && addDays(fromKey, 365) < toKey) throw new Error('Date range too large. Max 365 days.');
  const range = localDateRangeToUtc(fromKey, toKey, timeZone);
  return { fromKey, toKey, from: range.from, to: range.to };
}

function normalizeLabels(device: LightSnapshot) {
  return [...(device?.labels || []), ...(device?.entityLabels || []), ...(device?.deviceLabels || []), device?.label]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function isEligibleLight(device: LightSnapshot) {
  const domain = String(device?.domain || '').toLowerCase();
  return (domain === 'light' || domain === 'switch') && normalizeLabels(device).includes('light');
}

function descriptorName(entityId: string) {
  return entityId.replace(/^[^.]+\./, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function roundCoverage(known: number, total: number) {
  return total > 0 ? Math.max(0, Math.min(100, Number(((known / total) * 100).toFixed(2)))) : 0;
}

function addPoint(map: Map<string, PointAccumulator>, row: UsageRow, bucket: HistoryBucket, timeZone: string, bucketDateKey?: string) {
  const key = bucketDateKey ? areaKeyForLocalDate(bucketDateKey, bucket) : localBucketKey(row.windowStartedAt, bucket, timeZone);
  const current = map.get(key) || { bucketStart: key, label: localBucketLabel(key, bucket), onMinutes: 0, offMinutes: 0, unknownMinutes: 0, estimatedKwh: 0, estimatedCostGbp: 0, hasKwh: true, hasCost: true };
  current.onMinutes += row.onForSeconds / 60;
  current.offMinutes += row.offForSeconds / 60;
  current.unknownMinutes += row.unknownForSeconds / 60;
  if (row.estimatedKwh == null) current.hasKwh = false;
  else current.estimatedKwh += row.estimatedKwh;
  if (row.estimatedCostGbp == null) current.hasCost = false;
  else current.estimatedCostGbp += row.estimatedCostGbp;
  map.set(key, current);
}

function points(map: Map<string, PointAccumulator>): DashboardPoint[] {
  return Array.from(map.values()).sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)).map((point) => ({
    bucketStart: point.bucketStart,
    label: point.label,
    onMinutes: Number(point.onMinutes.toFixed(4)),
    offMinutes: Number(point.offMinutes.toFixed(4)),
    unknownMinutes: Number(point.unknownMinutes.toFixed(4)),
    estimatedKwh: point.hasKwh ? point.estimatedKwh : null,
    estimatedCostGbp: point.hasCost ? point.estimatedCostGbp : null,
  }));
}

function summarizeRows(rows: UsageRow[]) {
  const onSeconds = rows.reduce((sum, row) => sum + row.onForSeconds, 0);
  const offSeconds = rows.reduce((sum, row) => sum + row.offForSeconds, 0);
  const unknownSeconds = rows.reduce((sum, row) => sum + row.unknownForSeconds, 0);
  const kwhValues = rows.map((row) => row.estimatedKwh).filter((value): value is number => value != null);
  const costValues = rows.map((row) => row.estimatedCostGbp).filter((value): value is number => value != null);
  return {
    onMinutes: onSeconds / 60,
    offMinutes: offSeconds / 60,
    unknownMinutes: unknownSeconds / 60,
    estimatedKwh: kwhValues.length === rows.length ? kwhValues.reduce((sum, value) => sum + value, 0) : null,
    estimatedCostGbp: costValues.length === rows.length ? costValues.reduce((sum, value) => sum + value, 0) : null,
    coveragePercent: roundCoverage(onSeconds + offSeconds, onSeconds + offSeconds + unknownSeconds),
  };
}

export async function buildAdminElectricLightDashboard({ haConnectionId, searchParams }: { haConnectionId: number; searchParams: URLSearchParams }) {
  const home = await prisma.home.findUnique({ where: { haConnectionId }, select: { timeZone: true } });
  const timeZone = normalizeTimeZone(home?.timeZone);
  const range = toDateRange(searchParams, timeZone);
  const bucket = parseBucket(searchParams.get('bucket'));
  const config = readElectricUsageConfig();
  const cutoff = new Date(Date.now() - DETAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const detailFrom = range.from > cutoff ? range.from : cutoff;
  const [devices, readings, dailyRollups] = await Promise.all([
    getDevicesForHaConnection(haConnectionId, { cacheTtlMs: 2000 }).catch(() => []),
    prisma.electricUsageReading.findMany({ where: { haConnectionId, windowEndedAt: { gte: detailFrom, lte: range.to } }, orderBy: [{ entityId: 'asc' }, { windowStartedAt: 'asc' }] }),
    prisma.electricUsageDailyRollup.findMany({ where: { haConnectionId, localDate: { gte: range.fromKey, lte: range.toKey } }, orderBy: [{ entityId: 'asc' }, { localDate: 'asc' }] }),
  ]);

  const active = new Map<string, LightSnapshot>();
  for (const device of devices) if (isEligibleLight(device)) active.set(String(device.entityId), device);
  const detailHistory = readings.flatMap((row) => splitElectricUsageRowByLocalDay(row, timeZone).map((segment) => ({
    ...row,
    ...segment,
  } as UsageRow)));
  const history = [...detailHistory, ...dailyRollups.map((row) => ({
    ...row,
    windowStartedAt: localDateStartUtc(row.localDate, timeZone),
    windowEndedAt: localDateStartUtc(addDays(row.localDate, 1), timeZone),
    localDate: row.localDate,
  } as UsageRow))];
  const historicalIds = new Set(history.map((row) => row.entityId));
  const requestedEntityIds = new Set(searchParams.getAll('entityIds').concat(searchParams.getAll('entityIds[]')).map((value) => value.trim()).filter(Boolean));
  const requestedAreas = new Set(searchParams.getAll('areas').concat(searchParams.getAll('areas[]')).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const displayCtx = await buildMonitoringDisplayContext({ haConnectionId, entityIds: Array.from(new Set([...active.keys(), ...historicalIds])) });
  const entityName = (id: string, fallback?: string | null) => active.get(id)?.name || displayCtx.displayName(id) || fallback || descriptorName(id);
  const entityArea = (id: string, fallback?: string | null) => active.has(id) ? (displayCtx.displayArea(id) || UNASSIGNED_AREA) : (fallback || UNASSIGNED_AREA);
  const allowed = (id: string, fallbackArea?: string | null) => {
    if (requestedEntityIds.size && !requestedEntityIds.has(id)) return false;
    if (!requestedAreas.size) return true;
    const area = (active.has(id) ? displayCtx.displayArea(id) : fallbackArea) || UNASSIGNED_AREA;
    return requestedAreas.has(area.toLowerCase()) || requestedAreas.has(displayCtx.displayAreaKeyForArea(area).toLowerCase());
  };
  const grouped = new Map<string, UsageRow[]>();
  for (const row of history) {
    if (!allowed(row.entityId, row.sourceAreaName)) continue;
    const list = grouped.get(row.entityId) || [];
    list.push(row);
    grouped.set(row.entityId, list);
  }

  const descriptors = new Map<string, { entityId: string; name: string; area: string; displayAreaKey: string; label: string; isActive: boolean; retiredAt: string | null }>();
  for (const [id, device] of active) {
    if (!allowed(id, null)) continue;
    descriptors.set(id, { entityId: id, name: entityName(id, device.name), area: entityArea(id), displayAreaKey: displayCtx.displayAreaKey(id), label: 'Light', isActive: true, retiredAt: null });
  }
  for (const row of history) if (!descriptors.has(row.entityId) && allowed(row.entityId, row.sourceAreaName)) descriptors.set(row.entityId, { entityId: row.entityId, name: entityName(row.entityId, row.entityName), area: row.sourceAreaName || UNASSIGNED_AREA, displayAreaKey: displayCtx.displayAreaKeyForArea(row.sourceAreaName || UNASSIGNED_AREA), label: 'Light', isActive: false, retiredAt: null });

  const runtimeByEntity: EntitySeries[] = [];
  const energyByEntity: EnergySeries[] = [];
  const costByEntity: CostSeries[] = [];
  const areaRuntime = new Map<string, Map<string, PointAccumulator>>();
  const areaEnergy = new Map<string, number>();
  const areaCost = new Map<string, number>();
  const includedRows: UsageRow[] = [];
  for (const [id, rows] of grouped) {
    const descriptor = descriptors.get(id);
    if (!descriptor) continue;
    const runtimePoints = new Map<string, PointAccumulator>();
    const energyPoints = new Map<string, PointAccumulator>();
    const costPoints = new Map<string, PointAccumulator>();
    for (const row of rows) {
      includedRows.push(row);
      addPoint(runtimePoints, row, bucket, timeZone, row.localDate);
      addPoint(energyPoints, row, bucket, timeZone, row.localDate);
      addPoint(costPoints, row, bucket, timeZone, row.localDate);
      // Every persisted row carries the area that was effective when the
      // interval was captured. Current metadata is only used for a light
      // with no history yet; it must never rewrite historical room totals.
      const area = row.sourceAreaName || (descriptor.isActive ? descriptor.area : UNASSIGNED_AREA);
      if (!areaRuntime.has(area)) areaRuntime.set(area, new Map());
      addPoint(areaRuntime.get(area)!, row, bucket, timeZone, row.localDate);
      if (row.estimatedKwh != null) areaEnergy.set(area, (areaEnergy.get(area) || 0) + row.estimatedKwh);
      if (row.estimatedCostGbp != null) areaCost.set(area, (areaCost.get(area) || 0) + row.estimatedCostGbp);
    }
    const base = { entityId: id, name: descriptor.name, area: descriptor.area, displayAreaKey: descriptor.displayAreaKey, label: descriptor.label, isActive: descriptor.isActive, retiredAt: descriptor.retiredAt };
    if (runtimePoints.size) runtimeByEntity.push({ ...base, points: points(runtimePoints) });
    if (energyPoints.size) energyByEntity.push({ ...base, points: points(energyPoints).map((point) => ({ bucketStart: point.bucketStart, label: point.label, estimatedKwh: point.estimatedKwh })) });
    if (costPoints.size) costByEntity.push({ ...base, points: points(costPoints).map((point) => ({ bucketStart: point.bucketStart, label: point.label, estimatedCostGbp: point.estimatedCostGbp })) });
  }
  const energyByArea = Array.from(areaEnergy.entries()).map(([area, estimatedKwh]) => ({ area, displayAreaKey: displayCtx.displayAreaKeyForArea(area), estimatedKwh }));
  const costByArea = Array.from(areaCost.entries()).map(([area, estimatedCostGbp]) => ({ area, displayAreaKey: displayCtx.displayAreaKeyForArea(area), estimatedCostGbp }));
  const runtimeByArea = Array.from(areaRuntime.entries()).map(([area, pointMap]) => ({ area, displayAreaKey: displayCtx.displayAreaKeyForArea(area), points: points(pointMap).map((point) => ({ bucketStart: point.bucketStart, label: point.label, onMinutes: point.onMinutes, offMinutes: point.offMinutes, unknownMinutes: point.unknownMinutes })) }));
  const totals = summarizeRows(includedRows);
  const formerIds = Array.from(descriptors.values()).filter((descriptor) => !descriptor.isActive).map((descriptor) => descriptor.entityId);
  return {
    ok: true,
    source: 'estimated_light_runtime',
    sourceDescription: 'Estimated usage from reported ON time',
    bucket,
    timeZone,
    range: { from: range.from.toISOString(), to: range.to.toISOString(), fromLocalDate: range.fromKey, toLocalDate: range.toKey },
    runtimeByEntity: runtimeByEntity.sort((a, b) => a.name.localeCompare(b.name)),
    runtimeByArea: runtimeByArea.sort((a, b) => a.area.localeCompare(b.area)),
    energyByEntity: energyByEntity.sort((a, b) => a.name.localeCompare(b.name)),
    energyByArea: energyByArea.sort((a, b) => a.area.localeCompare(b.area)),
    costByEntity: costByEntity.sort((a, b) => a.name.localeCompare(b.name)),
    costByArea: costByArea.sort((a, b) => a.area.localeCompare(b.area)),
    totals,
    meta: {
      trackedLightCount: Array.from(descriptors.values()).filter((descriptor) => descriptor.isActive).length,
      formerLightCount: formerIds.length,
      averageWatts: config.averageWatts,
      electricPricePerKwh: config.electricPricePerKwh,
      energyEstimateAvailable: includedRows.length > 0 && includedRows.every((row) => row.estimatedKwh != null),
      costEstimateAvailable: includedRows.length > 0 && includedRows.every((row) => row.estimatedCostGbp != null),
      mixedAverageWatts: new Set(includedRows.map((row) => row.averageWattsApplied == null ? 'null' : row.averageWattsApplied)).size > 1,
      mixedPrice: new Set(includedRows.map((row) => row.electricPricePerKwh == null ? 'null' : row.electricPricePerKwh)).size > 1,
      assumptionScope: config.assumptionScope,
      trackingUnit: 'controlled_circuit',
      calendarBoundaryAllocation: 'proportional',
      collectingFirstInterval: Array.from(active.keys()).some((id) => !grouped.has(id)),
      hasRowsInWindow: includedRows.length > 0,
      rowCount: includedRows.length,
      generatedAt: new Date().toISOString(),
    },
  };
}
