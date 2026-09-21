// Architecture: API boundary /admin/device-overrides; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { prisma } from '@/lib/prisma';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getDeviceGroupingId } from '@/lib/deviceIdentity';
import { getGroupLabel } from '@/lib/deviceLabels';
import { isSensorEntity } from '@/lib/deviceSensors';
import { getTileEligibleDevicesForTenantDashboard } from '@/lib/deviceCapabilities';
import { resolveDeviceDisplayBatch } from '@/lib/deviceDisplayResolver';
import { getTenantOwnershipIndexForHome } from '@/lib/tenantOwnership';
import type { UIDevice } from '@/types/device';
import { safeLog } from '@/lib/safeLogger';
import { getAdminAreaInventory, getAdminLabelInventory } from '@/lib/adminConfigurationInventory';
import { hasTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 90;
const MAX_LOOKBACK_DAYS = 180;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  let homeId: number;
  let haConnectionId: number;
  try {
    const { user, haConnection } = await getUserWithHaConnection(me.id);
    homeId = user.homeId!;
    haConnectionId = haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Dinodia Hub connection is missing for this home.' },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const limitRaw = Number.parseInt(searchParams.get('limit') || '', 10);
  const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1, MAX_LIMIT);

  const daysRaw = Number.parseInt(searchParams.get('days') || '', 10);
  const lookbackDays = clamp(Number.isFinite(daysRaw) ? daysRaw : DEFAULT_LOOKBACK_DAYS, 1, MAX_LOOKBACK_DAYS);
  const fromDate = new Date(Date.now() - lookbackDays * MS_PER_DAY);

  const deviceWhere = {
    haConnectionId,
    ...(q
      ? {
          OR: [
            { entityId: { contains: q, mode: 'insensitive' as const } },
            { name: { contains: q, mode: 'insensitive' as const } },
            { area: { contains: q, mode: 'insensitive' as const } },
            { label: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const overrides = await prisma.device.findMany({
    where: deviceWhere,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: {
      entityId: true,
      name: true,
      label: true,
      area: true,
      blindTravelSeconds: true,
      boilerPowerKw: true,
      heatingPricePerKwh: true,
      boilerEfficiencyBand: true,
      updatedAt: true,
      id: true,
    },
  });

  const overrideMap = new Map(overrides.map((d) => [d.entityId, d]));

  type HaDevice = Awaited<ReturnType<typeof getDevicesForHaConnection>>[number];
  let haDevices: HaDevice[] = [];
  try {
    haDevices = await getDevicesForHaConnection(haConnectionId, { cacheTtlMs: 2000 });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      safeLog('warn', 'HA device fetch failed, falling back to overrides only', { err, haConnectionId });
    }
  }

  const observedRows = await prisma.monitoringReading.findMany({
    where: {
      haConnectionId,
      capturedAt: { gte: fromDate },
      OR: [
        { unit: 'kWh' },
        { unit: '%', entityId: { contains: 'battery', mode: 'insensitive' as const } },
      ],
      ...(q ? { entityId: { contains: q, mode: 'insensitive' as const } } : {}),
    },
    orderBy: [{ entityId: 'asc' }, { capturedAt: 'desc' }],
    select: { entityId: true, unit: true, capturedAt: true },
  });

  const observedByEntity = new Map<string, { entityId: string; unit: string | null; capturedAt: Date }>();
  for (const row of observedRows) {
    if (!observedByEntity.has(row.entityId)) {
      observedByEntity.set(row.entityId, {
        entityId: row.entityId,
        unit: row.unit ?? null,
        capturedAt: row.capturedAt,
      });
    }
  }

  const deviceSet = new Set(overrides.map((d) => d.entityId));
  const prettyId = (id: string) => id.replace(/^sensor\./i, '').replace(/_/g, ' ');
  const deviceByEntity = new Map(overrides.map((d) => [d.entityId, d]));
  const cleanLabel = (value?: string | null) => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower === 'sensor' || lower === '-') return null;
    return trimmed;
  };

  const inferLabel = (entityId: string, existing?: string | null) => {
    const cleaned = cleanLabel(existing);
    if (cleaned) return cleaned;
    const id = entityId.toLowerCase();
    if (id.includes('blind')) return 'Blind';
    if (id.includes('motion')) return 'Motion Sensor';
    if (id.includes('spotify')) return 'Spotify';
    if (id.includes('boiler')) return 'Boiler';
    if (id.includes('doorbell')) return 'Doorbell';
    if (id.includes('security')) return 'Home Security';
    if (id.includes('tv')) return 'TV';
    if (id.includes('speaker')) return 'Speaker';
    if (id.includes('light') || id.includes('lamp')) return 'Light';
    return null;
  };
  const displayName = (entityId: string) => {
    const device = deviceByEntity.get(entityId);
    const primary = device?.name?.trim();
    const fallback = device?.label?.trim();
    const base = primary || fallback || entityId;
    return prettyId(base).trim() || entityId;
  };

  const observedEntities = Array.from(observedByEntity.values()).map((row) => ({
    entityId: row.entityId,
    name: displayName(row.entityId),
    label: inferLabel(row.entityId, deviceByEntity.get(row.entityId)?.label),
    unit: row.unit,
    lastCapturedAt: row.capturedAt.toISOString(),
    hasOverride: deviceSet.has(row.entityId),
  }));

  type MergedDevice = {
    entityId: string;
    name: string;
    area: string | null;
    label: string | null;
    blindTravelSeconds: number | null;
    boilerPowerKw: number | null;
    heatingPricePerKwh: number | null;
    boilerEfficiencyBand: string | null;
    deviceId?: string | null;
    hasOverride: boolean;
    labelCategory?: string | null;
    labels?: string[] | null;
    state?: string | null;
    areaName?: string | null;
    domain?: string | null;
    attributes?: Record<string, unknown> | null;
  };

  const toUIDevice = (d: MergedDevice): UIDevice => ({
    entityId: d.entityId,
    deviceId: d.deviceId ?? null,
    name: d.name,
    state: d.state ?? '',
    area: d.area ?? d.areaName ?? null,
    areaName: d.area ?? d.areaName ?? null,
    labels: d.labels ?? [],
    label: d.label ?? null,
    labelCategory: d.labelCategory ?? null,
    domain: d.domain ?? '',
    attributes: d.attributes ?? {},
    blindTravelSeconds: d.blindTravelSeconds ?? null,
  });

  // Build unified device list: HA devices + override-only rows
  const mergedMap = new Map<string, MergedDevice>();

  haDevices.forEach((d) => {
    const override = overrideMap.get(d.entityId);
    const name = (override?.name ?? d.name ?? prettyId(d.entityId)).trim();
    const area = (override?.area ?? d.area ?? d.areaName ?? '').trim() || null;
    const overrideLabel = cleanLabel(override?.label) || null;
    const groupLabel = getGroupLabel({
      label: overrideLabel,
      labels: Array.isArray(d.labels) ? d.labels : [],
      labelCategory: d.labelCategory ?? null,
    });
    mergedMap.set(d.entityId, {
      entityId: d.entityId,
      name: name || prettyId(d.entityId),
      area,
      label: groupLabel,
      blindTravelSeconds:
        override?.blindTravelSeconds ?? (typeof d.blindTravelSeconds === 'number' ? d.blindTravelSeconds : null),
      boilerPowerKw:
        typeof override?.boilerPowerKw === 'number'
          ? override.boilerPowerKw
          : null,
      heatingPricePerKwh:
        typeof override?.heatingPricePerKwh === 'number'
          ? override.heatingPricePerKwh
          : null,
      boilerEfficiencyBand:
        typeof override?.boilerEfficiencyBand === 'string'
          ? override.boilerEfficiencyBand
          : null,
      deviceId: d.deviceId ?? null,
      hasOverride: Boolean(override),
      labelCategory: d.labelCategory ?? null,
      labels: Array.isArray(d.labels) ? d.labels : null,
      state: d.state ?? null,
      areaName: d.areaName ?? null,
      domain: d.domain ?? null,
      attributes: d.attributes ?? null,
    });
  });

  overrides.forEach((ov) => {
    if (mergedMap.has(ov.entityId)) return;
    const groupLabel = getGroupLabel({
      label: cleanLabel(ov.label) ?? null,
      labels: [],
      labelCategory: cleanLabel(ov.label) ?? null,
    });
    mergedMap.set(ov.entityId, {
      entityId: ov.entityId,
      name: (ov.name || prettyId(ov.entityId)).trim(),
      area: ov.area?.trim() || null,
      label: groupLabel,
      blindTravelSeconds: typeof ov.blindTravelSeconds === 'number' ? ov.blindTravelSeconds : null,
      boilerPowerKw: typeof ov.boilerPowerKw === 'number' ? ov.boilerPowerKw : null,
      heatingPricePerKwh: typeof ov.heatingPricePerKwh === 'number' ? ov.heatingPricePerKwh : null,
      boilerEfficiencyBand: typeof ov.boilerEfficiencyBand === 'string' ? ov.boilerEfficiencyBand : null,
      deviceId: null,
      hasOverride: true,
    });
  });

  const isAssigned = (area: string | null | undefined) => {
    if (!area) return false;
    return area.trim().toLowerCase() !== 'unassigned';
  };

  const mergedList: MergedDevice[] = Array.from(mergedMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  const applySearch = (list: MergedDevice[]) => {
    if (!q) return list;
    const needle = q.toLowerCase();
    return list.filter((item) =>
      item.entityId.toLowerCase().includes(needle) ||
      (item.name ?? '').toLowerCase().includes(needle) ||
      (item.area ?? '').toLowerCase().includes(needle) ||
      (item.label ?? '').toLowerCase().includes(needle)
    );
  };

  const ownershipIndex = await getTenantOwnershipIndexForHome({ homeId, haConnectionId });
  const filteredDevices = applySearch(mergedList).filter((d) => {
    if (!isAssigned(d.area ?? d.areaName)) return false;
    if (d.deviceId && ownershipIndex.allTenantDeviceIds.has(d.deviceId)) return false;
    if (ownershipIndex.allTenantEntityIds.has(d.entityId)) return false;
    if (hasTenantDeviceLabelValue(d.labels ?? [])) return false;
    return true;
  });

  // Build tile-eligibility set using tenant dashboard rules
  const uidDevices = filteredDevices.map((d) => toUIDevice(d));
  const tileEligibleSet = new Set(
    getTileEligibleDevicesForTenantDashboard(uidDevices).map((d) => d.entityId)
  );

  // Group by device grouping id to mirror tenant dashboard and pick a single primary per group
  const groups = new Map<string, MergedDevice[]>();
  filteredDevices.forEach((dev) => {
    const key = getDeviceGroupingId(toUIDevice(dev));
    if (!key) return;
    if (!groups.has(key)) groups.set(key, [] as MergedDevice[]);
    groups.get(key)!.push(dev);
  });

  const primaries: MergedDevice[] = [];
  const linkedSensorsByPrimary = new Map<string, MergedDevice[]>();

  groups.forEach((devices) => {
    // Only consider members that are tile-eligible
    const eligibleMembers = devices.filter((d) => tileEligibleSet.has(d.entityId));
    if (eligibleMembers.length === 0) return;

    const sorted = eligibleMembers
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId));

    const nonSensors = sorted.filter((d) => !isSensorEntity(toUIDevice(d)));
    const primary =
      nonSensors.find((d) => d.hasOverride) ||
      nonSensors[0] ||
      sorted[0];
    primaries.push(primary);
    const linked = devices.filter(
      (d) => d.entityId !== primary.entityId && isSensorEntity(toUIDevice(d))
    );
    linkedSensorsByPrimary.set(primary.entityId, linked);
  });

  const limitedPrimaries = primaries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);

  const resolvedPrimaries = await resolveDeviceDisplayBatch(
    limitedPrimaries.map((d) => toUIDevice(d)),
    { viewer: 'homeowner', userId: me.id, homeId, haConnectionId }
  );
  const resolvedByEntity = new Map(resolvedPrimaries.map((device) => [device.entityId, device]));
  const [areaInventory, labelInventory] = await Promise.all([
    getAdminAreaInventory({ homeId, haConnectionId }),
    getAdminLabelInventory({ haConnectionId, devices: haDevices }),
  ]);

  return NextResponse.json({
    ok: true,
    ...areaInventory,
    labels: labelInventory.labels,
    labelOptions: labelInventory.labelOptions,
    labelBuckets: labelInventory.labelBuckets,
    devices: limitedPrimaries.map((d) => {
      const linked = linkedSensorsByPrimary.get(d.entityId) ?? [];
      const resolved = resolvedByEntity.get(d.entityId);
      return {
        entityId: d.entityId,
        name: resolved?.name ?? d.name,
        area: resolved?.area ?? d.area,
        label: resolved?.label ?? d.label,
        sourceAreaName: d.area ?? null,
        sourceTechnicalLabel: d.label ?? null,
        displayName: resolved?.displayName ?? d.name,
        displayAreaName: resolved?.displayAreaName ?? d.area,
        canonicalLabel: resolved?.canonicalLabel ?? d.labelCategory ?? null,
        displayLabel: resolved?.displayLabel ?? d.label,
        displayLabelKey: resolved?.displayLabelKey ?? null,
        ownership: resolved?.ownership ?? 'installer',
        blindTravelSeconds: d.blindTravelSeconds,
        boilerPowerKw: d.boilerPowerKw,
        heatingPricePerKwh: d.heatingPricePerKwh,
        boilerEfficiencyBand: d.boilerEfficiencyBand,
        hasOverride: d.hasOverride,
        linkedSensors: linked.map((ls) => ({
          entityId: ls.entityId,
          name: ls.name,
          label: ls.label,
          boilerPowerKw: ls.boilerPowerKw,
          heatingPricePerKwh: ls.heatingPricePerKwh,
          boilerEfficiencyBand: ls.boilerEfficiencyBand,
          unit: undefined,
          lastCapturedAt: undefined,
        })),
      };
    }),
    observedEntities,
  });
}
