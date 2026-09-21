// Architecture: Shared platform helper src/lib/deviceControl.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import {
  AlexaDeviceStateLike,
  AlexaProperty,
  buildAlexaPropertiesForDevice,
} from '@/lib/alexaProperties';
import { sendAlexaChangeReportForHaConnection } from '@/lib/alexaEvents';
import { enqueueAlexaChangeReportJobSqs } from '@/lib/alexaChangeReportQueueSqs';
import { callHaService, fetchHaState, HaConnectionLike } from '@/lib/homeAssistant';
import { prisma } from '@/lib/prisma';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getGroupLabel } from '@/lib/deviceLabels';
import { normalizeAlexaEndpointId } from '@/lib/alexaEndpointId';
import { hashForLog, safeLog } from '@/lib/safeLogger';

const BLIND_GLOBAL_CONTROLLER_SCRIPT_ENTITY_ID =
  process.env.HA_BLIND_GLOBAL_CONTROLLER_SCRIPT_ENTITY_ID ||
  'script.global_blind_controller';
const BLIND_GLOBAL_CONTROLLER_SCRIPT_SERVICE =
  BLIND_GLOBAL_CONTROLLER_SCRIPT_ENTITY_ID.startsWith('script.')
    ? BLIND_GLOBAL_CONTROLLER_SCRIPT_ENTITY_ID.slice('script.'.length)
    : null;

const DEFAULT_BLIND_TRAVEL_SECONDS = Number(process.env.HA_BLIND_TRAVEL_SECONDS || '22');

export const DEVICE_CONTROL_NUMERIC_COMMANDS = new Set([
  'light/set_brightness',
  'media/volume_set',
  'blind/set_position',
  'boiler/set_temperature',
]);

const SAFE_HOMEASSISTANT_GENERIC_SERVICE_IDS = new Set([
  'homeassistant.turn_on',
  'homeassistant.turn_off',
  'homeassistant.toggle',
]);

const BLOCKED_GENERIC_SERVICE_IDS = new Set([
  'homeassistant.reload_config_entry',
]);

type DeviceCommandSource = 'app' | 'alexa' | 'physical';
type DeviceCommandOptions = {
  source?: DeviceCommandSource;
  userId?: number;
  haConnectionId?: number;
  skipStatePrefetch?: boolean;
};

const ALEXA_REPORTABLE_COMMANDS: Record<string, { label: string }> = {
  'light/toggle': { label: 'light' },
  'light/turn_on': { label: 'light' },
  'light/turn_off': { label: 'light' },
  'light/set_brightness': { label: 'light' },
  'light/set_color': { label: 'light' },
  'light/set_color_temperature': { label: 'light' },
  'blind/set_position': { label: 'blind' },
  'blind/open': { label: 'blind' },
  'blind/close': { label: 'blind' },
  'tv/toggle_power': { label: 'tv' },
  'tv/turn_on': { label: 'tv' },
  'tv/turn_off': { label: 'tv' },
  'speaker/toggle_power': { label: 'speaker' },
  'speaker/turn_on': { label: 'speaker' },
  'speaker/turn_off': { label: 'speaker' },
  'boiler/turn_on': { label: 'boiler' },
  'boiler/turn_off': { label: 'boiler' },
  'boiler/temp_up': { label: 'boiler' },
  'boiler/temp_down': { label: 'boiler' },
  'boiler/set_temperature': { label: 'boiler' },
  'boiler/set_hvac_mode': { label: 'boiler' },
};

function getAlexaLabelForCommand(command: string): string | null {
  return ALEXA_REPORTABLE_COMMANDS[command]?.label ?? null;
}

async function resolveBlindTravelSeconds(entityId: string, haConnectionId?: number): Promise<number> {
  if (haConnectionId) {
    try {
      const device = await prisma.device.findUnique({
        where: {
          haConnectionId_entityId: {
            haConnectionId,
            entityId,
          },
        },
        select: { blindTravelSeconds: true },
      });
      if (
        device?.blindTravelSeconds != null &&
        Number.isFinite(device.blindTravelSeconds) &&
        device.blindTravelSeconds > 0
      ) {
        return device.blindTravelSeconds;
      }
    } catch (err) {
      console.warn('[deviceControl] Failed to read blindTravelSeconds override', {
        entityId,
        haConnectionId,
        err,
      });
    }
  }
  return DEFAULT_BLIND_TRAVEL_SECONDS;
}

export async function executeDeviceCommand(
  haConnection: HaConnectionLike,
  entityId: string,
  command: string,
  value?: number,
  options?: DeviceCommandOptions,
  payload?: Record<string, unknown>
) {
  const source: DeviceCommandSource = options?.source ?? 'app';
  const haConnectionId = options?.haConnectionId;
  console.log('AlexaChangeReport: executeDeviceCommand', {
    entityId,
    command,
    source,
    alexaLabel: getAlexaLabelForCommand(command) ?? null,
  });
  const shouldSkipPrefetch =
    options?.skipStatePrefetch === true ||
    (source === 'alexa' &&
      (command === 'boiler/turn_on' ||
        command === 'boiler/turn_off' ||
        command === 'boiler/set_hvac_mode' ||
        command === 'boiler/set_temperature' ||
        command === 'boiler/temp_up' ||
        command === 'boiler/temp_down'));

  const state = shouldSkipPrefetch ? null : await fetchHaState(haConnection, entityId);
  const currentState = String(state?.state ?? '');
  const domain = entityId.split('.')[0];
  const attrs = (state?.attributes ?? {}) as Record<string, unknown>;
  const alexaLabel =
    (await resolveAlexaLabelForEntity(entityId, attrs, haConnectionId)) ?? getAlexaLabelForCommand(command);

  const previousSnapshot: AlexaChangeReportSnapshot | null = alexaLabel
    ? {
        entityId,
        state: currentState || 'unknown',
        attributes: attrs,
        label: alexaLabel,
      }
    : null;

  const normalizedState = currentState.toLowerCase();
  const hvacMode = typeof attrs.hvac_mode === 'string' ? attrs.hvac_mode.toLowerCase() : null;
  const isBoilerOff = normalizedState === 'off' || hvacMode === 'off';
  const hvacModes = Array.isArray(attrs.hvac_modes)
    ? attrs.hvac_modes.filter((m): m is string => typeof m === 'string').map((m) => m.toLowerCase())
    : [];

  const pickBoilerOnMode = () => {
    if (hvacModes.includes('heat')) return 'heat';
    if (hvacModes.includes('auto')) return 'auto';
    const firstNonOff = hvacModes.find((m) => m && m !== 'off');
    return firstNonOff ?? 'heat';
  };

  const tryCall = async (
    serviceDomain: string,
    service: string,
    data: Record<string, unknown>,
    options?: { swallow?: boolean }
  ) => {
    try {
      await callHaService(
        haConnection,
        serviceDomain,
        service,
        data,
        // Alexa control latency budget is tight; use a shorter timeout when we skip prefetch.
        source === 'alexa' && shouldSkipPrefetch ? 3500 : 6000
      );
      return true;
    } catch (err) {
      if (!options?.swallow) throw err;
      return false;
    }
  };

  const ensureBoilerOn = async () => {
    if (!shouldSkipPrefetch && !isBoilerOff) return;
    const mode = pickBoilerOnMode();
    // Try setting hvac mode first; if unavailable on the HA side, fall back.
    const ok =
      (await tryCall('climate', 'set_hvac_mode', { entity_id: entityId, hvac_mode: mode }, { swallow: true })) ||
      (await tryCall('climate', 'turn_on', { entity_id: entityId }, { swallow: true })) ||
      (await tryCall('homeassistant', 'turn_on', { entity_id: entityId }, { swallow: true }));
    if (!ok) {
      throw new Error('Unable to turn boiler on (no supported HA service succeeded)');
    }
  };

  const turnBoilerOff = async () => {
    const ok =
      (await tryCall('climate', 'set_hvac_mode', { entity_id: entityId, hvac_mode: 'off' }, { swallow: true })) ||
      (await tryCall('climate', 'turn_off', { entity_id: entityId }, { swallow: true })) ||
      (await tryCall('homeassistant', 'turn_off', { entity_id: entityId }, { swallow: true }));
    if (!ok) {
      throw new Error('Unable to turn boiler off (no supported HA service succeeded)');
    }
    // Best-effort: setpoint 0°C when off (some climates reject this; ignore failures).
    await tryCall('climate', 'set_temperature', { entity_id: entityId, temperature: 0 }, { swallow: true });
  };

  switch (command) {
    case 'light/turn_on':
      await callHaService(haConnection, 'homeassistant', 'turn_on', { entity_id: entityId });
      break;
    case 'light/turn_off':
      await callHaService(haConnection, 'homeassistant', 'turn_off', { entity_id: entityId });
      break;
    case 'light/toggle':
      if (domain === 'light') {
        await callHaService(
          haConnection,
          'light',
          currentState === 'on' ? 'turn_off' : 'turn_on',
          {
            entity_id: entityId,
          }
        );
      } else {
        await callHaService(haConnection, 'homeassistant', 'toggle', { entity_id: entityId });
      }
      break;
    case 'light/set_brightness':
      if (domain !== 'light') throw new Error('Brightness supported only for lights');
      await callHaService(haConnection, 'light', 'turn_on', {
        entity_id: entityId,
        brightness_pct: clamp(value ?? 0, 0, 100),
      });
      break;
    case 'light/set_color': {
      if (domain !== 'light') throw new Error('Color supported only for lights');
      const hue = typeof payload?.hue === 'number' ? payload.hue : null;
      const saturation = typeof payload?.saturation === 'number' ? payload.saturation : null;
      const brightness = typeof payload?.brightness === 'number' ? payload.brightness : null;
      if (hue === null || saturation === null) {
        throw new Error('Missing color payload (hue/saturation)');
      }
      const hueDeg = clamp(hue, 0, 360);
      const satPct = clamp(saturation <= 1 ? saturation * 100 : saturation, 0, 100);
      const brightnessPct =
        brightness === null
          ? undefined
          : clamp(brightness <= 1 ? brightness * 100 : brightness, 0, 100);

      await callHaService(haConnection, 'light', 'turn_on', {
        entity_id: entityId,
        hs_color: [hueDeg, satPct],
        ...(typeof brightnessPct === 'number' ? { brightness_pct: brightnessPct } : {}),
      });
      break;
    }
    case 'light/set_color_temperature': {
      if (domain !== 'light') throw new Error('Color temperature supported only for lights');
      const kelvin =
        typeof payload?.kelvin === 'number'
          ? payload.kelvin
          : typeof payload?.colorTemperatureInKelvin === 'number'
            ? payload.colorTemperatureInKelvin
            : null;
      if (kelvin === null) {
        throw new Error('Missing color temperature payload (kelvin)');
      }
      const safeKelvin = clamp(kelvin, 1000, 10000);
      const mireds = Math.round(1_000_000 / safeKelvin);
      await callHaService(haConnection, 'light', 'turn_on', {
        entity_id: entityId,
        color_temp: mireds,
      });
      break;
    }
    case 'blind/set_position': {
      const target = clamp(value ?? 0, 0, 100);
      const travelSeconds = await resolveBlindTravelSeconds(entityId, haConnectionId);
      await callBlindGlobalController(haConnection, {
        target_cover: entityId,
        target_position: target,
        travel_seconds: travelSeconds,
      });
      break;
    }
    case 'blind/open': {
      const travelSeconds = await resolveBlindTravelSeconds(entityId, haConnectionId);
      await callBlindGlobalController(haConnection, {
        target_cover: entityId,
        target_position: 100,
        travel_seconds: travelSeconds,
      });
      break;
    }
    case 'blind/close': {
      const travelSeconds = await resolveBlindTravelSeconds(entityId, haConnectionId);
      await callBlindGlobalController(haConnection, {
        target_cover: entityId,
        target_position: 0,
        travel_seconds: travelSeconds,
      });
      break;
    }
    case 'media/play_pause':
      await callHaService(
        haConnection,
        'media_player',
        currentState === 'playing' ? 'media_pause' : 'media_play',
        { entity_id: entityId }
      );
      break;
    case 'media/next':
      await callHaService(haConnection, 'media_player', 'media_next_track', {
        entity_id: entityId,
      });
      break;
    case 'media/previous':
      await callHaService(haConnection, 'media_player', 'media_previous_track', {
        entity_id: entityId,
      });
      break;
    case 'media/volume_up':
      await callHaService(haConnection, 'media_player', 'volume_up', {
        entity_id: entityId,
      });
      break;
    case 'media/volume_down':
      await callHaService(haConnection, 'media_player', 'volume_down', {
        entity_id: entityId,
      });
      break;
    case 'media/volume_set':
      await callHaService(haConnection, 'media_player', 'volume_set', {
        entity_id: entityId,
        volume_level: clamp((value ?? 0) / 100, 0, 1),
      });
      break;
    case 'boiler/turn_on':
      await ensureBoilerOn();
      break;
    case 'boiler/turn_off':
      await turnBoilerOff();
      break;
    case 'boiler/set_hvac_mode': {
      const hvacModeRaw =
        typeof payload?.hvac_mode === 'string'
          ? payload.hvac_mode
          : typeof payload?.hvacMode === 'string'
            ? payload.hvacMode
            : typeof payload?.mode === 'string'
              ? payload.mode
              : null;
      const hvacModeNormalized = hvacModeRaw ? hvacModeRaw.toLowerCase().trim() : '';
      if (!hvacModeNormalized) {
        throw new Error('Missing hvac_mode for boiler/set_hvac_mode');
      }
      await callHaService(
        haConnection,
        'climate',
        'set_hvac_mode',
        {
          entity_id: entityId,
          hvac_mode: hvacModeNormalized,
        },
        source === 'alexa' && shouldSkipPrefetch ? 3500 : 6000
      );
      break;
    }
    case 'boiler/temp_up':
    case 'boiler/temp_down': {
      await ensureBoilerOn();
      const currentTemp =
        typeof attrs.temperature === 'number'
          ? (attrs.temperature as number)
          : typeof attrs.current_temperature === 'number'
          ? (attrs.current_temperature as number)
          : 20;
      const delta = command === 'boiler/temp_up' ? 1 : -1;
      const newTemp = currentTemp + delta;
      await callHaService(haConnection, 'climate', 'set_temperature', {
        entity_id: entityId,
        temperature: newTemp,
      });
      break;
    }
    case 'boiler/set_temperature': {
      await ensureBoilerOn();
      const minTemp = typeof attrs.min_temp === 'number' ? Number(attrs.min_temp) : null;
      const maxTemp = typeof attrs.max_temp === 'number' ? Number(attrs.max_temp) : null;
      const step =
        typeof attrs.target_temp_step === 'number'
          ? Number(attrs.target_temp_step)
          : 1;
      const temp =
        typeof value === 'number'
          ? value
          : typeof attrs.temperature === 'number'
          ? (attrs.temperature as number)
          : typeof attrs.current_temperature === 'number'
          ? (attrs.current_temperature as number)
          : 20;
      const clamped =
        minTemp !== null && maxTemp !== null ? clamp(temp, minTemp, maxTemp) : temp;
      const quantized =
        typeof step === 'number' && Number.isFinite(step) && step > 0
          ? Math.round(clamped / step) * step
          : clamped;
      await callHaService(
        haConnection,
        'climate',
        'set_temperature',
        {
          entity_id: entityId,
          temperature: quantized,
        },
        source === 'alexa' && shouldSkipPrefetch ? 3500 : 6000
      );
      break;
    }
    case 'tv/turn_on':
    case 'speaker/turn_on':
      await callHaService(haConnection, 'media_player', 'turn_on', { entity_id: entityId });
      break;
    case 'tv/turn_off':
    case 'speaker/turn_off':
      await callHaService(haConnection, 'media_player', 'turn_off', { entity_id: entityId });
      break;
    case 'tv/toggle_power':
    case 'speaker/toggle_power':
      await callHaService(
        haConnection,
        'media_player',
        currentState === 'off' || currentState === 'standby' ? 'turn_on' : 'turn_off',
        { entity_id: entityId }
      );
      break;
    default:
      throw new Error(`Unsupported command ${command}`);
  }

  if (previousSnapshot) {
    try {
      const previousProperties = buildAlexaPropertiesForDevice(previousSnapshot, previousSnapshot.label);
      const delayMs = getChangeReportDelayMs(previousSnapshot.label);
      const causeType =
        source === 'alexa'
          ? 'VOICE_INTERACTION'
          : source === 'app'
          ? 'APP_INTERACTION'
          : 'PHYSICAL_INTERACTION';

      await enqueueAlexaChangeReportJobSqs({
        haConnectionId: haConnectionId ?? 0,
        entityId,
        label: previousSnapshot.label,
        causeType,
        previousProperties,
        delayMs,
      });
    } catch (err) {
      safeLog('error', 'AlexaChangeReport: failed to enqueue job', {
        err,
        haConnectionIdHash: hashForLog(String(haConnectionId ?? '')),
        entityIdHash: hashForLog(entityId),
      });
    }
  }
}

export async function executeDeviceService(
  haConnection: HaConnectionLike,
  entityId: string,
  serviceId: string,
  serviceData: Record<string, unknown> = {},
  options?: DeviceCommandOptions
) {
  const normalizedServiceId = String(serviceId || '').trim();
  if (!normalizedServiceId || !normalizedServiceId.includes('.')) {
    throw new Error('Invalid serviceId');
  }
  if (BLOCKED_GENERIC_SERVICE_IDS.has(normalizedServiceId)) {
    throw new Error('Service is not allowed');
  }

  const [serviceDomain, serviceName] = normalizedServiceId.split('.', 2);
  const allowed =
    serviceDomain === entityId.split('.')[0] ||
    SAFE_HOMEASSISTANT_GENERIC_SERVICE_IDS.has(normalizedServiceId);
  if (!allowed) {
    throw new Error('Service is not allowed for this entity');
  }

  const state = await fetchHaState(haConnection, entityId);
  const attrs = (state.attributes ?? {}) as Record<string, unknown>;
  const haConnectionId = options?.haConnectionId;
  const alexaLabel = await resolveAlexaLabelForEntity(entityId, attrs, haConnectionId);
  const previousSnapshot: AlexaChangeReportSnapshot | null = alexaLabel
    ? {
        entityId,
        state: String(state.state ?? ''),
        attributes: attrs,
        label: alexaLabel,
      }
    : null;

  await callHaService(haConnection, serviceDomain, serviceName, {
    entity_id: entityId,
    ...(serviceData ?? {}),
  });

  if (previousSnapshot) {
    try {
      const previousProperties = buildAlexaPropertiesForDevice(previousSnapshot, previousSnapshot.label);
      const delayMs = getChangeReportDelayMs(previousSnapshot.label);
      const causeType =
        options?.source === 'alexa'
          ? 'VOICE_INTERACTION'
          : options?.source === 'physical'
          ? 'PHYSICAL_INTERACTION'
          : 'APP_INTERACTION';
      await enqueueAlexaChangeReportJobSqs({
        haConnectionId: haConnectionId ?? 0,
        entityId,
        label: previousSnapshot.label,
        causeType,
        previousProperties,
        delayMs,
      });
    } catch (err) {
      safeLog('error', 'AlexaChangeReport: failed to enqueue service job', {
        err,
        haConnectionIdHash: hashForLog(String(haConnectionId ?? '')),
        entityIdHash: hashForLog(entityId),
      });
    }
  }
}

async function callBlindGlobalController(
  haConnection: HaConnectionLike,
  payload: {
    target_cover: string;
    target_position: number;
    travel_seconds: number;
  }
) {
  try {
    if (BLIND_GLOBAL_CONTROLLER_SCRIPT_SERVICE) {
      await callHaService(haConnection, 'script', BLIND_GLOBAL_CONTROLLER_SCRIPT_SERVICE, payload);
      return;
    }

    await callHaService(haConnection, 'script', 'turn_on', {
      entity_id: BLIND_GLOBAL_CONTROLLER_SCRIPT_ENTITY_ID,
      variables: payload,
    });
  } catch (err) {
    if (isHaTimeoutError(err)) {
      console.warn('[deviceControl] Blind script timed out (continuing)', {
        entityId: payload.target_cover,
      });
      return;
    }
    throw err;
  }
}

function isHaTimeoutError(err: unknown): err is Error {
  return err instanceof Error && err.message.toLowerCase().includes('timeout');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const DEFAULT_CHANGE_REPORT_DELAY_MS = 500;
const DEFAULT_LIGHT_CHANGE_REPORT_DELAY_MS = 4000;
const DEFAULT_BLIND_CHANGE_REPORT_DELAY_MS = 30000;

function getChangeReportDelayMs(label: string) {
  const normalized = label.toLowerCase();

  const parseDelay = (raw: string | undefined | null, fallback: number) => {
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  if (normalized === 'blind') {
    return parseDelay(
      process.env.ALEXA_EVENT_STATE_REFRESH_DELAY_BLIND_MS,
      DEFAULT_BLIND_CHANGE_REPORT_DELAY_MS
    );
  }

  if (normalized === 'light') {
    return parseDelay(
      process.env.ALEXA_EVENT_STATE_REFRESH_DELAY_LIGHT_MS,
      DEFAULT_LIGHT_CHANGE_REPORT_DELAY_MS
    );
  }

  return parseDelay(process.env.ALEXA_EVENT_STATE_REFRESH_DELAY_MS, DEFAULT_CHANGE_REPORT_DELAY_MS);
}

export type AlexaChangeReportSnapshot = AlexaDeviceStateLike & { label: string };

export async function buildAlexaChangeReportSnapshotForEntity(
  haConnection: HaConnectionLike,
  entityId: string,
  label: string
): Promise<AlexaChangeReportSnapshot> {
  const state = await fetchHaState(haConnection, entityId);
  const attrs = (state.attributes ?? {}) as Record<string, unknown>;

  return {
    entityId,
    state: String(state.state ?? ''),
    attributes: attrs,
    label,
  };
}

export async function scheduleAlexaChangeReportForEntityStateChange(
  haConnection: HaConnectionLike,
  haConnectionId: number | null,
  entityId: string,
  source: DeviceCommandSource
) {
  const state = await fetchHaState(haConnection, entityId);
  const attrs = (state.attributes ?? {}) as Record<string, unknown>;
  const label = await resolveAlexaLabelForEntity(entityId, attrs, haConnectionId);

  if (!label) {
    console.log('AlexaChangeReport: skipping, unsupported label for entity', { entityId });
    return;
  }

  const snapshot: AlexaChangeReportSnapshot = {
    entityId,
    state: String(state.state ?? ''),
    attributes: attrs,
    label,
  };

  await scheduleAlexaChangeReport(haConnection, snapshot, source, {
    haConnectionId,
    skipPropertyComparison: source === 'physical',
  });
}

type ChangeReportOptions = {
  skipPropertyComparison?: boolean;
  haConnectionId?: number | null;
};

export async function scheduleAlexaChangeReport(
  haConnection: HaConnectionLike,
  snapshot: AlexaChangeReportSnapshot,
  source: DeviceCommandSource,
  options?: ChangeReportOptions
) {
  if (!shouldSendAlexaEvents()) {
    console.log('AlexaChangeReport: skipping scheduleAlexaChangeReport', {
      entityId: snapshot.entityId,
      commandLabel: snapshot.label,
      source,
      reason: 'shouldSendAlexaEvents=false',
    });
    return;
  }

  const previousProperties = buildAlexaPropertiesForDevice(snapshot, snapshot.label);
  if (previousProperties.length === 0) {
    console.log('AlexaChangeReport: skipping, no previous properties', {
      entityId: snapshot.entityId,
      label: snapshot.label,
    });
    return;
  }

  const causeType =
    source === 'alexa'
      ? 'VOICE_INTERACTION'
      : source === 'app'
      ? 'APP_INTERACTION'
      : 'PHYSICAL_INTERACTION';

  const delayMs = getChangeReportDelayMs(snapshot.label);

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  let latestState = snapshot.state;
  let latestAttrs = snapshot.attributes;
  try {
    const refreshed = await fetchHaState(haConnection, snapshot.entityId);
    latestState = String(refreshed.state ?? latestState);
    latestAttrs = (refreshed.attributes ?? {}) as Record<string, unknown>;
  } catch (err) {
    console.warn(
      '[deviceControl] Failed to refresh HA state for Alexa ChangeReport',
      snapshot.entityId,
      err
    );
  }

  const nextProperties = buildAlexaPropertiesForDevice(
    {
      entityId: snapshot.entityId,
      state: latestState,
      attributes: latestAttrs,
      label: snapshot.label,
    },
    snapshot.label
  );

  if (nextProperties.length === 0) {
    console.log('AlexaChangeReport: skipping, no next properties', {
      entityId: snapshot.entityId,
      label: snapshot.label,
    });
    return;
  }

  const skipComparison = options?.skipPropertyComparison === true;
  if (!skipComparison && !haveAlexaPropertiesChanged(previousProperties, nextProperties)) {
    console.log('AlexaChangeReport: skipping, properties unchanged', {
      entityId: snapshot.entityId,
      label: snapshot.label,
    });
    return;
  }

  const haConnectionId = options?.haConnectionId ?? null;
  if (!haConnectionId) {
    console.log('AlexaChangeReport: skipping, missing haConnectionId', {
      entityId: snapshot.entityId,
      label: snapshot.label,
    });
    return;
  }

  try {
    const endpointIdForAlexa = normalizeAlexaEndpointId(snapshot.entityId);
    const uniqueNamespaces = Array.from(new Set(nextProperties.map((p) => p.namespace)));
    console.log('AlexaChangeReport: sending', {
      endpointId: endpointIdForAlexa,
      entityId: snapshot.entityId,
      label: snapshot.label,
      causeType,
      namespaces: uniqueNamespaces,
    });
    await sendAlexaChangeReportForHaConnection(
      haConnectionId,
      snapshot.entityId,
      nextProperties,
      causeType
    );
  } catch (err) {
    console.error(
      '[deviceControl] Failed to send Alexa ChangeReport',
      snapshot.entityId,
      err
    );
  }
}

function haveAlexaPropertiesChanged(prev: AlexaProperty[], next: AlexaProperty[]) {
  if (prev.length !== next.length) return true;
  const normalize = (props: AlexaProperty[]) =>
    props.map((prop) => ({
      namespace: prop.namespace,
      name: prop.name,
      instance: prop.instance ?? null,
      value: prop.value,
    }));

  return JSON.stringify(normalize(prev)) !== JSON.stringify(normalize(next));
}

function shouldSendAlexaEvents(): boolean {
  const hasGateway = !!process.env.ALEXA_EVENT_GATEWAY_ENDPOINT;
  const hasEventsClientId = !!process.env.ALEXA_EVENTS_CLIENT_ID;
  const hasEventsClientSecret = !!process.env.ALEXA_EVENTS_CLIENT_SECRET;

  const ok = hasGateway && hasEventsClientId && hasEventsClientSecret;

  console.log('AlexaChangeReport: shouldSendAlexaEvents', {
    hasGateway,
    hasEventsClientId,
    hasEventsClientSecret,
    ok,
  });

  return ok;
}

const SUPPORTED_ALEXA_LABELS = new Set([
  'light',
  'blind',
  'tv',
  'speaker',
  'boiler',
  'radiator',
  'motion sensor',
  'doorbell',
  'home security',
]);

function normalizeAlexaLabel(label: string | null | undefined): string | null {
  if (!label || typeof label !== 'string') return null;
  const normalized = label.trim().toLowerCase();
  return SUPPORTED_ALEXA_LABELS.has(normalized) ? normalized : null;
}

async function resolveAlexaLabelForEntity(
  entityId: string,
  attributes: Record<string, unknown>,
  haConnectionId?: number | null
): Promise<string | null> {
  const dbLabel = await resolveLabelFromDatabase(entityId);
  if (dbLabel) return dbLabel;

  if (haConnectionId && Number.isFinite(haConnectionId)) {
    const labelFromDevices = await resolveLabelFromDevicesSnapshot(haConnectionId, entityId);
    if (labelFromDevices) return labelFromDevices;
  }

  const domain = entityId.split('.')[0];
  const deviceClass =
    typeof attributes.device_class === 'string'
      ? (attributes.device_class as string).toLowerCase()
      : null;

  switch (domain) {
    case 'light':
      return 'light';
    case 'cover':
      return 'blind';
    case 'media_player':
      if (deviceClass === 'tv') return 'tv';
      return 'speaker';
    case 'climate':
      return 'boiler';
    case 'binary_sensor':
      if (deviceClass === 'motion') return 'motion sensor';
      if (deviceClass === 'opening' || deviceClass === 'door' || deviceClass === 'window') {
        return 'home security';
      }
      if (deviceClass === 'occupancy' || deviceClass === 'presence') {
        return 'motion sensor';
      }
      break;
    default:
      break;
  }

  return null;
}

async function resolveLabelFromDatabase(entityId: string): Promise<string | null> {
  try {
    const device = await prisma.device.findFirst({
      where: { entityId },
      select: { label: true },
    });
    return normalizeAlexaLabel(device?.label ?? null);
  } catch (err) {
    safeLog('warn', '[deviceControl] Failed to resolve label from DB', {
      entityIdHash: hashForLog(entityId),
      err,
    });
    return null;
  }
}

async function resolveLabelFromDevicesSnapshot(
  haConnectionId: number,
  entityId: string
): Promise<string | null> {
  try {
    const devices = await getDevicesForHaConnection(haConnectionId);
    const device = devices.find((d) => d.entityId === entityId);
    if (!device) return null;

    const groupLabel = getGroupLabel({
      label: device.label,
      labels: device.labels ?? [],
      labelCategory: device.labelCategory ?? null,
    });

    const normalized = normalizeAlexaLabel(groupLabel);
    if (normalized) return normalized;

    if (groupLabel === 'Spotify') {
      return 'speaker';
    }

    return null;
  } catch (err) {
    console.warn('[deviceControl] Failed to resolve label from devices snapshot', {
      haConnectionId,
      entityId,
      err,
    });
    return null;
  }
}
