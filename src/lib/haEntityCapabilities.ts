// Architecture: Shared platform helper src/lib/haEntityCapabilities.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getCapabilityLabel } from '@/lib/deviceLabels';
import { UIDevice } from '@/types/device';

export type ActionSurface = 'dashboard' | 'automation';

type BaseActionSpec = {
  label?: string;
  surfaces?: ActionSurface[];
};

export type DeviceActionSpec =
  | (BaseActionSpec & {
      id: string;
      kind: 'command';
    })
  | (BaseActionSpec & {
      id: string;
      kind: 'slider';
      min: number;
      max: number;
      step?: number;
    })
  | (BaseActionSpec & {
      id: string;
      kind: 'fixed-position';
      positions: { value: number; label: string }[];
    });

type BaseTriggerSpec = {
  label: string;
  surfaces?: ActionSurface[];
};

export type DeviceTriggerSpec =
  | (BaseTriggerSpec & {
      type: 'state_equals';
      options: string[];
    })
  | (BaseTriggerSpec & {
      type: 'attribute_delta';
      attributes: string[];
      directionOptions: Array<'increased' | 'decreased'>;
    })
  | (BaseTriggerSpec & {
      type: 'position_equals';
      attributes: string[];
      values: { value: number; label: string }[];
    });

export type DeviceServiceSpec = {
  serviceId: string;
  displayLabel: string;
  equivalenceKey: string;
  domain: string;
  service: string;
  uiKind: 'button' | 'slider' | 'select';
  sliderSpec?: { key: string; min: number; max: number; step: number; unit?: string };
  selectSpec?: { key: string; options: string[] };
};

export type AlexaCapabilityProfile = {
  displayLabel: string;
  canPower: boolean;
  canBrightness: boolean;
  canPlayback: boolean;
  canVolume: boolean;
  canTemperature: boolean;
  isBlind: boolean;
};

export type DeviceCapabilityModel = {
  label: string;
  actions: DeviceActionSpec[];
  triggers: DeviceTriggerSpec[];
  advancedServices: DeviceServiceSpec[];
  excludeFromAutomations?: boolean;
  alexaProfile: AlexaCapabilityProfile;
};

const SAFE_HOMEASSISTANT_SERVICES = new Set([
  'homeassistant.turn_on',
  'homeassistant.turn_off',
  'homeassistant.toggle',
]);

const BLOCKED_ADVANCED_SERVICE_IDS = new Set([
  'homeassistant.reload_config_entry',
]);

function hasService(services: string[], serviceId: string) {
  return services.includes(serviceId);
}

function supportsAny(services: string[], candidates: string[]) {
  return candidates.some((serviceId) => hasService(services, serviceId));
}

function getSupportedColorModes(device: UIDevice) {
  const raw = device.attributes?.supported_color_modes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function hasNumericAttribute(device: UIDevice, key: string) {
  return typeof device.attributes?.[key] === 'number';
}

function getTemperatureMin(device: UIDevice) {
  return typeof device.attributes?.min_temp === 'number' ? Number(device.attributes.min_temp) : 10;
}

function getTemperatureMax(device: UIDevice) {
  return typeof device.attributes?.max_temp === 'number' ? Number(device.attributes.max_temp) : 35;
}

function getTemperatureStep(device: UIDevice) {
  return typeof device.attributes?.target_temp_step === 'number'
    ? Number(device.attributes.target_temp_step)
    : 1;
}

function splitServiceId(serviceId: string) {
  const [domain, service] = String(serviceId || '').split('.', 2);
  return { domain: domain ?? '', service: service ?? '' };
}

function formatServiceDisplayLabel(service: string) {
  return String(service || '').replaceAll('_', ' ').trim();
}

function getServiceEquivalenceKey(serviceId: string): string | null {
  const { service } = splitServiceId(serviceId);
  if (!service) return null;
  return service;
}

function getCoveredKeysFromPrimaryActions(device: UIDevice, actions: DeviceActionSpec[]) {
  const keys = new Set<string>();

  actions.forEach((action) => {
    if (action.kind !== 'command' && action.kind !== 'slider' && action.kind !== 'fixed-position') {
      return;
    }

    if (action.kind === 'command') {
        switch (action.id) {
          case 'light/turn_on':
          case 'tv/turn_on':
          case 'speaker/turn_on':
          case 'boiler/turn_on':
            keys.add('turn_on');
            return;
          case 'light/turn_off':
          case 'tv/turn_off':
          case 'speaker/turn_off':
          case 'boiler/turn_off':
            keys.add('turn_off');
            return;
          case 'light/toggle':
          case 'tv/toggle_power':
          case 'speaker/toggle_power':
            keys.add('toggle');
          return;
        case 'media/play_pause':
          keys.add('media_play_pause');
          return;
        case 'media/next':
          keys.add('media_next_track');
          return;
        case 'media/previous':
          keys.add('media_previous_track');
          return;
        case 'media/volume_up':
          keys.add('volume_up');
          return;
        case 'media/volume_down':
          keys.add('volume_down');
          return;
        case 'blind/open':
          keys.add('open_cover');
          return;
        case 'blind/close':
          keys.add('close_cover');
          return;
        default:
          return;
      }
    }

    if (action.kind === 'slider') {
      switch (action.id) {
        case 'light/set_brightness':
          // Keep advanced surface free of light.turn_on variants that could overlap brightness UX.
          keys.add('turn_on');
          keys.add('toggle');
          return;
        case 'blind/set_position':
          keys.add('set_cover_position');
          return;
        case 'media/volume_set':
          keys.add('volume_set');
          return;
        case 'boiler/set_temperature':
          keys.add('set_temperature');
          return;
        default:
          return;
      }
    }

    if (action.kind === 'fixed-position') {
      if (action.id === 'blind/set_position') keys.add('set_cover_position');
    }
  });

  // If the entity can already be power-controlled via primary controls, remove all power-like advanced entries.
  const hasPrimaryPower = actions.some(
    (action) =>
      action.kind === 'command' &&
      [
        'light/turn_on',
        'light/turn_off',
        'light/toggle',
        'tv/turn_on',
        'tv/turn_off',
        'tv/toggle_power',
        'speaker/turn_on',
        'speaker/turn_off',
        'speaker/toggle_power',
      ].includes(action.id)
  );
  if (hasPrimaryPower) {
    keys.add('turn_on');
    keys.add('turn_off');
    keys.add('toggle');
  }

  return keys;
}

function pickCanonicalServiceIdForKey(deviceDomain: string, candidates: string[]) {
  const domainPrefix = `${deviceDomain}.`;
  const domainCandidate = candidates.find((s) => s.startsWith(domainPrefix));
  if (domainCandidate) return domainCandidate;
  const haCandidate = candidates.find((s) => s.startsWith('homeassistant.'));
  if (haCandidate) return haCandidate;
  return candidates[0] ?? null;
}

function getPrimaryMediaPowerCommandIds(device: UIDevice) {
  const label = getCapabilityLabel(device);
  if (label === 'TV') {
    return { on: 'tv/turn_on', off: 'tv/turn_off' };
  }
  return { on: 'speaker/turn_on', off: 'speaker/turn_off' };
}

function buildAdvancedServices(device: UIDevice, primaryActions: DeviceActionSpec[]): DeviceServiceSpec[] {
  const services = Array.isArray(device.servicesForTarget) ? device.servicesForTarget : [];
  const coveredKeys = getCoveredKeysFromPrimaryActions(device, primaryActions);

  const safeAllowed = services.filter((serviceId) => {
    const normalized = String(serviceId || '').trim();
    if (!normalized || !normalized.includes('.')) return false;
    if (BLOCKED_ADVANCED_SERVICE_IDS.has(normalized)) return false;
    if (SAFE_HOMEASSISTANT_SERVICES.has(normalized)) return true;
    const { domain } = splitServiceId(normalized);
    return domain === device.domain;
  });

  const withKeys = safeAllowed
    .map((serviceId) => ({ serviceId, key: getServiceEquivalenceKey(serviceId) }))
    .filter((item): item is { serviceId: string; key: string } => !!item.key);

  // Drop anything already represented by primary controls (including all power equivalents).
  const remaining = withKeys.filter((item) => !coveredKeys.has(item.key));

  // Group by key and pick canonical serviceId.
  const byKey = new Map<string, string[]>();
  remaining.forEach(({ serviceId, key }) => {
    const list = byKey.get(key) ?? [];
    list.push(serviceId);
    byKey.set(key, list);
  });

  const canonical = Array.from(byKey.entries())
    .map(([key, candidates]) => ({
      key,
      serviceId: pickCanonicalServiceIdForKey(device.domain, candidates),
    }))
    .filter((x): x is { key: string; serviceId: string } => typeof x.serviceId === 'string' && x.serviceId.length > 0);

  // Typed tenant UI: only allow services we can safely render as button/slider/select (no text boxes).
  const specs: DeviceServiceSpec[] = [];
  canonical.forEach(({ key, serviceId }) => {
    const { domain, service } = splitServiceId(serviceId);
    const displayLabel = formatServiceDisplayLabel(service);

    // Buttons: no-parameter services we explicitly support tenant-running.
    const buttonKeys = new Set([
      'turn_on',
      'turn_off',
      'toggle',
      'media_play_pause',
      'media_next_track',
      'media_previous_track',
      'volume_up',
      'volume_down',
      'open_cover',
      'close_cover',
      'stop_cover',
      'pause',
      'stop',
    ]);

    if (buttonKeys.has(key)) {
      specs.push({
        serviceId,
        domain,
        service,
        displayLabel,
        equivalenceKey: key,
        uiKind: 'button',
      });
      return;
    }

    if (serviceId === 'climate.set_temperature') {
      specs.push({
        serviceId,
        domain,
        service,
        displayLabel: 'set temperature',
        equivalenceKey: key,
        uiKind: 'slider',
        sliderSpec: {
          key: 'temperature',
          min: getTemperatureMin(device),
          max: getTemperatureMax(device),
          step: getTemperatureStep(device),
          unit: '°C',
        },
      });
      return;
    }

    if (serviceId === 'climate.set_hvac_mode') {
      const hvacModesRaw = device.attributes?.hvac_modes;
      const options = Array.isArray(hvacModesRaw)
        ? hvacModesRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];
      if (options.length === 0) return;
      specs.push({
        serviceId,
        domain,
        service,
        displayLabel: 'set hvac mode',
        equivalenceKey: key,
        uiKind: 'select',
        selectSpec: { key: 'hvac_mode', options },
      });
      return;
    }

    // Unknown parameter service => hide from tenants in Phase 2.
  });

  return specs;
}

function buildLightLikeActions(device: UIDevice, services: string[]): DeviceActionSpec[] {
  const actions: DeviceActionSpec[] = [];
  const canTurnOn = supportsAny(services, ['light.turn_on', 'switch.turn_on', 'homeassistant.turn_on']);
  const canTurnOff = supportsAny(services, ['light.turn_off', 'switch.turn_off', 'homeassistant.turn_off']);
  const canToggle = supportsAny(services, ['light.toggle', 'switch.toggle', 'homeassistant.toggle']);

  if (canTurnOn) actions.push({ id: 'light/turn_on', kind: 'command', label: 'Turn on' });
  if (canTurnOff) actions.push({ id: 'light/turn_off', kind: 'command', label: 'Turn off' });
  if (!canTurnOn && !canTurnOff && canToggle) {
    actions.push({ id: 'light/toggle', kind: 'command', label: 'Toggle' });
  }

  if (device.domain === 'light') {
    const supportedColorModes = getSupportedColorModes(device);
    const isOnOffOnly =
      supportedColorModes.length > 0 &&
      supportedColorModes.length === 1 &&
      supportedColorModes[0] === 'onoff';
    if (!isOnOffOnly) {
      actions.push({
        id: 'light/set_brightness',
        kind: 'slider',
        min: 0,
        max: 100,
        step: 1,
        label: 'Brightness',
      });
    }
  }

  return actions;
}

function buildCoverActions(device: UIDevice, services: string[]): DeviceActionSpec[] {
  const actions: DeviceActionSpec[] = [];
  const canOpen = supportsAny(services, ['cover.open_cover', 'homeassistant.turn_on']);
  const canClose = supportsAny(services, ['cover.close_cover', 'homeassistant.turn_off']);
  const supportsPosition =
    supportsAny(services, ['cover.set_cover_position']) ||
    hasNumericAttribute(device, 'current_position') ||
    hasNumericAttribute(device, 'position');

  if (supportsPosition) {
    actions.push({
      id: 'blind/set_position',
      kind: 'slider',
      label: 'Set position',
      min: 0,
      max: 100,
      step: 1,
      surfaces: ['dashboard'],
    });
    actions.push({
      id: 'blind/set_position',
      kind: 'fixed-position',
      positions: [
        { value: 100, label: 'Open' },
        { value: 0, label: 'Close' },
      ],
      surfaces: ['automation'],
    });
  } else {
    if (canOpen) actions.push({ id: 'blind/open', kind: 'command', label: 'Open' });
    if (canClose) actions.push({ id: 'blind/close', kind: 'command', label: 'Close' });
  }

  return actions;
}

function buildMediaActions(device: UIDevice, services: string[]): DeviceActionSpec[] {
  const actions: DeviceActionSpec[] = [];
  const power = getPrimaryMediaPowerCommandIds(device);
  const canTurnOn = supportsAny(services, ['media_player.turn_on', 'homeassistant.turn_on']);
  const canTurnOff = supportsAny(services, ['media_player.turn_off', 'homeassistant.turn_off']);
  const canPlayPause = supportsAny(services, [
    'media_player.media_play_pause',
    'media_player.media_play',
    'media_player.media_pause',
  ]);
  const canNext = hasService(services, 'media_player.media_next_track');
  const canPrevious = hasService(services, 'media_player.media_previous_track');
  const canVolumeSet = hasService(services, 'media_player.volume_set');
  const canVolumeUp = hasService(services, 'media_player.volume_up');
  const canVolumeDown = hasService(services, 'media_player.volume_down');

  if (canTurnOn) actions.push({ id: power.on, kind: 'command', label: 'Turn on' });
  if (canTurnOff) actions.push({ id: power.off, kind: 'command', label: 'Turn off' });
  if (canPlayPause) actions.push({ id: 'media/play_pause', kind: 'command', label: 'Play / Pause' });
  if (canNext) actions.push({ id: 'media/next', kind: 'command', label: 'Next', surfaces: ['dashboard'] });
  if (canPrevious) actions.push({ id: 'media/previous', kind: 'command', label: 'Previous', surfaces: ['dashboard'] });
  if (canVolumeSet) {
    actions.push({
      id: 'media/volume_set',
      kind: 'slider',
      min: 0,
      max: 100,
      step: 1,
      label: 'Volume',
    });
  }
  if (canVolumeUp) actions.push({ id: 'media/volume_up', kind: 'command', label: 'Volume up', surfaces: ['dashboard'] });
  if (canVolumeDown) actions.push({ id: 'media/volume_down', kind: 'command', label: 'Volume down', surfaces: ['dashboard'] });

  return actions;
}

function buildClimateActions(device: UIDevice, services: string[]): DeviceActionSpec[] {
  const hvacModes = Array.isArray(device.attributes?.hvac_modes)
    ? device.attributes.hvac_modes.filter((mode): mode is string => typeof mode === 'string')
    : [];
  const supportsTemperature =
    supportsAny(services, ['climate.set_temperature']) ||
    hasNumericAttribute(device, 'temperature') ||
    hasNumericAttribute(device, 'target_temperature') ||
    hasNumericAttribute(device, 'current_temperature') ||
    hvacModes.length > 0;
  if (!supportsTemperature) return [];
  const actions: DeviceActionSpec[] = [];

  const canPower = supportsAny(services, [
    'climate.set_hvac_mode',
    'climate.turn_on',
    'climate.turn_off',
    'homeassistant.turn_on',
    'homeassistant.turn_off',
  ]) || hvacModes.includes('off') || hvacModes.includes('heat');
  if (canPower) {
    actions.push(
      { id: 'boiler/turn_on', kind: 'command', label: 'Turn on', surfaces: ['dashboard', 'automation'] },
      { id: 'boiler/turn_off', kind: 'command', label: 'Turn off', surfaces: ['dashboard', 'automation'] }
    );
  }

  actions.push(
    { id: 'boiler/temp_up', kind: 'command', label: 'Temp up', surfaces: ['dashboard'] },
    { id: 'boiler/temp_down', kind: 'command', label: 'Temp down', surfaces: ['dashboard'] },
    {
      id: 'boiler/set_temperature',
      kind: 'slider',
      min: getTemperatureMin(device),
      max: getTemperatureMax(device),
      step: getTemperatureStep(device),
      label: 'Set temperature',
      surfaces: ['dashboard', 'automation'],
    },
  );

  return actions;
}

function buildTriggers(device: UIDevice, actions: DeviceActionSpec[]): DeviceTriggerSpec[] {
  if (device.domain === 'cover') {
    return [
      {
        type: 'position_equals',
        label: 'Blind opened / closed',
        attributes: ['current_position', 'position'],
        values: [
          { value: 100, label: 'Opened' },
          { value: 0, label: 'Closed' },
        ],
      },
    ];
  }

  if (device.domain === 'binary_sensor') {
    return [{ type: 'state_equals', label: 'State', options: ['on', 'off'] }];
  }

  if (device.domain === 'light') {
    const triggers: DeviceTriggerSpec[] = [{ type: 'state_equals', label: 'Power', options: ['on', 'off'] }];
    if (actions.some((action) => action.id === 'light/set_brightness')) {
      triggers.push({
        type: 'attribute_delta',
        label: 'Brightness changed',
        attributes: ['brightness', 'brightness_pct'],
        directionOptions: ['increased', 'decreased'],
      });
    }
    return triggers;
  }

  if (device.domain === 'climate') {
    return [
      {
        type: 'attribute_delta',
        label: 'Current temperature changed',
        attributes: ['current_temperature'],
        directionOptions: ['increased', 'decreased'],
      },
    ];
  }

  if (device.domain === 'media_player' || actions.some((action) => action.id === 'light/turn_on')) {
    return [{ type: 'state_equals', label: 'Power', options: ['on', 'off'] }];
  }

  return [];
}

export function getDeviceCapabilityModel(device: UIDevice): DeviceCapabilityModel {
  const services = Array.isArray(device.servicesForTarget) ? device.servicesForTarget : [];
  const label = getCapabilityLabel(device);
  let actions: DeviceActionSpec[] = [];

  switch (device.domain) {
    case 'light':
    case 'switch':
      actions = buildLightLikeActions(device, services);
      break;
    case 'cover':
      actions = buildCoverActions(device, services);
      break;
    case 'media_player':
      actions = buildMediaActions(device, services);
      break;
    case 'climate':
      actions = buildClimateActions(device, services);
      break;
    default:
      actions = buildLightLikeActions(device, services);
      break;
  }

  const triggers = buildTriggers(device, actions);
  const advancedServices = buildAdvancedServices(device, actions);
  const alexaProfile: AlexaCapabilityProfile = {
    displayLabel: label,
    canPower: actions.some(
      (action) =>
        action.kind === 'command' &&
        ['light/turn_on', 'light/turn_off', 'tv/turn_on', 'tv/turn_off', 'speaker/turn_on', 'speaker/turn_off'].includes(action.id)
    ),
    canBrightness: actions.some((action) => action.kind === 'slider' && action.id === 'light/set_brightness'),
    canPlayback: actions.some(
      (action) =>
        action.kind === 'command' &&
        ['media/play_pause', 'media/next', 'media/previous'].includes(action.id)
    ),
    canVolume: actions.some(
      (action) =>
        (action.kind === 'slider' && action.id === 'media/volume_set') ||
        (action.kind === 'command' && ['media/volume_up', 'media/volume_down'].includes(action.id))
    ),
    canTemperature: actions.some((action) => action.id === 'boiler/set_temperature'),
    isBlind: device.domain === 'cover',
  };

  return {
    label,
    actions,
    triggers,
    advancedServices,
    excludeFromAutomations: actions.length === 0 && triggers.length === 0,
    alexaProfile,
  };
}
