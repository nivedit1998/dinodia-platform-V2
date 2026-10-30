import crypto from 'node:crypto';

/**
 * Builds the Alexa smart-home endpoint (what the tenant sees in the Alexa app and what Alexa can ask the device to do)
 * from a device's supported controls. Pure: no database, no network. The same module names the range instances used by
 * directive execution and state reports, so what is advertised and what is executed can never drift apart.
 */
export type JsonObject = Record<string, unknown>;
export type AlexaEndpoint = {
  endpointId: string;
  manufacturerName: 'Dinodia';
  friendlyName: string;
  description: string;
  displayCategories: string[];
  capabilities: JsonObject[];
};

export const RANGE_ROLES = new Set(['opening_percentage', 'position']);

function record(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function validRangeControl(control: JsonObject): boolean {
  const constraints = record(control.constraints);
  return RANGE_ROLES.has(String(control.semanticRole)) && control.valueType === 'number'
    && control.readable === true && control.writable === true && control.automatable === true
    && control.idempotency === 'set_value' && control.stepUpPolicy !== 'required'
    && constraints !== null && typeof constraints.minimum === 'number' && Number.isFinite(constraints.minimum)
    && typeof constraints.maximum === 'number' && Number.isFinite(constraints.maximum)
    && constraints.minimum <= constraints.maximum && typeof constraints.step === 'number'
    && Number.isFinite(constraints.step) && constraints.step > 0 && typeof control.controlId === 'string';
}

/** A single control keeps the established instance; duplicate same-role channels get stable opaque ids. */
export function rangeControllerInstances(controls: JsonObject[]): Map<string, string> {
  const eligible = controls.filter(validRangeControl);
  const roleCounts = new Map<string, number>();
  for (const control of eligible) roleCounts.set(String(control.semanticRole), (roleCounts.get(String(control.semanticRole)) ?? 0) + 1);
  const result = new Map<string, string>();
  for (const control of eligible) {
    const role = String(control.semanticRole);
    const base = role === 'position' ? 'Dinodia.Position' : 'Dinodia.OpeningPercentage';
    const instance = roleCounts.get(role) === 1
      ? base
      : `${base}.${crypto.createHash('sha256').update(String(control.controlId), 'utf8').digest('base64url')}`;
    result.set(String(control.controlId), instance);
  }
  return result;
}

/** Alexa category from the device's fixed label first, then from what it can do. */
export function alexaDisplayCategories(label: string | null | undefined, controls: JsonObject[]): string[] {
  const roles = new Set(controls.map((control) => String(control.semanticRole)));
  switch (String(label ?? '').trim().toLowerCase()) {
    case 'light': return ['LIGHT'];
    case 'blind': return ['INTERIOR_BLIND'];
    case 'sockets': case 'socket': return ['SMARTPLUG'];
    case 'switch': return ['SWITCH'];
    case 'tv': return ['TV'];
    case 'speaker': return ['SPEAKER'];
    case 'thermostat': case 'radiator': case 'boiler': return ['THERMOSTAT'];
    default: break;
  }
  const categories: string[] = [];
  if (roles.has('target_temperature')) categories.push('THERMOSTAT');
  if (roles.has('ambient_temperature') && !roles.has('target_temperature')) categories.push('TEMPERATURE_SENSOR');
  if (roles.has('brightness')) categories.push('LIGHT');
  else if (roles.has('power') && !categories.length) categories.push('SWITCH');
  if ([...roles].some((role) => RANGE_ROLES.has(role)) && !categories.length) categories.push('INTERIOR_BLIND');
  return categories.length ? categories : ['OTHER'];
}

function rangeCapability(control: JsonObject, instance: string, isBlind: boolean): JsonObject {
  const bounds = control.constraints as { minimum: number; maximum: number; step: number; unit?: string };
  const percent = bounds.unit === 'percent' || (bounds.minimum === 0 && bounds.maximum === 100);
  const standardBlind = isBlind && bounds.minimum === 0 && bounds.maximum === 100;
  const capability: JsonObject = {
    type: 'AlexaInterface', interface: 'Alexa.RangeController', version: '3', instance,
    capabilityResources: { friendlyNames: standardBlind
      ? [{ '@type': 'asset', value: { assetId: 'Alexa.Setting.Opening' } }]
      : [{ '@type': 'text', value: { text: String(control.label || 'Position'), locale: 'en-GB' } }] },
    properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'rangeValue' }] },
    configuration: { supportedRange: { minimumValue: bounds.minimum, maximumValue: bounds.maximum, precision: bounds.step },
      ...(percent ? { unitOfMeasure: 'Alexa.Unit.Percent' } : {}) },
  };
  if (standardBlind) {
    capability.semantics = {
      actionMappings: [
        { '@type': 'ActionsToDirective', actions: ['Alexa.Actions.Close'], directive: { name: 'SetRangeValue', payload: { rangeValue: 0 } } },
        { '@type': 'ActionsToDirective', actions: ['Alexa.Actions.Open'], directive: { name: 'SetRangeValue', payload: { rangeValue: 100 } } },
        { '@type': 'ActionsToDirective', actions: ['Alexa.Actions.Lower'], directive: { name: 'AdjustRangeValue', payload: { rangeValueDelta: -20, rangeValueDeltaDefault: false } } },
        { '@type': 'ActionsToDirective', actions: ['Alexa.Actions.Raise'], directive: { name: 'AdjustRangeValue', payload: { rangeValueDelta: 20, rangeValueDeltaDefault: false } } },
      ],
      stateMappings: [
        { '@type': 'StatesToValue', states: ['Alexa.States.Closed'], value: 0 },
        { '@type': 'StatesToRange', states: ['Alexa.States.Open'], range: { minimumValue: 1, maximumValue: 100 } },
      ],
    };
  }
  return capability;
}

export function buildAlexaEndpoint(input: { endpointId: string; friendlyName: string; label?: string | null; controls: JsonObject[] }): AlexaEndpoint | null {
  const controls = input.controls.filter((control) => control.readable === true);
  const writable = controls.filter((control) => control.writable === true && control.automatable === true && control.stepUpPolicy !== 'required');
  const capabilities: JsonObject[] = [
    { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
    { type: 'AlexaInterface', interface: 'Alexa.EndpointHealth', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'connectivity' }] } },
  ];
  const has = (role: string, valueType: string) => writable.some((control) => control.semanticRole === role && control.valueType === valueType);
  if (has('power', 'boolean')) capabilities.push({ type: 'AlexaInterface', interface: 'Alexa.PowerController', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'powerState' }] } });
  if (has('brightness', 'number')) capabilities.push({ type: 'AlexaInterface', interface: 'Alexa.BrightnessController', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'brightness' }] } });
  if (has('target_temperature', 'number')) capabilities.push({ type: 'AlexaInterface', interface: 'Alexa.ThermostatController', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'targetSetpoint' }] } });
  if (controls.some((control) => control.semanticRole === 'ambient_temperature' && control.observable === true && control.writable !== true)) {
    capabilities.push({ type: 'AlexaInterface', interface: 'Alexa.TemperatureSensor', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'temperature' }] } });
  }
  const instances = rangeControllerInstances(controls);
  const isBlind = String(input.label ?? '').trim().toLowerCase() === 'blind';
  for (const control of controls.filter(validRangeControl)) {
    const instance = instances.get(String(control.controlId));
    if (instance) capabilities.push(rangeCapability(control, instance, isBlind));
  }
  if (capabilities.length === 2) return null; // nothing Alexa can use
  return {
    endpointId: input.endpointId, manufacturerName: 'Dinodia', friendlyName: input.friendlyName,
    description: 'Dinodia Smart Living device', displayCategories: alexaDisplayCategories(input.label, controls), capabilities,
  };
}
