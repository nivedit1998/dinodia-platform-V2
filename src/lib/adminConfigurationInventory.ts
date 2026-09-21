// Architecture: Shared platform helper src/lib/adminConfigurationInventory.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getGroupLabel, OTHER_LABEL } from '@/lib/deviceLabels';
import { normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { prisma } from '@/lib/prisma';
import { hasTenantDeviceLabelValue, isTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';
import { listLiveMonitoringAreas } from '@/lib/adminMonitoringDisplay';

export type AdminAreaOption = {
  haAreaName: string;
  displayName: string;
  displayKey: string;
  hasOverride: boolean;
};

export type AdminAreaDisplayBucket = {
  displayName: string;
  displayKey: string;
  sourceAreaNames: string[];
};

export type AdminLabelOption = {
  sourceTechnicalLabel: string;
  canonicalLabel: string;
  displayName: string;
  displayKey: string;
  hasOverride: boolean;
};

export type AdminLabelDisplayBucket = {
  displayName: string;
  displayKey: string;
  sourceTechnicalLabels: string[];
};

function addAreasFromHubSnapshot(
  addArea: (value: string | null | undefined) => void,
  snapshot: unknown
) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const rawAreas = (snapshot as Record<string, unknown>).areas;
  if (!Array.isArray(rawAreas)) return;
  for (const row of rawAreas) {
    if (!row || typeof row !== 'object') continue;
    const name = typeof (row as Record<string, unknown>).name === 'string'
      ? ((row as Record<string, unknown>).name as string).trim()
      : '';
    if (name) addArea(name);
  }
}

export function buildAreaBuckets(areaOptions: AdminAreaOption[]): AdminAreaDisplayBucket[] {
  const buckets = new Map<string, AdminAreaDisplayBucket>();
  for (const option of areaOptions) {
    const key = option.displayKey || normalizeLookupKey(option.displayName);
    const existing = buckets.get(key);
    if (existing) {
      existing.sourceAreaNames.push(option.haAreaName);
    } else {
      buckets.set(key, {
        displayName: option.displayName,
        displayKey: key,
        sourceAreaNames: [option.haAreaName],
      });
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function buildLabelBuckets(labelOptions: AdminLabelOption[]): AdminLabelDisplayBucket[] {
  const buckets = new Map<string, AdminLabelDisplayBucket>();
  for (const option of labelOptions) {
    const key = option.displayKey || normalizeLookupKey(option.displayName);
    const existing = buckets.get(key);
    if (existing) {
      existing.sourceTechnicalLabels.push(option.sourceTechnicalLabel);
    } else {
      buckets.set(key, {
        displayName: option.displayName,
        displayKey: key,
        sourceTechnicalLabels: [option.sourceTechnicalLabel],
      });
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getAdminAreaInventory(args: {
  homeId: number;
  haConnectionId: number;
}) {
  const [accessAreas, deviceAreas, hub, liveAreas] = await Promise.all([
    prisma.accessRule.findMany({
      where: { user: { homeId: args.homeId } },
      select: { area: true },
    }),
    prisma.device.findMany({
      where: { haConnectionId: args.haConnectionId },
      select: { area: true },
    }),
    prisma.home.findUnique({
      where: { id: args.homeId },
      select: {
        hubInstall: {
          select: {
            lastReportedHaAreas: true,
            rooms: { select: { haAreaName: true } },
          },
        },
      },
    }),
    listLiveMonitoringAreas(args.haConnectionId).catch(() => []),
  ]);

  const merged = new Map<string, string>();
  const addArea = (value: string | null | undefined) => {
    const normalized = normalizeDisplayText(value);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!merged.has(key)) merged.set(key, normalized);
  };

  accessAreas.forEach((entry) => addArea(entry.area));
  deviceAreas.forEach((entry) => addArea(entry.area));
  liveAreas.forEach((area) => addArea(area));
  (hub?.hubInstall?.rooms ?? []).forEach((room) => addArea(room.haAreaName));
  addAreasFromHubSnapshot(addArea, hub?.hubInstall?.lastReportedHaAreas);

  const areas = Array.from(merged.values()).sort((a, b) => a.localeCompare(b));
  const overrides = await prisma.areaDisplayOverride.findMany({
    where: { haConnectionId: args.haConnectionId, haAreaName: { in: areas } },
  });
  const overrideMap = new Map(overrides.map((override) => [override.haAreaName, override]));
  const areaOptions = areas.map((haAreaName) => {
    const override = overrideMap.get(haAreaName);
    return {
      haAreaName,
      displayName: override?.displayName ?? haAreaName,
      displayKey: override?.displayKey ?? normalizeLookupKey(haAreaName),
      hasOverride: Boolean(override),
    };
  });

  return { areas, areaOptions, areaBuckets: buildAreaBuckets(areaOptions) };
}

export async function getAdminLabelInventory(args: {
  haConnectionId: number;
  devices?: Awaited<ReturnType<typeof getDevicesForHaConnection>>;
}) {
  const devices =
    args.devices ??
    (await getDevicesForHaConnection(args.haConnectionId, { cacheTtlMs: 2000, labelsOnly: true }));

  const sourceLabels = new Map<string, string>();
  for (const device of devices) {
    const rawLabels = device.technicalLabels ?? device.labels ?? [];
    if (hasTenantDeviceLabelValue(rawLabels)) continue;
    const groupLabel = getGroupLabel({
      label: device.label ?? null,
      labels: Array.isArray(device.labels) ? device.labels : [],
      labelCategory: device.labelCategory ?? null,
    });
    const cleaned = normalizeDisplayText(groupLabel);
    const normalizedKey = normalizeLookupKey(cleaned);
    if (
      !cleaned ||
      isTenantDeviceLabelValue(cleaned) ||
      normalizedKey === normalizeLookupKey(OTHER_LABEL)
    ) continue;
    const key = normalizedKey;
    if (!sourceLabels.has(key)) sourceLabels.set(key, cleaned);
  }

  const labels = Array.from(sourceLabels.values()).sort((a, b) => a.localeCompare(b));
  const overrides = await prisma.labelDisplayOverride.findMany({
    where: { haConnectionId: args.haConnectionId, sourceTechnicalLabel: { in: labels } },
  });
  const overrideMap = new Map(overrides.map((override) => [override.sourceTechnicalLabel, override]));
  const labelOptions = labels.map((sourceTechnicalLabel) => {
    const override = overrideMap.get(sourceTechnicalLabel);
    return {
      sourceTechnicalLabel,
      canonicalLabel: override?.canonicalLabel ?? sourceTechnicalLabel,
      displayName: override?.displayName ?? sourceTechnicalLabel,
      displayKey: override?.displayKey ?? normalizeLookupKey(sourceTechnicalLabel),
      hasOverride: Boolean(override),
    };
  });

  return {
    labels,
    labelOptions,
    labelBuckets: buildLabelBuckets(labelOptions),
    overrides,
  };
}
