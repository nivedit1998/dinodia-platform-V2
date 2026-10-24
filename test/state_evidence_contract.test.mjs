import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Ajv = require('ajv/dist/2020');
const contract = JSON.parse(fs.readFileSync('contracts/dinodia-v1/contract.json'));
const ajv = new Ajv({ strict: false }); ajv.addSchema(contract);
const schema = ajv.compile({ $ref: contract.$id + '#/$defs/controlStateEvidence2' });
const source = ts.transpileModule(fs.readFileSync('src/lib/contracts/dinodiaV1.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} }; new Function('require', 'module', 'exports', source)(require, module, module.exports);
const fixture = JSON.parse(fs.readFileSync('contracts/dinodia-v1/fixtures/state-evidence-retained.json'));
const { device } = JSON.parse(fs.readFileSync('contracts/dinodia-v1/fixtures/multi-control-device.json'));
const control = device.controls[0];
test('v2 retains false and genuine age without inventing a current value; strict v1 rejects extra evidence keys', () => {
  assert.equal(schema(fixture), true, JSON.stringify(schema.errors));
  assert.equal(module.exports.validateStateEvidence2(fixture, device, control), true);
  assert.equal(module.exports.validateControlState(fixture, device, control), false);
});
test('timestamp-limited provider snapshots never fabricate an age or current reading', () => {
  const state = structuredClone(fixture);
  state.lastReported.provenance = 'integration_snapshot';
  state.lastReported.observedAt = null; state.lastReported.receivedAt = null;
  state.evidence.status = 'timestamp_unavailable';
  assert.equal(schema(state), true);
  assert.equal(module.exports.validateStateEvidence2(state, device, control), true);
  state.lastReported.observedAt = '2026-10-24T08:00:00Z';
  assert.equal(module.exports.validateStateEvidence2(state, device, control), false);
});
for (const [name, change] of [
  ['wrong Home', state => { state.homeId = 'other'; }],
  ['wrong descriptor', state => { state.descriptorRevision++; }],
  ['invented current from last reported', state => { state.value = false; state.quality = 'fresh'; }],
  ['unknown version', state => { state.stateEvidenceVersion = 99; }],
  ['client-provided authority extension', state => { state.admin = true; }],
  ['invalid retained scalar', state => { state.lastReported.value = 'false'; }],
  ['invalid generation', state => { state.lastReported.sourceGeneration = 0; }],
  ['metadata received before observation', state => { state.lastReported.receivedAt = '2026-10-24T07:00:00Z'; }],
  ['unverified proof', state => { state.evidence.status = 'probably_current'; }],
  ['invalid provenance', state => { state.lastReported.provenance = 'mqtt_cache'; }],
]) test(`v2 refuses ${name}`, () => {
  const state = structuredClone(fixture); change(state);
  assert.equal(module.exports.validateStateEvidence2(state, device, control), false);
});
