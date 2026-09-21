// Architecture: Shared platform helper src/lib/deviceIdentity.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import type { UIDevice } from '@/types/device';

const SENSOR_NAME_SUFFIXES = [
  'temperature',
  'humidity',
  'power',
  'voltage',
  'current',
  'illuminance',
  'pressure',
  'energy',
  'battery',
  'battery level',
  'consumption',
  'status',
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripSensorSuffix(normalizedName: string) {
  for (const suffix of SENSOR_NAME_SUFFIXES) {
    const pattern = new RegExp(`\\b${suffix}$`);
    if (pattern.test(normalizedName)) {
      const trimmed = normalizedName.replace(pattern, '').trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return normalizedName;
}

export function buildFallbackDeviceId(input: {
  entityId: string;
  name?: string | null;
  areaName?: string | null;
  area?: string | null;
}) {
  // Best-effort grouping when HA doesn't expose a device_id: area + base name,
  // stripping obvious sensor suffixes (temperature, humidity, etc.).
  const area = normalize((input.area ?? input.areaName ?? '').toString());
  if (!area) return null;
  const areaKey = area.replace(/\s+/g, '_');
  const objectId = input.entityId.split('.')[1] || input.entityId;
  const baseName = normalize(input.name ?? objectId);
  if (!baseName) return null;
  const core = stripSensorSuffix(baseName);
  if (!core) return null;
  const coreKey = core.replace(/\s+/g, '_');
  // Prefixed so we can safely improve/replace this heuristic later without
  // colliding with real HA device_ids.
  return `fallback:${areaKey}:${coreKey}`;
}

export function getDeviceGroupingId(device: UIDevice) {
  return device.deviceId ?? buildFallbackDeviceId({
    entityId: device.entityId,
    name: device.name,
    areaName: device.area ?? device.areaName,
  });
}
