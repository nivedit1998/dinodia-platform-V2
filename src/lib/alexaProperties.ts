// Architecture: Shared platform helper src/lib/alexaProperties.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getPrimaryLabel } from '@/lib/deviceLabels';
import { getBrightnessPercent } from '@/lib/deviceCapabilities';
import { UIDevice } from '@/types/device';

export type AlexaProperty = {
  namespace: string;
  name: string;
  value: unknown;
  timeOfSample: string;
  uncertaintyInMilliseconds: number;
  instance?: string;
};

export type AlexaDeviceStateLike = Pick<UIDevice, 'entityId' | 'state' | 'attributes'> &
  Partial<Pick<UIDevice, 'label' | 'labelCategory' | 'labels' | 'domain' | 'servicesForTarget'>>;

const DEFAULT_UNCERTAINTY_MS = 500;

const ACTIVE_STATES = new Set(['on', 'heat', 'open', 'playing', 'true', 'detected', 'armed']);
const DETECTION_STATES = new Set(['on', 'open', 'detected', 'motion', 'pressed', 'true']);

export function buildAlexaPropertiesForDevice(
  device: AlexaDeviceStateLike,
  fallbackLabel?: string | null
): AlexaProperty[] {
  const sampleTime = nowIso();
  const resolvedLabel = resolveDeviceLabel(device, fallbackLabel);
  const label = resolvedLabel.toLowerCase();
  const normalizedState = normalizedDeviceState(device.state);
  const domain = resolveDomain(device);

  if (label === 'motion sensor') {
    return [
      buildDetectionProperty({
        namespace: 'Alexa.MotionSensor',
        isDetected: isDetectionActive(normalizedState),
        sampleTime,
      }),
    ];
  }

  if (label === 'doorbell' || label === 'home security') {
    return [
      buildDetectionProperty({
        namespace: 'Alexa.ContactSensor',
        isDetected: isDetectionActive(normalizedState),
        sampleTime,
      }),
    ];
  }

  switch (domain) {
    case 'light':
    case 'switch': {
      const properties: AlexaProperty[] = [
        buildPowerProperty({
          isOn: isActiveState(normalizedState),
          sampleTime,
        }),
      ];
      const brightness = getBrightnessPercent(device.attributes ?? {});
      if (domain === 'light' && brightness !== null) {
        properties.push({
          namespace: 'Alexa.BrightnessController',
          name: 'brightness',
          value: brightness,
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
        });
      }
      if (domain === 'light') {
        const colorMode = String(device.attributes?.['color_mode'] ?? '').toLowerCase();
        const kelvin = getKelvinFromAttributes(device.attributes ?? {});
        const color = getAlexaColorFromAttributes(device.attributes ?? {});
        if (kelvin !== null && colorMode.includes('color_temp')) {
          properties.push({
            namespace: 'Alexa.ColorTemperatureController',
            name: 'colorTemperatureInKelvin',
            value: kelvin,
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
          });
        } else if (color) {
          properties.push({
            namespace: 'Alexa.ColorController',
            name: 'color',
            value: color,
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
          });
        } else if (kelvin !== null) {
          properties.push({
            namespace: 'Alexa.ColorTemperatureController',
            name: 'colorTemperatureInKelvin',
            value: kelvin,
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
          });
        }
      }
      return properties;
    }
    case 'cover': {
      const position = getBlindPosition(device.attributes ?? {});
      const properties: AlexaProperty[] = [
        buildPowerProperty({
          isOn: isBlindOpenFromState(device.state, device.attributes),
          sampleTime,
        }),
      ];

      if (position !== null) {
        properties.push({
          namespace: 'Alexa.RangeController',
          instance: 'Blind.Position',
          name: 'rangeValue',
          value: clamp(Math.round(position), 0, 100),
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
        });
      }

      return properties;
    }
    case 'climate': {
      const attrs = device.attributes ?? {};

      const hvacMode = String(attrs['hvac_mode'] ?? device.state ?? '').toLowerCase();
      const thermostatMode = hvacMode === 'off' ? 'OFF' : 'HEAT';

      const target = getNumericAttribute(attrs, [
        'temperature',
        'target_temperature',
        'target_temp',
        'targetTemperature',
      ]);
      const current = getNumericAttribute(attrs, [
        'current_temperature',
        'currentTemperature',
      ]);

      const properties: AlexaProperty[] = [
        {
          namespace: 'Alexa.ThermostatController',
          name: 'thermostatMode',
          value: thermostatMode,
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
        },
        {
          namespace: 'Alexa.EndpointHealth',
          name: 'connectivity',
          value: { value: 'OK' },
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
        },
      ];

      if (target !== null) {
        const minTemp = typeof attrs.min_temp === 'number' ? Number(attrs.min_temp) : 10;
        const maxTemp = typeof attrs.max_temp === 'number' ? Number(attrs.max_temp) : 35;
        properties.push({
          namespace: 'Alexa.ThermostatController',
          name: 'targetSetpoint',
          value: { value: clamp(Math.round(target), minTemp, maxTemp), scale: 'CELSIUS' },
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
        });
      }

      if (current !== null) {
        properties.push({
          namespace: 'Alexa.TemperatureSensor',
          name: 'temperature',
          value: { value: Math.round(current), scale: 'CELSIUS' },
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
        });
      }

      return properties;
    }
    case 'media_player': {
      const properties: AlexaProperty[] = [
        buildPowerProperty({
          isOn: isActiveState(normalizedState),
          sampleTime,
        }),
      ];
      const volume = getNumericAttribute(device.attributes ?? {}, ['volume_level']);
      if (volume !== null) {
        properties.push({
          namespace: 'Alexa.Speaker',
          name: 'volume',
          value: clamp(Math.round(volume * 100), 0, 100),
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
        });
      }
      return properties;
    }
    default:
      return [];
  }
}

export function getBlindPosition(attributes: Record<string, unknown>): number | null {
  const keys = ['current_position', 'currentPosition', 'position'];
  for (const key of keys) {
    const raw = attributes[key];
    const parsed = parseNumber(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function isBlindOpenFromState(state: string, attributes: Record<string, unknown>): boolean {
  const pos = getBlindPosition(attributes);
  if (pos !== null) {
    return pos > 0;
  }
  return isActiveState(normalizedDeviceState(state));
}

function resolveDeviceLabel(device: AlexaDeviceStateLike, fallback?: string | null) {
  if (fallback) return fallback;
  if (device.label || device.labels || device.labelCategory) {
    return getPrimaryLabel({
      label: device.label ?? null,
      labels: device.labels ?? [],
      labelCategory: device.labelCategory ?? null,
    });
  }
  return '';
}

function resolveDomain(device: AlexaDeviceStateLike) {
  if (typeof device.domain === 'string' && device.domain.trim()) {
    return device.domain.trim().toLowerCase();
  }
  return device.entityId.split('.')[0]?.toLowerCase() ?? '';
}

function normalizedDeviceState(state: string) {
  return state ? state.toString().toLowerCase() : '';
}

function isActiveState(normalizedState: string) {
  return ACTIVE_STATES.has(normalizedState);
}

function isDetectionActive(normalizedState: string) {
  return DETECTION_STATES.has(normalizedState);
}

function buildPowerProperty({
  isOn,
  sampleTime,
}: {
  isOn: boolean;
  sampleTime: string;
}): AlexaProperty {
  return {
    namespace: 'Alexa.PowerController',
    name: 'powerState',
    value: isOn ? 'ON' : 'OFF',
    timeOfSample: sampleTime,
    uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
  };
}

function buildDetectionProperty({
  namespace,
  isDetected,
  sampleTime,
}: {
  namespace: 'Alexa.MotionSensor' | 'Alexa.ContactSensor';
  isDetected: boolean;
  sampleTime: string;
}): AlexaProperty {
  return {
    namespace,
    name: 'detectionState',
    value: isDetected ? 'DETECTED' : 'NOT_DETECTED',
    timeOfSample: sampleTime,
    uncertaintyInMilliseconds: DEFAULT_UNCERTAINTY_MS,
  };
}

function getNumericAttribute(attributes: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = parseNumber(attributes[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function getKelvinFromAttributes(attributes: Record<string, unknown>): number | null {
  const explicitKelvin = parseNumber(
    attributes['color_temp_kelvin'] ?? attributes['colorTemperatureInKelvin']
  );
  if (explicitKelvin !== null) {
    return clamp(Math.round(explicitKelvin), 1000, 10000);
  }

  const mireds = parseNumber(attributes['color_temp']);
  if (mireds !== null && mireds > 0) {
    const kelvin = Math.round(1_000_000 / mireds);
    return clamp(kelvin, 1000, 10000);
  }

  return null;
}

function getAlexaColorFromAttributes(attributes: Record<string, unknown>): {
  hue: number;
  saturation: number;
  brightness: number;
} | null {
  const brightnessPctRaw =
    parseNumber(attributes['brightness_pct']) ??
    (typeof attributes['brightness'] === 'number'
      ? clamp(Math.round((attributes['brightness'] as number) / 2.55), 0, 100)
      : null);
  const brightnessFromAttr =
    brightnessPctRaw !== null ? clamp(brightnessPctRaw / 100, 0, 1) : null;

  const hs = attributes['hs_color'];
  if (Array.isArray(hs) && hs.length >= 2) {
    const hue = parseNumber(hs[0]);
    const sat = parseNumber(hs[1]);
    if (hue !== null && sat !== null) {
      return {
        hue: clamp(hue, 0, 360),
        saturation: clamp(sat / 100, 0, 1),
        brightness: brightnessFromAttr ?? 1,
      };
    }
  }

  const rgb = attributes['rgb_color'];
  if (Array.isArray(rgb) && rgb.length >= 3) {
    const r = parseNumber(rgb[0]);
    const g = parseNumber(rgb[1]);
    const b = parseNumber(rgb[2]);
    if (r !== null && g !== null && b !== null) {
      const hsb = rgbToHsb(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255));
      return { ...hsb, brightness: brightnessFromAttr ?? hsb.brightness };
    }
  }

  return null;
}

function rgbToHsb(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const saturation = max === 0 ? 0 : delta / max;
  return {
    hue: clamp(hue, 0, 360),
    saturation: clamp(saturation, 0, 1),
    brightness: max,
  };
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function nowIso() {
  return new Date().toISOString();
}
