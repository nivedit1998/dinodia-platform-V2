import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, aliases = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(m, m.exports, (name) => aliases[name] ?? require(name));
  return m.exports;
}
const builder = load('src/lib/alexa/endpointBuilder.ts');
const { stateReportProperties } = load('src/lib/alexa/stateReport.ts', { '@/lib/alexa/endpointBuilder': builder });

const now = Date.parse('2026-10-30T20:00:00.000Z');
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const endpoint = { osDeviceId: 'dev-1', descriptorRevision: 4 };
const target = { controlId: 't', semanticRole: 'target_temperature', valueType: 'number', writable: true, readable: true, observable: true, constraints: { minimum: 5, maximum: 30, step: 0.5 } };
const ambient = { controlId: 'a', semanticRole: 'ambient_temperature', valueType: 'number', writable: false, readable: true, observable: true };
const base = (control, extra) => ({ deviceId: 'dev-1', controlId: control.controlId, descriptorRevision: 4, revision: 9, quality: 'unknown', value: null,
  observedAt: null, validUntil: null, deviceAvailability: 'online', ...extra });
const names = (properties) => properties.map((property) => `${property.namespace}.${property.name}`).sort();
const prop = (properties, name) => properties.find((property) => property.name === name);

test('no readings at all: the report is reachable, a fixed HEAT mode, and nothing presented as a reading', () => {
  const properties = stateReportProperties(endpoint, [target, ambient], [base(target), base(ambient)], now);
  assert.deepEqual(names(properties), ['Alexa.EndpointHealth.connectivity', 'Alexa.ThermostatController.thermostatMode']);
  assert.equal(prop(properties, 'connectivity').value.value, 'OK');
  assert.equal(prop(properties, 'thermostatMode').value, 'HEAT');
});

test('the last device-reported room temperature is reported with its true sample time and its age as uncertainty', () => {
  const states = [base(target), base(ambient, { lastReading: { value: 22.5, observedAt: at(40), revision: 9 } })];
  const temperature = prop(stateReportProperties(endpoint, [target, ambient], states, now), 'temperature');
  assert.deepEqual(temperature.value, { value: 22.5, scale: 'CELSIUS' });
  assert.equal(temperature.timeOfSample, at(40));
  assert.equal(temperature.uncertaintyInMilliseconds, 40 * 60_000);
});

test('a last reading older than 12 hours, from another revision, or from the future is not offered', () => {
  for (const lastReading of [{ value: 22.5, observedAt: at(13 * 60), revision: 9 }, { value: 22.5, observedAt: at(40), revision: 8 }, { value: 22.5, observedAt: at(-5), revision: 9 }]) {
    const properties = stateReportProperties(endpoint, [target, ambient], [base(target), base(ambient, { lastReading })], now);
    assert.equal(prop(properties, 'temperature'), undefined);
  }
});

test('a last setting is kept with its age (no age limit), and a current reading wins over a last reading', () => {
  const lastSetting = { value: 21, observedAt: at(26 * 60), revision: 9 };
  const aged = prop(stateReportProperties(endpoint, [target, ambient], [base(target, { lastSetting }), base(ambient)], now), 'targetSetpoint');
  assert.deepEqual(aged.value, { value: 21, scale: 'CELSIUS' });
  assert.equal(aged.uncertaintyInMilliseconds, 86_400_000);
  const fresh = base(ambient, { quality: 'fresh', value: 19.5, observedAt: at(1), validUntil: new Date(now + 600_000).toISOString(), lastReading: { value: 18, observedAt: at(300), revision: 9 } });
  const temperature = prop(stateReportProperties(endpoint, [target, ambient], [base(target), fresh], now), 'temperature');
  assert.equal(temperature.value.value, 19.5);
  assert.equal(temperature.uncertaintyInMilliseconds, 60_000);
});

test('explicit offline evidence reports the device as unreachable instead of reachable', () => {
  const offline = base(ambient, { deviceAvailability: 'offline', observedAt: at(5) });
  const properties = stateReportProperties(endpoint, [target, ambient], [base(target), offline], now);
  assert.equal(prop(properties, 'connectivity').value.value, 'UNREACHABLE');
});
