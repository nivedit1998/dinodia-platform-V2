import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
function loadTypeScript(relative) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const output = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(require, module, module.exports);
  return module.exports;
}
const { isAutomationEligibilityUpgrade } = loadTypeScript('src/lib/catalogAutomationEligibility.ts');

const setpoint = { schemaVersion: 1, deviceId: 'zigbee:trv', surfaceId: 's1', controlId: 'ctrl_setpoint', label: 'Occupied Heating Setpoint', group: 'Climate',
  sortOrder: 0, valueType: 'number', interactionKind: 'thermostat', semanticRole: 'target_temperature', readable: true, writable: true, automatable: false,
  observable: true, idempotency: 'set_value', confirmationPolicy: 'matching_observation', riskLevel: 'normal', stepUpPolicy: 'none',
  constraints: { minimum: 4, maximum: 35, step: 0.5, unit: '°C' }, expectedReportingIntervalSeconds: 120, maxStateValiditySeconds: 1800, unsupportedReason: null, catalogRevision: 16 };
const calibration = { ...setpoint, controlId: 'ctrl_calibration', label: 'Calibration', sortOrder: 1, semanticRole: 'unknown', interactionKind: 'slider' };
const prior = [setpoint, calibration];
const up = (control) => ({ ...control, automatable: true });

test('accepts only a false→true automatable change on an approved safe control', () => {
  assert.equal(isAutomationEligibilityUpgrade(prior, [up(setpoint), calibration]), true);
  assert.equal(isAutomationEligibilityUpgrade(prior, [{ ...up(setpoint), semanticRole: 'operating_mode', valueType: 'option', interactionKind: 'picker' }].concat([calibration]).map((c, i) => i === 0 ? c : c)), false, 'role change is another difference');
});

test('rejects every other difference', () => {
  const cases = {
    'label change': [{ ...up(setpoint), label: 'Target' }, calibration],
    'constraint change': [{ ...up(setpoint), constraints: { ...setpoint.constraints, maximum: 30 } }, calibration],
    'downgrade true→false': null,
    'unknown role upgraded': [setpoint, up(calibration)],
    'lock role upgraded': null,
    'step-up control upgraded': null,
    'extra control': [up(setpoint), calibration, { ...calibration, controlId: 'ctrl_extra', sortOrder: 2 }],
    'removed control': [up(setpoint)],
    'reordered controls': [calibration, up(setpoint)],
    'different controlId': [{ ...up(setpoint), controlId: 'ctrl_other' }, calibration],
    'no change at all': [setpoint, calibration],
  };
  for (const [name, next] of Object.entries(cases)) if (next) assert.equal(isAutomationEligibilityUpgrade(prior, next), false, name);
  assert.equal(isAutomationEligibilityUpgrade([up(setpoint), calibration], [setpoint, calibration]), false, 'downgrade true→false');
  const lock = { ...setpoint, semanticRole: 'security_lock', valueType: 'boolean', interactionKind: 'toggle' };
  assert.equal(isAutomationEligibilityUpgrade([lock], [up(lock)]), false, 'lock role upgraded');
  const stepUp = { ...setpoint, stepUpPolicy: 'required' };
  assert.equal(isAutomationEligibilityUpgrade([stepUp], [up(stepUp)]), false, 'step-up control upgraded');
  const sensitive = { ...setpoint, riskLevel: 'sensitive' };
  assert.equal(isAutomationEligibilityUpgrade([sensitive], [up(sensitive)]), false, 'sensitive control upgraded');
  const readOnly = { ...setpoint, writable: false };
  assert.equal(isAutomationEligibilityUpgrade([readOnly], [up(readOnly)]), false, 'read-only control upgraded');
  assert.equal(isAutomationEligibilityUpgrade('nope', [up(setpoint)]), false, 'malformed prior');
});

test('the ingestion handler uses the rule only on the same-revision branch', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/hubSyncIngestion.ts'), 'utf8');
  assert.match(source, /isAutomationEligibilityUpgrade\(priorCatalog\.controls, controls\)/);
  assert.match(source, /hub_sync_catalog_conflict/, 'other same-revision changes still conflict');
});
