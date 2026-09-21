// Architecture: Shared platform helper src/lib/deviceDisplayResolver.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { TenantDeviceCleanupStatus } from '@prisma/client';
import { normalizeLookupKey, stripTenantHaTechnicalPrefix } from '@/lib/displayNormalization';
import { getTenantOwnershipIndexForHome } from '@/lib/tenantOwnership';
import { prisma } from '@/lib/prisma';
import type { UIDevice } from '@/types/device';

export type DeviceDisplayContext =
  | { viewer: 'tenant'; userId: number; homeId: number; haConnectionId: number }
  | { viewer: 'homeowner'; userId: number; homeId: number; haConnectionId: number }
  | { viewer: 'alexa_tenant'; userId: number; homeId: number; haConnectionId: number }
  | { viewer: 'alexa_homeowner'; userId: number; homeId: number; haConnectionId: number };

function firstLabel(device: UIDevice) {
  return (device.technicalLabels ?? device.labels ?? [])
    .map((label) => label.trim())
    .find(Boolean);
}

function fallbackEntityDisplayName(entityId: string) {
  const objectId = entityId.includes('.') ? entityId.split('.').slice(1).join('.') : entityId;
  return objectId
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function cleanText(value: string | null | undefined) {
  const cleaned = (value ?? '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanNonTenantDisplayLabel(value: string | null | undefined) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  return normalizeLookupKey(cleaned) === normalizeLookupKey('tenant_device') ? null : cleaned;
}

function cleanTenantDisplayName(value: string | null | undefined) {
  return cleanText(value);
}

function groupDevicesByDeviceId(devices: UIDevice[]) {
  const groups = new Map<string, UIDevice[]>();
  for (const device of devices) {
    const deviceId = cleanText(device.deviceId);
    if (!deviceId) continue;
    const existing = groups.get(deviceId) ?? [];
    existing.push(device);
    groups.set(deviceId, existing);
  }
  return groups;
}

function firstMeaningful<T>(values: Array<T | null | undefined>, normalizer: (value: T) => string | number | null) {
  for (const value of values) {
    if (value == null) continue;
    const normalized = normalizer(value);
    if (normalized != null && `${normalized}`.length > 0) {
      return value;
    }
  }
  return null;
}

function pickRepresentativeGroupArea(group: UIDevice[]) {
  const labelled = group.filter((device) =>
    (device.technicalLabels ?? device.labels ?? []).some((label) => cleanText(label))
  );
  const candidates = labelled.length > 0 ? labelled : group;
  return (
    candidates
      .map((device) => cleanText(device.areaName) ?? cleanText(device.area))
      .find(Boolean) ?? null
  );
}

export function inferCanonicalLabel(device: UIDevice): string {
  const domain = device.domain || device.entityId.split('.')[0] || '';
  const friendlyName =
    typeof device.attributes?.friendly_name === 'string' ? device.attributes.friendly_name : '';
  const hints = [
    device.entityId,
    device.name,
    friendlyName,
    device.label,
    device.labelCategory,
    ...(device.technicalLabels ?? device.labels ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (domain === 'cover') return 'Blind';
  if (domain === 'light') return 'Light';
  if (domain === 'switch') {
    if (hints.includes('kettle')) return 'Kettle';
    if (hints.includes('boiler')) return 'Boiler';
    if (hints.includes('light') || hints.includes('lamp') || hints.includes('spotlight')) return 'Light';
    return 'Switch';
  }
  if (domain === 'climate') {
    if (hints.includes('boiler')) return 'Boiler';
    if (hints.includes('radiator')) return 'Radiator';
    return 'Thermostat';
  }
  if (domain === 'media_player') {
    if (hints.includes('tv')) return 'TV';
    if (hints.includes('spotify')) return 'Spotify';
    return 'Speaker';
  }
  if (domain === 'binary_sensor') {
    if (hints.includes('motion') || hints.includes('occupancy')) return 'Motion Sensor';
    return 'Sensor';
  }
  if (domain === 'sensor') return 'Sensor';
  if (domain === 'button') return 'Button';
  return device.labelCategory || firstLabel(device) || domain || 'Other';
}

export async function resolveDeviceDisplayBatch(
  devices: UIDevice[],
  context: DeviceDisplayContext
): Promise<UIDevice[]> {
  if (devices.length === 0) return devices;

  const [deviceOverrides, areaOverrides, labelOverrides, tenantOverrides, ownershipIndex] =
    await Promise.all([
      prisma.device.findMany({
        where: { haConnectionId: context.haConnectionId },
        select: { entityId: true, name: true, area: true, label: true, blindTravelSeconds: true },
      }),
      prisma.areaDisplayOverride.findMany({
        where: { haConnectionId: context.haConnectionId },
      }),
      prisma.labelDisplayOverride.findMany({
        where: { haConnectionId: context.haConnectionId },
      }),
      prisma.tenantDeviceDisplayOverride.findMany({
        where: { haConnectionId: context.haConnectionId },
        include: { tenantVirtualArea: true },
      }),
      getTenantOwnershipIndexForHome({
        homeId: context.homeId,
        haConnectionId: context.haConnectionId,
        currentTenantUserId:
          context.viewer === 'tenant' || context.viewer === 'alexa_tenant'
            ? context.userId
            : undefined,
      }),
    ]);

  const deviceOverrideMap = new Map(deviceOverrides.map((override) => [override.entityId, override]));
  const devicesByDeviceId = groupDevicesByDeviceId(devices);
  const groupedLegacyOverrides = new Map<
    string,
    { name: string | null; area: string | null; label: string | null; blindTravelSeconds: number | null }
  >();
  for (const [deviceId, group] of devicesByDeviceId.entries()) {
    const overridesForGroup = group
      .map((device) => deviceOverrideMap.get(device.entityId))
      .filter((override): override is NonNullable<typeof override> => Boolean(override));
    groupedLegacyOverrides.set(deviceId, {
      name:
        firstMeaningful(overridesForGroup.map((override) => override.name), (value) => cleanText(value)) as string | null,
      area:
        firstMeaningful(overridesForGroup.map((override) => override.area), (value) => cleanText(value)) as string | null,
      label:
        firstMeaningful(overridesForGroup.map((override) => override.label), (value) => cleanText(value)) as string | null,
      blindTravelSeconds:
        (firstMeaningful(
          overridesForGroup.map((override) => override.blindTravelSeconds),
          (value) => (value == null ? null : value)
        ) as number | null) ?? null,
    });
  }
  const areaOverrideMap = new Map(
    areaOverrides.map((override) => [override.haAreaName, override])
  );
  const labelOverrideMap = new Map(
    labelOverrides.map((override) => [normalizeLookupKey(override.sourceTechnicalLabel), override])
  );
  const tenantOverrideByDevice = new Map(
    tenantOverrides
      .filter((override) => override.haDeviceId)
      .map((override) => [override.haDeviceId!, override])
  );
  const tenantOverrideByEntity = new Map(
    tenantOverrides
      .filter((override) => override.entityId)
      .map((override) => [override.entityId!, override])
  );

  const resolved: UIDevice[] = devices.map((device): UIDevice => {
    const group = cleanText(device.deviceId) ? devicesByDeviceId.get(cleanText(device.deviceId)!) ?? [device] : [device];
    const deviceLevelTenantOverride = device.deviceId ? tenantOverrideByDevice.get(device.deviceId) : undefined;
    const entityLevelTenantOverride = tenantOverrideByEntity.get(device.entityId);
    const groupEntityOverrides = group
      .map((member) => tenantOverrideByEntity.get(member.entityId))
      .filter((override): override is NonNullable<typeof override> => Boolean(override));
    const tenantOverride =
      deviceLevelTenantOverride ??
      entityLevelTenantOverride ??
      groupEntityOverrides[0];
    const sourceName =
      device.name?.trim() ||
      (typeof device.attributes?.friendly_name === 'string' ? device.attributes.friendly_name.trim() : '') ||
      fallbackEntityDisplayName(device.entityId);
    const preCanonicalLabel = inferCanonicalLabel({ ...device, name: sourceName });

    if (tenantOverride) {
      const pending =
        tenantOverride.cleanupStatus === TenantDeviceCleanupStatus.PENDING_DEVICE_CLEANUP;
      const displayName =
        (firstMeaningful(
          [
            deviceLevelTenantOverride?.displayName,
            tenantOverride.displayName,
            ...groupEntityOverrides.map((override) => override.displayName),
          ],
          (value) => cleanText(value)
        ) as string | null) ||
        stripTenantHaTechnicalPrefix(tenantOverride.tenantUserId, sourceName) ||
        sourceName;
      const rawParentAreaName =
        (firstMeaningful(
          [
            deviceLevelTenantOverride?.parentHaAreaName,
            tenantOverride.parentHaAreaName,
            ...groupEntityOverrides.map((override) => override.parentHaAreaName),
            device.areaName,
            device.area,
          ],
          (value) => cleanText(value)
        ) as string | null) || null;
      const parentAreaName = rawParentAreaName;
      const areaAlias = rawParentAreaName ? areaOverrideMap.get(rawParentAreaName)?.displayName : null;
      const displayAreaName =
        tenantOverride.tenantVirtualArea?.displayName || areaAlias || parentAreaName;
      const displayLabel =
        (firstMeaningful(
          [
            deviceLevelTenantOverride?.displayLabel,
            tenantOverride.displayLabel,
            ...groupEntityOverrides.map((override) => override.displayLabel),
            ...group.flatMap((member) => [
              member.displayLabel,
              member.label,
              member.sourceTechnicalLabel,
              ...(member.technicalLabels ?? member.labels ?? []),
            ]),
            preCanonicalLabel,
          ],
          (value) => cleanNonTenantDisplayLabel(value as string | null | undefined)
        ) as string | null) || 'Device';
      const canonicalLabel = tenantOverride.canonicalLabel ?? preCanonicalLabel;
      return {
        ...device,
        sourceName,
        sourceAreaName: rawParentAreaName,
        sourceTechnicalLabel: firstLabel(device) || device.label || device.labelCategory || preCanonicalLabel,
        name: displayName,
        area: displayAreaName,
        areaName: displayAreaName,
        label: displayLabel,
        labelCategory: canonicalLabel,
        displayName,
        displayAreaName,
        parentAreaName,
        canonicalLabel,
        displayLabel,
        displayLabelKey: tenantOverride.displayLabelKey || normalizeLookupKey(displayLabel),
        ownership: pending ? 'pending_cleanup' : 'tenant_owned',
        tenantVirtualAreaId: tenantOverride.tenantVirtualAreaId,
        haTechnicalName: tenantOverride.haTechnicalName,
      };
    }

    const legacyOverride = deviceOverrideMap.get(device.entityId);
    const groupedLegacyOverride = cleanText(device.deviceId)
      ? groupedLegacyOverrides.get(cleanText(device.deviceId)!)
      : null;
    const ownerFromIndex =
      (device.deviceId ? ownershipIndex.allTenantDeviceIds.get(device.deviceId) : undefined) ??
      ownershipIndex.allTenantEntityIds.get(device.entityId);
    const sourceAreaName =
      cleanText(device.areaName) ??
      cleanText(device.area) ??
      pickRepresentativeGroupArea(group) ??
      groupedLegacyOverride?.area ??
      cleanText(legacyOverride?.area) ??
      null;
    const sourceTechnicalLabel =
      groupedLegacyOverride?.label ||
      cleanText(legacyOverride?.label) ||
      firstLabel(device) ||
      cleanText(device.label) ||
      cleanText(device.labelCategory) ||
      preCanonicalLabel;
    const capabilityDevice = {
      ...device,
      name: sourceName,
      label: sourceTechnicalLabel,
      labelCategory: device.labelCategory ?? sourceTechnicalLabel,
      technicalLabels: device.technicalLabels ?? device.labels ?? [sourceTechnicalLabel],
    };
    const canonicalLabel = inferCanonicalLabel(capabilityDevice);
    const displayAreaName = sourceAreaName
      ? areaOverrideMap.get(sourceAreaName)?.displayName ?? sourceAreaName
      : null;
    const labelAlias = labelOverrideMap.get(normalizeLookupKey(sourceTechnicalLabel));
    const displayLabel = labelAlias?.displayName ?? sourceTechnicalLabel;
    const pending =
      (device.deviceId ? ownershipIndex.pendingDeviceIds.has(device.deviceId) : false) ||
      ownershipIndex.pendingEntityIds.has(device.entityId);

    const preferredDisplayName =
      groupedLegacyOverride?.name ||
      cleanText(legacyOverride?.name) ||
      sourceName;
    const fallbackTenantOwned = ownerFromIndex != null;
    const fallbackTenantName = fallbackTenantOwned
      ? stripTenantHaTechnicalPrefix(ownerFromIndex, preferredDisplayName) ||
        preferredDisplayName ||
        sourceName
      : preferredDisplayName;

    return {
      ...device,
      sourceName,
      sourceAreaName,
      sourceTechnicalLabel,
      name: fallbackTenantName,
      area: displayAreaName,
      areaName: displayAreaName,
      label: displayLabel,
      labelCategory: canonicalLabel,
      displayName: fallbackTenantName,
      displayAreaName,
      canonicalLabel,
      displayLabel,
      displayLabelKey: normalizeLookupKey(displayLabel),
      ownership: pending ? 'pending_cleanup' : fallbackTenantOwned ? 'tenant_owned' : 'installer',
      blindTravelSeconds:
        groupedLegacyOverride?.blindTravelSeconds != null
          ? groupedLegacyOverride.blindTravelSeconds
          : legacyOverride?.blindTravelSeconds != null
            ? legacyOverride.blindTravelSeconds
          : device.blindTravelSeconds ?? null,
    };
  });

  const resolvedByDeviceId = groupDevicesByDeviceId(resolved);
  const canonicalTenantByDeviceId = new Map<
    string,
    {
      displayName: string | null;
      displayAreaName: string | null;
      parentAreaName: string | null;
      displayLabel: string | null;
      displayLabelKey: string | null;
      canonicalLabel: string | null;
      sourceName: string | null;
      sourceAreaName: string | null;
      sourceTechnicalLabel: string | null;
      haTechnicalName: string | null;
      tenantVirtualAreaId: string | null;
    }
  >();

  for (const [deviceId, group] of resolvedByDeviceId.entries()) {
    const tenantGroup = group.filter((device) => device.ownership === 'tenant_owned');
    if (tenantGroup.length === 0) continue;

    const canonicalDisplayName =
      (firstMeaningful(
        tenantGroup.map((device) => device.displayName),
        (value) => cleanTenantDisplayName(value)
      ) as string | null) ||
      (firstMeaningful(
        tenantGroup.map((device) => stripTenantHaTechnicalPrefix(context.viewer === 'tenant' || context.viewer === 'alexa_tenant' ? context.userId : 0, device.haTechnicalName ?? device.name)),
        (value) => cleanTenantDisplayName(value)
      ) as string | null) ||
      (firstMeaningful(
        tenantGroup.flatMap((device) => [device.sourceName, device.name]),
        (value) => cleanTenantDisplayName(value)
      ) as string | null);

    const canonicalDisplayLabel =
      (firstMeaningful(
        tenantGroup.flatMap((device) => [
          device.displayLabel,
          device.label,
          device.sourceTechnicalLabel,
          ...(device.technicalLabels ?? device.labels ?? []),
        ]),
        (value) => cleanNonTenantDisplayLabel(value as string | null | undefined)
      ) as string | null) || 'Device';

    canonicalTenantByDeviceId.set(deviceId, {
      displayName: canonicalDisplayName,
      displayAreaName:
        (firstMeaningful(
          tenantGroup.map((device) => device.displayAreaName),
          (value) => cleanText(value)
        ) as string | null) ||
        (firstMeaningful(
          tenantGroup.map((device) => device.parentAreaName),
          (value) => cleanText(value)
        ) as string | null),
      parentAreaName:
        (firstMeaningful(
          tenantGroup.map((device) => device.parentAreaName),
          (value) => cleanText(value)
        ) as string | null) ||
        (firstMeaningful(
          tenantGroup.map((device) => device.sourceAreaName),
          (value) => cleanText(value)
        ) as string | null),
      displayLabel: canonicalDisplayLabel,
      displayLabelKey: normalizeLookupKey(canonicalDisplayLabel),
      canonicalLabel:
        (firstMeaningful(
          tenantGroup.map((device) => device.canonicalLabel),
          (value) => cleanText(value)
        ) as string | null) ||
        canonicalDisplayLabel,
      sourceName: firstMeaningful(
        tenantGroup.map((device) => device.sourceName),
        (value) => cleanText(value)
      ) as string | null,
      sourceAreaName: firstMeaningful(
        tenantGroup.map((device) => device.sourceAreaName),
        (value) => cleanText(value)
      ) as string | null,
      sourceTechnicalLabel: firstMeaningful(
        tenantGroup.map((device) => device.sourceTechnicalLabel),
        (value) => cleanText(value)
      ) as string | null,
      haTechnicalName: firstMeaningful(
        tenantGroup.map((device) => device.haTechnicalName),
        (value) => cleanText(value)
      ) as string | null,
      tenantVirtualAreaId: firstMeaningful(
        tenantGroup.map((device) => device.tenantVirtualAreaId),
        (value) => cleanText(value)
      ) as string | null,
    });
  }

  return resolved.map((device): UIDevice => {
    const normalizedDeviceId = cleanText(device.deviceId);
    if (!normalizedDeviceId || device.ownership !== 'tenant_owned') {
      return device;
    }
    const canonical = canonicalTenantByDeviceId.get(normalizedDeviceId);
    if (!canonical) return device;
    return {
      ...device,
      name: canonical.displayName || device.name,
      displayName: canonical.displayName || device.displayName,
      area: canonical.displayAreaName || device.area,
      areaName: canonical.displayAreaName || device.areaName,
      displayAreaName: canonical.displayAreaName || device.displayAreaName,
      parentAreaName: canonical.parentAreaName || device.parentAreaName,
      label: canonical.displayLabel || device.label,
      labelCategory: canonical.canonicalLabel || device.labelCategory,
      displayLabel: canonical.displayLabel || device.displayLabel,
      displayLabelKey: canonical.displayLabelKey || device.displayLabelKey,
      canonicalLabel: canonical.canonicalLabel || device.canonicalLabel,
      sourceName: canonical.sourceName || device.sourceName,
      sourceAreaName: canonical.sourceAreaName || device.sourceAreaName,
      sourceTechnicalLabel: canonical.sourceTechnicalLabel || device.sourceTechnicalLabel,
      haTechnicalName: canonical.haTechnicalName || device.haTechnicalName,
      tenantVirtualAreaId: canonical.tenantVirtualAreaId || device.tenantVirtualAreaId,
    };
  });
}
