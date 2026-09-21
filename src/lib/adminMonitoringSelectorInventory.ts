// Architecture: Shared platform helper src/lib/adminMonitoringSelectorInventory.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getGroupLabel } from '@/lib/deviceLabels';
import { buildMonitoringDisplayContext, UNASSIGNED_AREA } from '@/lib/adminMonitoringDisplay';
import type { UIDevice } from '@/types/device';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;
const MAX_ENTITY_DAYS = 90;
const MAX_BOILER_DAYS = 365;
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 4000;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const startOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));

const endOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

const parseDateOnly = (value: string | null): Date | null => {
  if (!value) return null;
  const parts = value.split('-').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
};

function parseMulti(searchParams: URLSearchParams, key: string): string[] {
  const direct = searchParams.getAll(key);
  const bracketed = searchParams.getAll(`${key}[]`);
  const combined = [...direct, ...bracketed]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0);
  return Array.from(new Set(combined));
}

function parseCsvMulti(searchParams: URLSearchParams, key: string): string[] {
  const raw = parseMulti(searchParams, key);
  const parts = raw.flatMap((value) => value.split(','));
  const cleaned = parts.map((v) => (v ?? '').trim()).filter((v) => v.length > 0);
  return Array.from(new Set(cleaned));
}

function normalizeHeatingLabel(value: string | null) {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'boiler') return 'Boiler';
  if (normalized === 'radiator') return 'Radiator';
  return null;
}

type SelectorRow = {
  entityId: string;
  name: string;
  area: string;
  displayAreaKey: string;
  sourceArea: string;
  label: string | null;
  sourceLabel: string | null;
  lastCapturedAt: string;
};

function isLightSelectorDevice(device: Pick<UIDevice, 'domain' | 'label' | 'labels' | 'entityLabels' | 'deviceLabels'>) {
  const domain = String(device?.domain || '').toLowerCase();
  const labels = [device?.label, ...(device?.labels || []), ...(device?.entityLabels || []), ...(device?.deviceLabels || [])]
    .map((value) => String(value || '').trim().toLowerCase());
  return (domain === 'light' || domain === 'switch') && labels.includes('light');
}

export async function buildAdminElectricLightSelectors(args: { haConnectionId: number }) {
  const { haConnectionId } = args;
  const [devices, accumulators] = await Promise.all([
    getDevicesForHaConnection(haConnectionId, { cacheTtlMs: 2000 }).catch(() => []),
    prisma.electricUsageAccumulator.findMany({
      where: { haConnectionId },
      orderBy: [{ entityId: 'asc' }],
      select: { entityId: true, entityName: true, sourceAreaName: true, lastSeenAt: true, retiredAt: true },
    }),
  ]);
  const active = devices.filter(isLightSelectorDevice);
  const ids = Array.from(new Set([...active.map((device) => device.entityId), ...accumulators.map((row) => row.entityId)]));
  const displayCtx = await buildMonitoringDisplayContext({ haConnectionId, entityIds: ids });
  const activeIds = new Set(active.map((device) => device.entityId));
  const activeRows = active.map((device) => ({
    entityId: device.entityId,
    name: displayCtx.displayName(device.entityId) || device.name || device.entityId,
    area: displayCtx.displayArea(device.entityId) || UNASSIGNED_AREA,
    displayAreaKey: displayCtx.displayAreaKey(device.entityId),
    label: 'Light',
    isActive: true,
    retiredAt: null,
    lastCapturedAt: accumulators.find((row) => row.entityId === device.entityId)?.lastSeenAt?.toISOString() || null,
  }));
  const formerRows = accumulators.filter((row) => !activeIds.has(row.entityId)).map((row) => ({
    entityId: row.entityId,
    name: row.entityName || displayCtx.displayName(row.entityId) || row.entityId,
    area: row.sourceAreaName || UNASSIGNED_AREA,
    displayAreaKey: displayCtx.displayAreaKeyForArea(row.sourceAreaName || UNASSIGNED_AREA),
    label: 'Light',
    isActive: false,
    retiredAt: row.retiredAt?.toISOString() || null,
    lastCapturedAt: row.lastSeenAt?.toISOString() || null,
  }));
  return {
    lightEntities: activeRows.sort((a, b) => a.name.localeCompare(b.name)),
    formerLightEntities: formerRows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function buildAdminMonitoringEntities(args: {
  haConnectionId: number;
  searchParams: URLSearchParams;
}) {
  const { haConnectionId, searchParams } = args;
  const q = (searchParams.get('q') || '').trim();
  const limitRaw = Number.parseInt(searchParams.get('limit') || '', 10);
  const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1, MAX_LIMIT);
  const rawDays = searchParams.get('days');
  const isAllTime = rawDays === 'all';
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const daysParsed = Number.parseInt(rawDays || '', 10);
  const days = clamp(Number.isFinite(daysParsed) ? daysParsed : DEFAULT_DAYS, 1, MAX_ENTITY_DAYS);

  const areasFilter = parseMulti(searchParams, 'areas');
  const hasAreaFilter = areasFilter.length > 0;

  const includeLabels = parseCsvMulti(searchParams, 'includeLabels');
  const excludeLabels = parseCsvMulti(searchParams, 'excludeLabels');
  const normalizedInclude = new Set(includeLabels.map((l) => l.toLowerCase()));
  const normalizedExclude = new Set(excludeLabels.map((l) => l.toLowerCase()));
  const labelMode = normalizedInclude.size > 0 ? 'include' : normalizedExclude.size > 0 ? 'exclude' : 'none';

  const whereBase = {
    haConnectionId,
    ...(q ? { entityId: { contains: q, mode: 'insensitive' as const } } : {}),
  };

  let from = startOfDayUtc(new Date(Date.now() - (days - 1) * MS_PER_DAY));
  let to = endOfDayUtc(new Date());

  if (rawFrom || rawTo) {
    const parsedFrom = parseDateOnly(rawFrom);
    const parsedTo = parseDateOnly(rawTo);
    if (!parsedFrom || !parsedTo) {
      throw new Error('Invalid from/to date. Use YYYY-MM-DD.');
    }
    if (parsedTo.getTime() < parsedFrom.getTime()) {
      throw new Error('from must be on or before to.');
    }
    const spanDays = Math.floor((endOfDayUtc(parsedTo).getTime() - startOfDayUtc(parsedFrom).getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_ENTITY_DAYS && !isAllTime) {
      throw new Error(`Date range too large. Max ${MAX_ENTITY_DAYS} days.`);
    }
    from = startOfDayUtc(parsedFrom);
    to = endOfDayUtc(parsedTo);
  }

  if (isAllTime) {
    const oldest = await prisma.monitoringReading.findFirst({
      where: { haConnectionId },
      orderBy: { capturedAt: 'asc' },
      select: { capturedAt: true },
    });
    const nowEnd = endOfDayUtc(new Date());
    from = oldest ? startOfDayUtc(oldest.capturedAt) : nowEnd;
    to = nowEnd;
  }

  const energyEntities = await prisma.monitoringReading.findMany({
    where: {
      ...whereBase,
      unit: 'kWh',
      numericValue: { gt: 0 },
      capturedAt: { gte: from, lte: to },
    },
    distinct: ['entityId'],
    orderBy: [{ entityId: 'asc' }],
    take: limit,
    select: { entityId: true, capturedAt: true },
  });

  const batteryEntities = await prisma.monitoringReading.findMany({
    where: {
      ...whereBase,
      unit: '%',
      entityId: { contains: 'battery', mode: 'insensitive' },
      numericValue: { not: null },
      capturedAt: { gte: from, lte: to },
    },
    distinct: ['entityId'],
    orderBy: [{ entityId: 'asc' }],
    take: limit,
    select: { entityId: true, capturedAt: true },
  });

  const displayCtx = await buildMonitoringDisplayContext({
    haConnectionId,
    entityIds: Array.from(new Set([...energyEntities, ...batteryEntities].map((row) => row.entityId))),
  });

  const mapRow = (row: { entityId: string; capturedAt: Date }): SelectorRow => ({
    entityId: row.entityId,
    name: displayCtx.displayName(row.entityId),
    area: displayCtx.displayArea(row.entityId),
    displayAreaKey: displayCtx.displayAreaKey(row.entityId),
    sourceArea: displayCtx.sourceArea(row.entityId) || UNASSIGNED_AREA,
    label: displayCtx.displayLabel(row.entityId),
    sourceLabel: displayCtx.sourceLabel(row.entityId),
    lastCapturedAt: row.capturedAt.toISOString(),
  });

  const labelFilter = <T extends { label: string | null; sourceLabel?: string | null }>(rows: T[]) => {
    const visible = rows.filter((row) => displayCtx.isVisibleLabel(row.label));
    if (labelMode === 'none') return visible;
    if (labelMode === 'include') {
      return visible.filter((row) => {
        const candidates = [row.label, row.sourceLabel].filter((value): value is string => Boolean(value));
        return candidates.some((value) => normalizedInclude.has(value.toLowerCase()));
      });
    }
    return visible.filter((row) => {
      const candidates = [row.label, row.sourceLabel].filter((value): value is string => Boolean(value));
      return !candidates.some((value) => normalizedExclude.has(value.toLowerCase()));
    });
  };

  const areaFilter = <T extends { area: string }>(rows: T[]) => {
    if (!hasAreaFilter) return rows;
    return rows.filter((row) => displayCtx.matchesRequestedAreaValue(row.area || UNASSIGNED_AREA, new Set(areasFilter)));
  };

  return {
    ok: true,
    energyEntities: areaFilter(labelFilter(energyEntities.map(mapRow))),
    batteryEntities: areaFilter(labelFilter(batteryEntities.map(mapRow))),
  };
}

export async function buildAdminMonitoringBoilerEntities(args: {
  haConnectionId: number;
  searchParams: URLSearchParams;
}) {
  const { haConnectionId, searchParams } = args;
  const requestedLabel = normalizeHeatingLabel(searchParams.get('label'));
  const limitRaw = Number.parseInt(searchParams.get('limit') || '', 10);
  const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1, MAX_LIMIT);
  const rawDays = searchParams.get('days');
  const isAllTime = rawDays === 'all';
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const daysParsed = Number.parseInt(rawDays || '', 10);
  const days = clamp(Number.isFinite(daysParsed) ? daysParsed : DEFAULT_DAYS, 1, MAX_BOILER_DAYS);

  const areasFilter = parseMulti(searchParams, 'areas');
  const hasAreaFilter = areasFilter.length > 0;

  let from = startOfDayUtc(new Date(Date.now() - (days - 1) * MS_PER_DAY));
  let to = endOfDayUtc(new Date());

  if (rawFrom || rawTo) {
    const parsedFrom = parseDateOnly(rawFrom);
    const parsedTo = parseDateOnly(rawTo);
    if (!parsedFrom || !parsedTo) {
      throw new Error('Invalid from/to date. Use YYYY-MM-DD.');
    }
    if (parsedTo.getTime() < parsedFrom.getTime()) {
      throw new Error('from must be on or before to.');
    }
    const spanDays = Math.floor((endOfDayUtc(parsedTo).getTime() - startOfDayUtc(parsedFrom).getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_BOILER_DAYS && !isAllTime) {
      throw new Error(`Date range too large. Max ${MAX_BOILER_DAYS} days.`);
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
      select: { entityId: true, name: true, area: true },
    }),
  ]);

  const haMap = new Map(
    haDevices.map((d) => [d.entityId, { name: d.name ?? '', area: d.area ?? d.areaName ?? null }])
  );
  const groupLabelByEntityId = new Map(haDevices.map((d) => [d.entityId, getGroupLabel(d)]));
  const overrideMap = new Map(overrides.map((d) => [d.entityId, d]));

  const resolveDevice = (entityId: string) => {
    const ha = haMap.get(entityId);
    const override = overrideMap.get(entityId);
    const name = (override?.name ?? ha?.name ?? '').trim();
    const area = (override?.area ?? ha?.area ?? '').trim() || null;
    return { name, area };
  };

  const readings = await prisma.boilerTemperatureReading.findMany({
    where: {
      haConnectionId,
      capturedAt: { gte: from, lte: to },
    },
    distinct: ['entityId'],
    orderBy: [{ entityId: 'asc' }],
    take: limit,
    select: { entityId: true, capturedAt: true },
  });

  const displayCtx = await buildMonitoringDisplayContext({
    haConnectionId,
    entityIds: Array.from(new Set(readings.map((row) => row.entityId))),
  });

  const matchesAreaFilter = (area: string | null) => {
    if (!hasAreaFilter) return true;
    return displayCtx.matchesRequestedAreaValue(area, new Set(areasFilter));
  };

  const prettyId = (id: string) => id.replace(/^sensor\./i, '').replace(/_/g, ' ');

  const boilerEntities = readings
    .map((row) => {
      const resolved = resolveDevice(row.entityId);
      const sourceArea = resolved.area?.trim() || null;
      const area = displayCtx.displayArea(row.entityId);
      const name = displayCtx.displayName(row.entityId) || prettyId(row.entityId);
      return {
        entityId: row.entityId,
        name,
        area,
        displayAreaKey: displayCtx.displayAreaKey(row.entityId),
        sourceArea: sourceArea || UNASSIGNED_AREA,
        label: displayCtx.displayLabel(row.entityId),
        sourceLabel: displayCtx.sourceLabel(row.entityId),
        lastCapturedAt: row.capturedAt.toISOString(),
      };
    })
    .filter((row) => {
      if (!displayCtx.isVisibleLabel(row.label)) return false;
      if (!requestedLabel) return true;
      const group = groupLabelByEntityId.get(row.entityId) ?? row.sourceLabel;
      return group ? group === requestedLabel : true;
    })
    .filter((row) => matchesAreaFilter(row.area === UNASSIGNED_AREA ? null : row.area));

  return { ok: true, boilerEntities };
}

export async function buildAdminMonitoringSelectorInventory(args: {
  haConnectionId: number;
}) {
  const { haConnectionId } = args;
  const allTimeParams = new URLSearchParams();
  allTimeParams.set('days', 'all');

  const [entities, radiators, boilers, lights] = await Promise.all([
    buildAdminMonitoringEntities({ haConnectionId, searchParams: allTimeParams }),
    buildAdminMonitoringBoilerEntities({
      haConnectionId,
      searchParams: new URLSearchParams([['days', 'all'], ['label', 'Radiator']]),
    }),
    buildAdminMonitoringBoilerEntities({
      haConnectionId,
      searchParams: new URLSearchParams([['days', 'all'], ['label', 'Boiler']]),
    }),
    buildAdminElectricLightSelectors({ haConnectionId }),
  ]);

  return {
    ok: true,
    energyEntities: entities.energyEntities ?? [],
    batteryEntities: entities.batteryEntities ?? [],
    radiatorEntities: radiators.boilerEntities ?? [],
    boilerEntities: boilers.boilerEntities ?? [],
    lightEntities: lights.lightEntities ?? [],
    formerLightEntities: lights.formerLightEntities ?? [],
  };
}
