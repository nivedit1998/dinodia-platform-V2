import { rangeControllerInstances } from '@/lib/alexa/endpointBuilder';

type JsonObject = Record<string, unknown>;
export type AlexaProperty = { namespace: string; name: string; value: unknown; timeOfSample: string; uncertaintyInMilliseconds: number; instance?: string };
/** The part of an authorised endpoint the state report needs. */
export type StateEndpoint = { osDeviceId: string; descriptorRevision: number };

const READABLE = new Set(['power', 'brightness', 'target_temperature', 'ambient_temperature', 'opening_percentage', 'position']);
const RANGE_ROLES = new Set(['opening_percentage', 'position']);
/** A last device-reported room temperature older than this is not offered to Alexa at all (the Hub enforces the same limit). */
const LAST_READING_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function record(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function alexaPropertiesFromStates(endpoint: StateEndpoint, controls: JsonObject[], states: unknown[], now = Date.now()): AlexaProperty[] {
  const byId = new Map<string, JsonObject>();
  for (const stateValue of states) {
    const state = record(stateValue);
    if (state && typeof state.controlId === 'string') byId.set(state.controlId, state);
  }
  const result: AlexaProperty[] = [];
  const rangeInstances = rangeControllerInstances(controls);
  const stateRows = [...byId.values()];
  const onlineEvidence = stateRows.find((state) => state.deviceAvailability === 'online' && typeof state.observedAt === 'string');
  const offlineEvidence = stateRows.find((state) => state.deviceAvailability === 'offline' && typeof state.observedAt === 'string');
  const connectivityEvidence = onlineEvidence ?? offlineEvidence;
  if (connectivityEvidence && typeof connectivityEvidence.observedAt === 'string') {
    const observedAt = Date.parse(connectivityEvidence.observedAt);
    if (Number.isFinite(observedAt) && observedAt <= now) result.push({
      namespace: 'Alexa.EndpointHealth', name: 'connectivity',
      value: { value: connectivityEvidence.deviceAvailability === 'online' ? 'OK' : 'UNREACHABLE' },
      timeOfSample: new Date(observedAt).toISOString(),
      uncertaintyInMilliseconds: Math.max(0, Math.min(60_000, Math.round(now - observedAt))),
    });
  }
  for (const control of controls) {
    const state = byId.get(String(control.controlId));
    if (!state || state.deviceId !== endpoint.osDeviceId || state.descriptorRevision !== endpoint.descriptorRevision
      || state.quality !== 'fresh' || typeof state.observedAt !== 'string' || typeof state.validUntil !== 'string'
      || !Number.isFinite(Date.parse(state.validUntil)) || Date.parse(state.validUntil) <= now
      || !Number.isFinite(Date.parse(state.observedAt)) || Date.parse(state.observedAt) > now) continue;
    const role = control.semanticRole;
    let namespace = '';
    let name = '';
    let value: unknown = state.value;
    if (role === 'power' && typeof value === 'boolean') { namespace = 'Alexa.PowerController'; name = 'powerState'; value = value ? 'ON' : 'OFF'; }
    else if (role === 'brightness' && typeof value === 'number' && value >= 0 && value <= 100) { namespace = 'Alexa.BrightnessController'; name = 'brightness'; }
    else if (role === 'target_temperature' && typeof value === 'number') { namespace = 'Alexa.ThermostatController'; name = 'targetSetpoint'; value = { value, scale: 'CELSIUS' }; }
    else if (role === 'ambient_temperature' && typeof value === 'number') { namespace = 'Alexa.TemperatureSensor'; name = 'temperature'; value = { value, scale: 'CELSIUS' }; }
    else if (RANGE_ROLES.has(String(role)) && typeof value === 'number') {
      const bounds = record(control.constraints);
      const instance = rangeInstances.get(String(control.controlId));
      if (!bounds || !instance || value < Number(bounds.minimum) || value > Number(bounds.maximum)) continue;
      const steps = (value - Number(bounds.minimum)) / Number(bounds.step);
      if (Math.abs(steps - Math.round(steps)) > 1e-7) continue;
      namespace = 'Alexa.RangeController'; name = 'rangeValue';
    }
    if (!namespace || !READABLE.has(String(role))) continue;
    const observedAt = Date.parse(state.observedAt);
    if (!Number.isFinite(observedAt)) continue;
    result.push({ namespace, name, value, timeOfSample: new Date(observedAt).toISOString(), uncertaintyInMilliseconds: Math.max(0, Math.min(60_000, Math.round(now - observedAt))),
      ...(namespace === 'Alexa.RangeController' ? { instance: rangeInstances.get(String(control.controlId)) } : {}) });
  }
  return result;
}

/**
 * What Alexa is told for ReportState. Current readings are reported as such. A setting with no current reading (a radiator's
 * target, a light's on/off) is reported at its last confirmed value with its true sample time and an uncertainty equal to its
 * age, never as current. Alexa shows a device as "not responding" when the report is an error or carries no connectivity, so the
 * report always says whether the device is known to be unreachable: UNREACHABLE only on explicit offline evidence from the Hub.
 */
export function stateReportProperties(endpoint: StateEndpoint, controls: JsonObject[], states: unknown[], now = Date.now()): AlexaProperty[] {
  const properties = alexaPropertiesFromStates(endpoint, controls, states, now);
  const keyOf = (property: AlexaProperty) => `${property.namespace}|${property.name}|${property.instance ?? ''}`;
  const covered = new Set(properties.filter((property) => property.name !== 'connectivity').map(keyOf));
  const baselines: JsonObject[] = [];
  for (const raw of states) {
    const state = record(raw);
    // lastSetting: what a setting was last set to (kept until changed). lastReading: the last room temperature the device itself
    // reported. Neither is ever a current reading; each goes to Alexa with its true sample time and an uncertainty equal to its age.
    const last = record(state?.lastSetting) ?? record(state?.lastReading);
    if (!state || !last || state.quality === 'fresh' || last.revision !== state.revision
      || !(typeof last.value === 'boolean' || (typeof last.value === 'number' && Number.isFinite(last.value)))
      || typeof last.observedAt !== 'string' || !Number.isFinite(Date.parse(last.observedAt)) || Date.parse(last.observedAt) > now) continue;
    if (!record(state.lastSetting) && now - Date.parse(last.observedAt) > LAST_READING_MAX_AGE_MS) continue;
    baselines.push({ ...state, quality: 'fresh', value: last.value, observedAt: last.observedAt, validUntil: new Date(now + 60_000).toISOString() });
  }
  for (const property of alexaPropertiesFromStates(endpoint, controls, baselines, now)) {
    if (property.name === 'connectivity' || covered.has(keyOf(property))) continue;
    properties.push({ ...property, uncertaintyInMilliseconds: Math.min(86_400_000, Math.max(0, now - Date.parse(property.timeOfSample))) });
  }
  if (!properties.some((property) => property.name === 'connectivity')) {
    properties.push({ namespace: 'Alexa.EndpointHealth', name: 'connectivity', value: { value: 'OK' }, timeOfSample: new Date(now).toISOString(), uncertaintyInMilliseconds: 0 });
  }
  if (controls.some((control) => control.semanticRole === 'target_temperature') && !properties.some((property) => property.name === 'thermostatMode')) {
    properties.push({ namespace: 'Alexa.ThermostatController', name: 'thermostatMode', value: 'HEAT', timeOfSample: new Date(now).toISOString(), uncertaintyInMilliseconds: 0 });
  }
  return properties;
}

