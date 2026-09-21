// Architecture: Shared platform helper src/lib/deviceCapabilities.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getGroupLabel, OTHER_LABEL } from '@/lib/deviceLabels';
import { getDeviceCapabilityModel } from '@/lib/haEntityCapabilities';
import type {
  ActionSurface,
  DeviceActionSpec,
  DeviceServiceSpec,
  DeviceTriggerSpec,
} from '@/lib/haEntityCapabilities';
import { isDetailState } from '@/lib/deviceSensors';
import { UIDevice } from '@/types/device';

export const DEVICE_COMMANDS = [
  'light/turn_on',
  'light/turn_off',
  'light/toggle',
  'light/set_brightness',
  'blind/set_position',
  'blind/open',
  'blind/close',
  'media/play_pause',
  'media/next',
  'media/previous',
  'media/volume_set',
  'media/volume_up',
  'media/volume_down',
  'tv/turn_on',
  'tv/turn_off',
  'tv/toggle_power',
  'speaker/turn_on',
  'speaker/turn_off',
  'speaker/toggle_power',
  'boiler/turn_on',
  'boiler/turn_off',
  'boiler/temp_up',
  'boiler/temp_down',
  'boiler/set_temperature',
] as const;

export type DeviceCommandId = (typeof DEVICE_COMMANDS)[number];

export const CAPABILITY_LABELS = [
  'Light',
  'Blind',
  'Motion Sensor',
  'Spotify',
  'Boiler',
  'Radiator',
  'Sockets',
  'Doorbell',
  'Home Security',
  'TV',
  'Speaker',
] as const;

export const CAPABILITIES = {
  Light: {},
  Blind: {},
  'Motion Sensor': {},
  Spotify: {},
  Boiler: {},
  Radiator: {},
  Sockets: {},
  Doorbell: {},
  'Home Security': {},
  TV: {},
  Speaker: {},
} as Record<(typeof CAPABILITY_LABELS)[number], Record<string, never>>;

export type { ActionSurface, DeviceActionSpec, DeviceTriggerSpec, DeviceServiceSpec };

export function isDeviceCommandId(value: unknown): value is DeviceCommandId {
  return typeof value === 'string' && (DEVICE_COMMANDS as readonly string[]).includes(value);
}

export function isCapabilityLabel(value: unknown): value is (typeof CAPABILITY_LABELS)[number] {
  return typeof value === 'string' && (CAPABILITY_LABELS as readonly string[]).includes(value);
}

function isSurfaceAllowed(spec: { surfaces?: ActionSurface[] }, surface: ActionSurface) {
  return !spec.surfaces || spec.surfaces.includes(surface);
}

export function getCapabilitiesForDevice(device: UIDevice) {
  return getDeviceCapabilityModel(device);
}

export function isAutomationExcluded(device: UIDevice) {
  return getCapabilitiesForDevice(device).excludeFromAutomations === true;
}

export function getActionsForDevice(
  device: UIDevice,
  surface: ActionSurface = 'dashboard'
): DeviceActionSpec[] {
  return getCapabilitiesForDevice(device).actions.filter((action) => isSurfaceAllowed(action, surface));
}

export function getTriggersForDevice(
  device: UIDevice,
  surface: ActionSurface = 'automation'
): DeviceTriggerSpec[] {
  return getCapabilitiesForDevice(device).triggers.filter((trigger) =>
    isSurfaceAllowed(trigger, surface)
  );
}

export function getAdvancedServicesForDevice(device: UIDevice): DeviceServiceSpec[] {
  return getCapabilitiesForDevice(device).advancedServices;
}

export function getTileEligibleDevicesForTenantDashboard(devices: UIDevice[]) {
  return devices.filter((d) => {
    if (!isDashboardVisibleDevice(d)) return false;
    const cap = getCapabilitiesForDevice(d);
    if (!cap) return false;
    const primary = !isDetailState(d.state) || cap.label === 'Motion Sensor';
    return primary;
  });
}

export function getTenantDashboardDevices(devices: UIDevice[]) {
  // Phase 2 source of truth: match what the tenant dashboard can meaningfully render as a tile.
  // Intentionally does not apply "excludeFromAutomations" filtering; automations can filter separately.
  return devices.filter((d) => {
    const cap = getCapabilitiesForDevice(d);
    if (!cap) return false;
    return isDashboardVisibleDevice(d);
  });
}

export function getPrimaryAutomationActions(device: UIDevice): DeviceActionSpec[] {
  // Primary = same surface used by tenant dashboard device cards.
  return getActionsForDevice(device, 'dashboard');
}

export function getAdvancedAutomationServices(device: UIDevice): DeviceServiceSpec[] {
  // Advanced = dashboard "Advanced services" section (service-name based).
  return getAdvancedServicesForDevice(device);
}

export function getDashboardLevelTriggers(device: UIDevice): DeviceTriggerSpec[] {
  // Triggers are limited to the dashboard-level concepts exposed in the tenant UI.
  return getTriggersForDevice(device, 'automation').filter((trigger) => {
    return (
      trigger.type === 'state_equals' ||
      trigger.type === 'attribute_delta' ||
      trigger.type === 'position_equals'
    );
  });
}

export function getEligibleDevicesForAutomations(devices: UIDevice[]) {
  return devices.filter((d) => {
    if (!isDashboardVisibleDevice(d)) return false;
    const cap = getCapabilitiesForDevice(d);
    if (!cap || cap.excludeFromAutomations) return false;
    return true;
  });
}

export function hasDashboardVisibilityLabel(device: Pick<
  UIDevice,
  'label' | 'labels' | 'technicalLabels' | 'displayLabel' | 'canonicalLabel' | 'sourceTechnicalLabel'
>) {
  const candidates = [
    device.displayLabel,
    device.label,
    device.canonicalLabel,
    device.sourceTechnicalLabel,
    ...(device.technicalLabels ?? []),
    ...(device.labels ?? []),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  if (candidates.length === 0) return false;
  return candidates.some((label) => label.toLowerCase() !== OTHER_LABEL.toLowerCase());
}

export function hasDashboardVisibleArea(
  device: Pick<UIDevice, 'displayAreaName' | 'parentAreaName' | 'sourceAreaName' | 'areaName' | 'area'>
) {
  return Boolean(
    (device.displayAreaName ?? device.parentAreaName ?? device.sourceAreaName ?? device.areaName ?? device.area ?? '').trim()
  );
}

export function isDashboardVisibleDevice(
  device: Pick<
    UIDevice,
    | 'area'
    | 'areaName'
    | 'displayAreaName'
    | 'parentAreaName'
    | 'sourceAreaName'
    | 'label'
    | 'labels'
    | 'technicalLabels'
    | 'displayLabel'
    | 'canonicalLabel'
    | 'sourceTechnicalLabel'
    | 'ownership'
  >
) {
  if (device.ownership === 'pending_cleanup') return false;
  if (!hasDashboardVisibleArea(device)) return false;
  if (!hasDashboardVisibilityLabel(device)) return false;
  return getGroupLabel(device as UIDevice) !== OTHER_LABEL;
}

export function getBrightnessPercent(attrs: Record<string, unknown>) {
  const brightnessPct = attrs['brightness_pct'];
  if (typeof brightnessPct === 'number') {
    return Math.round(brightnessPct);
  }
  const brightness = attrs['brightness'];
  if (typeof brightness === 'number') {
    return Math.round((brightness / 255) * 100);
  }
  return null;
}

export function getVolumePercent(attrs: Record<string, unknown>) {
  const volumeLevel = attrs['volume_level'];
  if (typeof volumeLevel === 'number') {
    return Math.round(volumeLevel * 100);
  }
  return null;
}

export function getBlindPosition(attrs: Record<string, unknown>) {
  const raw =
    typeof attrs['current_position'] === 'number'
      ? (attrs['current_position'] as number)
      : typeof attrs['position'] === 'number'
      ? (attrs['position'] as number)
      : null;
  if (raw === null) return null;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

export function getTargetTemperature(attrs: Record<string, unknown>) {
  const keys = ['temperature', 'target_temperature', 'target_temp', 'target_temp_low', 'target_temp_high'] as const;
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function getCurrentTemperature(attrs: Record<string, unknown>) {
  // IMPORTANT: Do not include "temperature" here. In Home Assistant climate entities,
  // "temperature" is commonly the target setpoint, while "current_temperature" is the measured value.
  const keys = [
    'current_temperature',
    'current_temp',
    'current_temp_c',
    'measured_temperature',
    'ambient_temperature',
    'sensor_temperature',
    'temp',
  ] as const;
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
