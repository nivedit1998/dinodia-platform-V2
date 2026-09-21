// Architecture: Shared platform helper src/lib/alexaDiscoveryEndpoints.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getUserWithHaConnection } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import {
  getTenantOwnershipIndexForHome,
  isOwnedByAnotherTenantDeviceFirst,
  isOwnedByTenantDeviceFirst,
} from '@/lib/tenantOwnership';
import { resolveDeviceDisplayBatch } from '@/lib/deviceDisplayResolver';
import { getPrimaryLabel } from '@/lib/deviceLabels';
import { encodeAlexaEndpointIdFromEntityId } from '@/lib/alexaEndpointId';
import { hasTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';
import type { UIDevice } from '@/types/device';

type AlexaEndpoint = Record<string, unknown>;

const SAFE_HOMEASSISTANT_SERVICES = new Set([
  'homeassistant.turn_on',
  'homeassistant.turn_off',
  'homeassistant.toggle',
]);

function getStringArrayAttr(attrs: Record<string, unknown>, key: string): string[] {
  const value = attrs[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function getNumberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const value = attrs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const value = attrs[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function sanitizeFriendlyName(raw: string): string {
  const cleaned = String(raw ?? '')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Device';
}

function isBlindLabel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'blind';
}

function isBlindDevice(device: UIDevice): boolean {
  if (isBlindLabel(device.label) || isBlindLabel(device.labelCategory)) return true;
  const labels = Array.isArray(device.labels) ? device.labels : [];
  return labels.some((label) => isBlindLabel(label));
}

function getBlindEntityId(device: UIDevice): string {
  const attrs = (device.attributes ?? {}) as Record<string, unknown>;
  const candidates = [attrs['target_cover'], attrs['cover_entity_id'], attrs['coverEntityId']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith('cover.')) {
      return candidate;
    }
  }
  if (typeof device.entityId === 'string' && device.entityId.startsWith('cover.')) return device.entityId;
  return device.entityId;
}

type AlexaEntityCapabilityProfile = {
  canPower: boolean;
  canBrightness: boolean;
  canColor: boolean;
  canColorTemperature: boolean;
  canPlayback: boolean;
  canVolume: boolean;
  canTemperature: boolean;
};

function getDeviceServices(device: UIDevice): string[] {
  return Array.isArray(device.servicesForTarget)
    ? device.servicesForTarget.filter((service): service is string => typeof service === 'string')
    : [];
}

function inferEntityCapabilityProfile(device: UIDevice): AlexaEntityCapabilityProfile {
  const services = getDeviceServices(device);
  const has = (...serviceIds: string[]) => serviceIds.some((serviceId) => services.includes(serviceId));
  const attrs = (device.attributes ?? {}) as Record<string, unknown>;
  const supportedColorModes = getStringArrayAttr(attrs, 'supported_color_modes').map((m) => m.toLowerCase());
  const lightIsOnOffOnly = supportedColorModes.length === 1 && supportedColorModes[0] === 'onoff';
  const lightCanColor = supportedColorModes.some((m) =>
    ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(String(m).toLowerCase())
  );
  const lightCanColorTemperature = supportedColorModes.some((m) =>
    ['color_temp', 'color_temperature'].includes(String(m).toLowerCase())
  );

  switch (device.domain) {
    case 'light':
      return {
        canPower: has(...SAFE_HOMEASSISTANT_SERVICES, 'light.turn_on', 'light.turn_off', 'light.toggle'),
        canBrightness:
          !lightIsOnOffOnly && (has('light.turn_on') || getNumberAttr(attrs, 'brightness') !== null),
        canColor: lightCanColor && has('light.turn_on'),
        canColorTemperature: lightCanColorTemperature && has('light.turn_on'),
        canPlayback: false,
        canVolume: false,
        canTemperature: false,
      };
    case 'switch':
      return {
        canPower: has(...SAFE_HOMEASSISTANT_SERVICES, 'switch.turn_on', 'switch.turn_off', 'switch.toggle'),
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: false,
        canVolume: false,
        canTemperature: false,
      };
    case 'media_player':
      return {
        canPower: has(...SAFE_HOMEASSISTANT_SERVICES, 'media_player.turn_on', 'media_player.turn_off'),
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: has('media_player.media_play', 'media_player.media_pause', 'media_player.media_play_pause'),
        canVolume: has('media_player.volume_set', 'media_player.volume_up', 'media_player.volume_down'),
        canTemperature: false,
      };
    case 'cover':
      return {
        canPower: has('cover.open_cover', 'cover.close_cover', 'cover.set_cover_position') || has(...SAFE_HOMEASSISTANT_SERVICES),
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: false,
        canVolume: false,
        canTemperature: false,
      };
    case 'climate': {
      const hvacModes = getStringArrayAttr(attrs, 'hvac_modes');
      const hasHvacAttrs = getStringAttr(attrs, 'hvac_mode') !== null || hvacModes.length > 0;
      const hasSetpointAttrs =
        getNumberAttr(attrs, 'temperature') !== null ||
        getNumberAttr(attrs, 'min_temp') !== null ||
        getNumberAttr(attrs, 'max_temp') !== null ||
        getNumberAttr(attrs, 'target_temp_step') !== null;
      return {
        canPower:
          has(...SAFE_HOMEASSISTANT_SERVICES, 'climate.turn_on', 'climate.turn_off', 'climate.set_hvac_mode') ||
          hasHvacAttrs,
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: false,
        canVolume: false,
        canTemperature: has('climate.set_temperature') || hasSetpointAttrs,
      };
    }
    default:
      return {
        canPower: has(...SAFE_HOMEASSISTANT_SERVICES),
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: false,
        canVolume: false,
        canTemperature: false,
      };
  }
}

function getAlexaDeviceKind(device: UIDevice): string {
  if (isBlindDevice(device)) return 'blind';
  if (device.domain === 'climate') {
    const raw = getPrimaryLabel(device).toLowerCase();
    if (raw === 'heating' || raw === 'boiler') return 'boiler';
    if (raw === 'radiators' || raw === 'radiator') return 'radiator';
    return 'thermostat';
  }
  if (device.domain === 'light') return 'light';
  if (device.domain === 'switch') return 'switch';
  if (device.domain === 'media_player') {
    const raw = getPrimaryLabel(device).toLowerCase();
    if (raw === 'tv') return 'tv';
    if (raw === 'speaker' || raw === 'spotify') return 'speaker';
    return 'speaker';
  }
  const raw = getPrimaryLabel(device).toLowerCase();
  if (raw === 'heating') return 'boiler';
  if (raw === 'radiators') return 'radiator';
  return raw;
}

function alexaInterface() {
  return { type: 'AlexaInterface', interface: 'Alexa', version: '3' };
}

function endpointHealthInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.EndpointHealth',
    version: '3.1',
    properties: { supported: [{ name: 'connectivity' }], proactivelyReported: true, retrievable: true },
  };
}

function powerControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.PowerController',
    version: '3',
    properties: { supported: [{ name: 'powerState' }], proactivelyReported: true, retrievable: true },
  };
}

function brightnessControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.BrightnessController',
    version: '3',
    properties: { supported: [{ name: 'brightness' }], proactivelyReported: true, retrievable: true },
  };
}

function colorControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ColorController',
    version: '3',
    properties: { supported: [{ name: 'color' }], proactivelyReported: true, retrievable: true },
  };
}

function colorTemperatureControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ColorTemperatureController',
    version: '3',
    properties: { supported: [{ name: 'colorTemperatureInKelvin' }], proactivelyReported: true, retrievable: true },
  };
}

function rangeControllerInterfaceBlindPosition() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.RangeController',
    version: '3',
    instance: 'Blind.Position',
    properties: { supported: [{ name: 'rangeValue' }], proactivelyReported: true, retrievable: true },
    capabilityResources: {
      friendlyNames: [{ value: { assetId: 'Alexa.Setting.Opening' } }],
    },
    configuration: { supportedRange: { minimumValue: 0, maximumValue: 100, precision: 1 }, unitOfMeasure: 'Alexa.Unit.Percent' },
  };
}

function playbackControllerInterface(operations: string[]) {
  return { type: 'AlexaInterface', interface: 'Alexa.PlaybackController', version: '3', supportedOperations: operations };
}

function speakerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.Speaker',
    version: '3',
    properties: { supported: [{ name: 'volume' }], proactivelyReported: true, retrievable: true },
  };
}

function thermostatControllerInterface(supportedModes: string[] = ['HEAT', 'OFF']) {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ThermostatController',
    version: '3.2',
    properties: { supported: [{ name: 'targetSetpoint' }, { name: 'thermostatMode' }], proactivelyReported: true, retrievable: true },
    configuration: { supportedModes },
  };
}

function temperatureSensorInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.TemperatureSensor',
    version: '3',
    properties: { supported: [{ name: 'temperature' }], proactivelyReported: true, retrievable: true },
  };
}

function getSupportedThermostatModesFromDevice(device: UIDevice): string[] {
  const attrs = (device.attributes ?? {}) as Record<string, unknown>;
  const hvacModes = getStringArrayAttr(attrs, 'hvac_modes').map((m) => m.toLowerCase());
  const supported = new Set<string>();
  for (const mode of hvacModes) {
    if (mode === 'heat') supported.add('HEAT');
    else if (mode === 'cool') supported.add('COOL');
    else if (mode === 'auto' || mode === 'heat_cool') supported.add('AUTO');
    else if (mode === 'off') supported.add('OFF');
  }
  supported.add('OFF');
  if (!supported.has('HEAT') && !supported.has('COOL')) supported.add('HEAT');
  return Array.from(supported);
}

function devicesToEndpoints(devices: UIDevice[]): AlexaEndpoint[] {
  const endpoints: AlexaEndpoint[] = [];

  type AlexaCapability = Record<string, unknown>;
  type AlexaEndpointDraft = {
    endpointId: string;
    manufacturerName: string;
    friendlyName: string;
    description: string;
    displayCategories: string[];
    cookie: Record<string, unknown>;
    capabilities: AlexaCapability[];
  };

  const hasClimateWithSameObjectId = new Set<string>();
  for (const device of devices) {
    if (device.domain === 'climate' && typeof device.entityId === 'string') {
      hasClimateWithSameObjectId.add(device.entityId.split('.')[1] ?? '');
    }
  }

  for (const device of devices) {
    const label = getPrimaryLabel(device);
    const kind = getAlexaDeviceKind(device);
    const profile = inferEntityCapabilityProfile(device);
    const roomName = device.areaName || device.area || '';

    const realEntityId = kind === 'blind' ? getBlindEntityId(device) : device.entityId;
    const endpointId = encodeAlexaEndpointIdFromEntityId(realEntityId);
    const friendlyName = sanitizeFriendlyName(device.displayName ?? device.name);

    const endpoint: AlexaEndpointDraft = {
      endpointId,
      manufacturerName: 'Dinodia',
      friendlyName,
      description: label || device.displayName || device.name,
      displayCategories: [],
      cookie: {
        entityId: realEntityId,
        domain: device.domain,
        areaName: roomName,
        label,
        deviceType: kind,
      },
      capabilities: [alexaInterface(), endpointHealthInterface()],
    };

    const playbackOperations = ['Play', 'Pause', 'PlayPause', 'Next', 'Previous'];
    let include = false;

    switch (kind) {
      case 'light': {
        endpoint.displayCategories = ['LIGHT'];
        if (profile.canPower) endpoint.capabilities.push(powerControllerInterface());
        if (profile.canBrightness) endpoint.capabilities.push(brightnessControllerInterface());
        if (profile.canColor) endpoint.capabilities.push(colorControllerInterface());
        if (profile.canColorTemperature) endpoint.capabilities.push(colorTemperatureControllerInterface());
        include = profile.canPower || profile.canBrightness || profile.canColor || profile.canColorTemperature;
        break;
      }
      case 'switch': {
        endpoint.displayCategories = ['SWITCH'];
        endpoint.capabilities.push(powerControllerInterface());
        include = true;
        break;
      }
      case 'blind': {
        endpoint.displayCategories = ['INTERIOR_BLIND'];
        endpoint.capabilities.push(rangeControllerInterfaceBlindPosition());
        include = true;
        break;
      }
      case 'tv': {
        endpoint.displayCategories = ['TV'];
        if (profile.canPower) endpoint.capabilities.push(powerControllerInterface());
        if (profile.canVolume) endpoint.capabilities.push(speakerInterface());
        if (profile.canPlayback) endpoint.capabilities.push(playbackControllerInterface(playbackOperations));
        include = profile.canPower || profile.canVolume || profile.canPlayback;
        break;
      }
      case 'speaker': {
        endpoint.displayCategories = ['SPEAKER'];
        if (profile.canPower) endpoint.capabilities.push(powerControllerInterface());
        if (profile.canVolume) endpoint.capabilities.push(speakerInterface());
        if (profile.canPlayback) endpoint.capabilities.push(playbackControllerInterface(playbackOperations));
        include = profile.canPower || profile.canVolume || profile.canPlayback;
        break;
      }
      case 'boiler':
      case 'radiator':
      case 'thermostat': {
        endpoint.displayCategories = ['THERMOSTAT'];
        endpoint.capabilities.push(powerControllerInterface());
        endpoint.capabilities.push(thermostatControllerInterface(getSupportedThermostatModesFromDevice(device)));
        endpoint.capabilities.push(temperatureSensorInterface());
        include = true;
        break;
      }
      default: {
        // Unsupported kinds are ignored for proactive discovery.
        include = false;
        break;
      }
    }

    if (!include) continue;

    // Avoid collisions where multiple climate entities share the same object id; keep endpointIds unique.
    if (device.domain === 'climate' && hasClimateWithSameObjectId.has(device.entityId.split('.')[1] ?? '')) {
      // Keep the encoded entityId-based endpointId (already unique).
    }

    endpoints.push(endpoint);
  }

  return endpoints;
}

export async function getAlexaDiscoveryEndpointsForUser(args: {
  userId: number;
  restrictEntityIds?: string[] | null;
}) {
  const { userId, restrictEntityIds } = args;
  const { user, haConnection } = await getUserWithHaConnection(userId);

  const includeServicesForTarget = true;
  const devices = await getDevicesForHaConnection(haConnection.id, {
    labelsOnly: true,
    includeServicesForTarget,
    cacheTtlMs: 30_000,
  });

  const ownershipIndex = await getTenantOwnershipIndexForHome({
    homeId: user.homeId!,
    haConnectionId: haConnection.id,
    currentTenantUserId: user.id,
  });

  const allowedAreas = new Set((user.accessRules ?? []).map((rule) => rule.area));

  const filtered = devices.filter((device) => {
    const pending =
      (device.deviceId ? ownershipIndex.pendingDeviceIds.has(device.deviceId) : false) ||
      ownershipIndex.pendingEntityIds.has(device.entityId);
    if (pending) return false;
    if (isOwnedByTenantDeviceFirst(device, ownershipIndex, user.id)) return true;
    if (isOwnedByAnotherTenantDeviceFirst(device, ownershipIndex, user.id)) return false;
    if (hasTenantDeviceLabelValue(device.technicalLabels ?? device.labels ?? [])) return false;
    return Boolean(device.areaName && allowedAreas.has(device.areaName));
  });

  const restrictedSet = Array.isArray(restrictEntityIds) && restrictEntityIds.length > 0 ? new Set(restrictEntityIds) : null;
  const finalDevicesRaw = restrictedSet ? filtered.filter((d) => restrictedSet.has(d.entityId)) : filtered;
  const finalDevices = await resolveDeviceDisplayBatch(finalDevicesRaw, {
    viewer: 'alexa_tenant',
    userId: user.id,
    homeId: user.homeId!,
    haConnectionId: haConnection.id,
  });

  return {
    haConnectionId: haConnection.id,
    endpoints: devicesToEndpoints(finalDevices),
    entityIds: finalDevices.map((d) => d.entityId),
  };
}
