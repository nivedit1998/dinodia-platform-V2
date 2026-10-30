import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(m, m.exports, require);
  return m.exports;
}
const { buildAlexaEndpoint, alexaDisplayCategories, rangeControllerInstances } = load('src/lib/alexa/endpointBuilder.ts');
const { chooseFriendlyNames, baseFriendlyName } = load('src/lib/alexa/friendlyName.ts');

const control = (over) => ({ schemaVersion: 1, controlId: 'c1', label: 'Control', valueType: 'boolean', semanticRole: 'power', readable: true, writable: true,
  automatable: true, observable: true, idempotency: 'set_value', stepUpPolicy: 'none', ...over });
const power = control({ controlId: 'p' });
const brightness = control({ controlId: 'b', semanticRole: 'brightness', valueType: 'number', constraints: { minimum: 0, maximum: 100, step: 1 } });
const target = control({ controlId: 't', semanticRole: 'target_temperature', valueType: 'number', constraints: { minimum: 5, maximum: 30, step: 0.5 } });
const ambient = control({ controlId: 'a', semanticRole: 'ambient_temperature', valueType: 'number', writable: false, automatable: false, idempotency: 'none' });
const opening = control({ controlId: 'o', label: 'Opening', semanticRole: 'opening_percentage', valueType: 'number', constraints: { minimum: 0, maximum: 100, step: 5, unit: 'percent' } });
const interfaces = (endpoint) => endpoint.capabilities.map((c) => c.interface);

test('a light with power and brightness advertises both and is a LIGHT', () => {
  const e = buildAlexaEndpoint({ endpointId: 'dos_x', friendlyName: 'Bedroom lamp', label: 'Light', controls: [power, brightness] });
  assert.deepEqual(interfaces(e), ['Alexa', 'Alexa.EndpointHealth', 'Alexa.PowerController', 'Alexa.BrightnessController']);
  assert.deepEqual(e.displayCategories, ['LIGHT']);
  assert.equal(e.friendlyName, 'Bedroom lamp');
});

test('plugs, switches, televisions, speakers and heating get their own categories', () => {
  const cat = (label, controls = [power]) => alexaDisplayCategories(label, controls);
  assert.deepEqual(cat('Sockets'), ['SMARTPLUG']);
  assert.deepEqual(cat('Switch'), ['SWITCH']);
  assert.deepEqual(cat('TV'), ['TV']);
  assert.deepEqual(cat('Speaker'), ['SPEAKER']);
  assert.deepEqual(cat('Radiator', [target]), ['THERMOSTAT']);
  assert.deepEqual(cat(null, [target, ambient]), ['THERMOSTAT']);
  assert.deepEqual(cat(null, [ambient]), ['TEMPERATURE_SENSOR']);
  assert.deepEqual(cat(null, [power]), ['SWITCH']);
  assert.deepEqual(cat(null, [power, brightness]), ['LIGHT']);
  assert.deepEqual(cat('Other', [opening]), ['INTERIOR_BLIND']);
});

test('a thermostat and a read-only temperature sensor', () => {
  const t = buildAlexaEndpoint({ endpointId: 'dos_t', friendlyName: 'Hall thermostat', label: 'Thermostat', controls: [target, ambient] });
  assert.ok(interfaces(t).includes('Alexa.ThermostatController') && interfaces(t).includes('Alexa.TemperatureSensor'));
  const s = buildAlexaEndpoint({ endpointId: 'dos_s', friendlyName: 'Hall sensor', controls: [ambient] });
  assert.deepEqual(interfaces(s), ['Alexa', 'Alexa.EndpointHealth', 'Alexa.TemperatureSensor']);
});

test('a standard blind uses the Opening asset with open and close semantics', () => {
  const e = buildAlexaEndpoint({ endpointId: 'dos_b', friendlyName: 'Lounge blind', label: 'Blind', controls: [opening] });
  const range = e.capabilities.find((c) => c.interface === 'Alexa.RangeController');
  assert.equal(range.instance, 'Dinodia.OpeningPercentage');
  assert.deepEqual(range.capabilityResources.friendlyNames, [{ '@type': 'asset', value: { assetId: 'Alexa.Setting.Opening' } }]);
  assert.equal(range.semantics.actionMappings.length, 4);
  assert.equal(range.configuration.unitOfMeasure, 'Alexa.Unit.Percent');
  assert.deepEqual(e.displayCategories, ['INTERIOR_BLIND']);
});

test('a non-blind range control keeps a plain text name and no semantics', () => {
  const e = buildAlexaEndpoint({ endpointId: 'dos_r', friendlyName: 'Vent', label: 'Other', controls: [control({ controlId: 'v', label: 'Vent position', semanticRole: 'position', valueType: 'number', constraints: { minimum: 0, maximum: 10, step: 1 } })] });
  const range = e.capabilities.find((c) => c.interface === 'Alexa.RangeController');
  assert.equal(range.instance, 'Dinodia.Position');
  assert.equal(range.semantics, undefined);
  assert.equal(range.capabilityResources.friendlyNames[0].value.text, 'Vent position');
});

test('range instances are stable and unique for duplicate channels', () => {
  const a = { ...opening, controlId: 'o1' }; const b = { ...opening, controlId: 'o2' };
  const map = rangeControllerInstances([a, b]);
  assert.notEqual(map.get('o1'), map.get('o2'));
  assert.ok(map.get('o1').startsWith('Dinodia.OpeningPercentage.'));
  assert.deepEqual([...rangeControllerInstances([a, b]).entries()], [...map.entries()]);
});

test('a device with nothing Alexa can use produces no endpoint; a step-up control is never offered', () => {
  assert.equal(buildAlexaEndpoint({ endpointId: 'dos_n', friendlyName: 'X', controls: [] }), null);
  assert.equal(buildAlexaEndpoint({ endpointId: 'dos_n', friendlyName: 'X', controls: [{ ...power, stepUpPolicy: 'required' }] }), null);
});

test('names put the room first unless the device name already says it', () => {
  assert.equal(baseFriendlyName('Lamp', 'Bedroom'), 'Bedroom Lamp');
  assert.equal(baseFriendlyName('Bedroom lamp', 'Bedroom'), 'Bedroom lamp');
  assert.equal(baseFriendlyName('Lamp', null), 'Lamp');
  assert.equal(baseFriendlyName('  Kitchen   "light"  ', 'Kitchen'), 'Kitchen light');
  assert.equal(baseFriendlyName('Alexa Echo lamp', 'Hall'), 'Hall lamp');
  assert.ok(baseFriendlyName('x'.repeat(300), 'Hall').length <= 128);
});

test('clashes: different Homes add the postcode, the same Home numbers the later device', () => {
  const names = chooseFriendlyNames([
    { key: 'd1', deviceName: 'Lamp', roomName: 'Bedroom', homeKey: 'h1', postcode: 'M6 8AQ', order: 1 },
    { key: 'd2', deviceName: 'Lamp', roomName: 'Bedroom', homeKey: 'h2', postcode: 'SW1A 1AA', order: 2 },
    { key: 'd3', deviceName: 'Lamp', roomName: 'Bedroom', homeKey: 'h1', postcode: 'M6 8AQ', order: 3 },
    { key: 'd4', deviceName: 'Fan', roomName: 'Hall', homeKey: 'h1', postcode: 'M6 8AQ', order: 4 },
  ]);
  assert.equal(names.get('d4'), 'Hall Fan');
  assert.equal(names.get('d1'), 'Bedroom Lamp M6 8AQ');
  assert.equal(names.get('d2'), 'Bedroom Lamp SW1A 1AA');
  assert.equal(names.get('d3'), 'Bedroom Lamp M6 8AQ 2');
  assert.equal(new Set([...names.values()].map((n) => n.toLowerCase())).size, 4, 'final names are unique');
});

test('a single device keeps the plain name and naming is stable when run again', () => {
  const input = [{ key: 'a', deviceName: 'Lamp', roomName: 'Hall', homeKey: 'h', postcode: 'X1', order: 5 },
    { key: 'b', deviceName: 'Lamp', roomName: 'Hall', homeKey: 'h', postcode: 'X1', order: 6 }];
  const first = chooseFriendlyNames(input);
  assert.equal(first.get('a'), 'Hall Lamp');
  assert.equal(first.get('b'), 'Hall Lamp 2');
  assert.deepEqual([...chooseFriendlyNames([...input].reverse()).entries()].sort(), [...first.entries()].sort());
});
