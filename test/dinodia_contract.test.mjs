import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const root = path.join(process.cwd(), 'contracts/dinodia-v1');
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js');
const ts = require('typescript');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'contract.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
ajv.addSchema(contract);
const deviceSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/device` });
const valid = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/multi-control-device.json'), 'utf8'));
const privateFixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/tenant-device-wrong-owner.json'), 'utf8'));
const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/contracts/dinodiaV1.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module','exports',compiled)(module,module.exports);
const native = module.exports;
test('canonical device fixture passes schema and selected-home binding', () => {
  assert.equal(deviceSchema(valid.device), true);
  assert.equal(valid.device.homeId, valid.context.homeId);
  assert.ok(valid.device.controls.length >= 2);
});
test('account session fixture is multi-home, active, and rejects stale or mismatched memberships', () => {
  const value = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/account-session-two-homes.json'), 'utf8'));
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/accountSessionContext` });
  assert.equal(schema(value), true, JSON.stringify(schema.errors));
  assert.equal(native.validateAccountSessionContext(value, Date.parse('2029-01-01T00:00:00Z')), true);
  assert.equal(native.validateAccountSessionContext({ ...value, memberships: value.memberships.map((membership) => ({ ...membership, accountId: 'account:other' })) }, Date.parse('2029-01-01T00:00:00Z')), false);
  assert.equal(native.validateAccountSessionContext(value, Date.parse(value.expiresAt)), false);
  const duplicateHome = { ...value, memberships: [value.memberships[0], { ...value.memberships[1], homeId: value.memberships[0].homeId, homeMembershipId: 'membership:other' }] };
  assert.equal(native.validateAccountSessionContext(duplicateHome, Date.parse('2029-01-01T00:00:00Z')), false);
});
test('session receipt and selected-home bearer have separate strict, bounded contracts', () => {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/customer-session-receipt.json'), 'utf8'));
  const hubSession = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/customer-hub-session-test-only.json'), 'utf8'));
  const now = Date.parse('2026-09-27T10:00:00Z');
  const receiptSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/customerSessionReceipt` });
  const hubSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/customerHubSession` });
  assert.equal(receiptSchema(receipt), true, JSON.stringify(receiptSchema.errors));
  assert.equal(hubSchema(hubSession), true, JSON.stringify(hubSchema.errors));
  assert.equal(native.validateCustomerSessionReceipt(receipt, now), true);
  assert.equal(native.validateCustomerSessionReceipt({ ...receipt, token: 'leak' }, now), false);
  assert.equal(native.validateCustomerSessionReceipt({ ...receipt, expiresAt: '2026-09-27T10:00:00Z' }, now), false);
  const syntheticHubSession = { ...hubSession, token: 'synthetic-session-token-for-validator-test' };
  const expected = { homeId: 'home:fixture-owner', membershipId: 'membership:fixture-owner' };
  assert.equal(native.validateCustomerHubSession(syntheticHubSession, expected, now), true);
  assert.equal(native.validateCustomerHubSession(hubSession, expected, now), false, 'the checked-in placeholder is never treated as a bearer');
  assert.equal(native.validateCustomerHubSession(syntheticHubSession, { ...expected, homeId: 'home:other' }, now), false);
  assert.equal(native.validateCustomerHubSession(syntheticHubSession, { ...expected, membershipId: 'membership:other' }, now), false);
  assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, expiresAt: '2026-09-27T10:00:00Z' }, expected, now), false);
  assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, expiresAt: '2026-09-27T10:05:02Z' }, expected, now), false);
  assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, token: '' }, expected, now), false);
  assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, extra: true }, expected, now), false);
  for (const origin of ['http://dinodia-fixture-hub.dinodiasmartliving.com', 'https://other.example/dinodia', 'https://user@dinodia-fixture-hub.dinodiasmartliving.com', 'https://dinodia-fixture-hub.dinodiasmartliving.com:8443']) {
    assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, hubEndpoint: { state: 'verified_cloud', origin } }, expected, now), false, `untrusted hub origin ${origin}`);
  }
  assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, hubEndpoint: { state: 'unavailable', origin: 'https://dinodia-fixture-hub.dinodiasmartliving.com' } }, expected, now), false, 'unavailable endpoint cannot carry an origin');
  assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, hubEndpoint: { state: 'verified_cloud', origin: 'https://dinodia-fixture-hub.dinodiasmartliving.com', extra: true } }, expected, now), false, 'endpoint authority fields are exact');
});
test('offline home candidates are exact-account, tenant-only and fresh before an exact-home challenge', () => {
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/offlineHomeSelection` });
  const validOffline = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/offline-home-selection.json'), 'utf8'));
  const wrongAccount = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/offline-home-wrong-account.json'), 'utf8'));
  const expired = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/offline-home-expired.json'), 'utf8'));
  const now = Date.parse('2026-09-27T10:00:00Z');
  assert.equal(schema(validOffline), true, JSON.stringify(schema.errors));
  assert.equal(schema(wrongAccount), true, 'privacy mismatch remains structurally valid for semantic denial');
  assert.equal(schema(expired), true, 'expiry is evaluated against the consumer clock');
  assert.equal(native.validateOfflineHomeSelection(validOffline, now), true);
  assert.equal(native.validateOfflineHomeSelection(wrongAccount, now), false);
  assert.equal(native.validateOfflineHomeSelection(expired, now), false);
  assert.equal(native.validateOfflineHomeSelection({ ...validOffline, candidates: [{ ...validOffline.candidates[0], role: 'OWNER' }] }, now), false);
  assert.equal(native.validateOfflineHomeSelection({ ...validOffline, candidates: [{ ...validOffline.candidates[0], homeId: 'home:other' }, validOffline.candidates[0]] }, now), false);
});
test('wrong-owner tenant fixture is structurally valid but must fail membership authorization', () => {
  assert.equal(deviceSchema(privateFixture.device), true);
  assert.notEqual(privateFixture.device.ownerMembershipId, privateFixture.context.homeMembershipId);
  assert.equal(native.validateNativeDevice(privateFixture.device, privateFixture.context), false);
  assert.equal(native.validateNativeDevice(valid.device, { ...valid.context, homeId: 'home:wrong' }), false);
  assert.equal(native.validateNativeDevice({ ...valid.device, serviceId: 'light.turn_on' }, valid.context), false);
  assert.equal(native.validateNativeDevice(valid.device, { ...valid.context, role: 'PROPERTY_MANAGER', areaIds: ['area:private'] }), false);
  assert.equal(native.validateNativeDevice({ ...valid.device, controls: [{ ...valid.device.controls[0], semanticRole: 'guessed_admin' }] }, valid.context), false);
});
test('contract boundary fixes roles, management wire values and finite state quality', () => {
  assert.deepEqual(contract.$defs.role.enum, ['OWNER', 'PROPERTY_MANAGER', 'TENANT']);
  assert.deepEqual(contract.$defs.managementClass.enum, ['property_device', 'tenant_device']);
  assert.deepEqual(contract.$defs.quality.enum, ['fresh', 'stale', 'unknown', 'unavailable']);
  assert.equal(contract.wireRules.freshness.onlineThroughSeconds, 420);
  const change = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/control-catalog-change.json'), 'utf8'));
  assert.equal(change.effects.preserveDeviceId, true);
  assert.equal(change.effects.invalidatePendingCommands, true);
  const replacement = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/replacement-hub.json'), 'utf8'));
  assert.equal(replacement.homeId, 'home:opaque-a');
  assert.equal(replacement.nameBasedMergeAllowed, false);
});
test('canonical signed LAN endpoint contract keeps private installer routing out of customer DTOs', () => {
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/lanEndpointObservation` });
  const current = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/lan-endpoint-current.json'), 'utf8'));
  const unavailable = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/lan-endpoint-unavailable.json'), 'utf8'));
  const publicAddress = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/lan-endpoint-public-address.json'), 'utf8'));
  const extraAuthority = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/lan-endpoint-extra-authority-field.json'), 'utf8'));
  assert.equal(schema(current), true, JSON.stringify(schema.errors));
  assert.equal(schema(unavailable), true, JSON.stringify(schema.errors));
  assert.equal(schema(publicAddress), false);
  assert.equal(schema(extraAuthority), false);
  assert.equal(native.validateLanEndpointObservation(current, 'din-home-001'), true);
  assert.equal(native.validateLanEndpointObservation(unavailable, 'din-home-001'), true);
  for (const invalid of [
    { ...current, discoveryHost: 'dinodia-another-hub.local' },
    { ...current, baseUrl: 'http://192.168.0.110:8124' },
    { ...current, baseUrl: 'http://192.168.000.110:8123' },
    { ...current, baseUrl: 'http://172.17.0.2:8123' },
    { ...unavailable, baseUrl: 'http://192.168.0.110:8123' },
    { ...current, revision: 0 },
  ]) assert.equal(native.validateLanEndpointObservation(invalid, 'din-home-001'), false);
  assert.equal(contract.$defs.hubInstallation.properties.baseUrl, undefined, 'private installer IP is not exposed in the customer HubInstallation DTO');
  const openapi = fs.readFileSync(path.join(root, 'openapi.yaml'), 'utf8');
  assert.match(openapi, /HubLanEndpointObservation:\s*\n\s+\$ref: "\.\/contract\.json#\/\$defs\/lanEndpointObservation"/);
});
test('command validation enforces descriptor type, range, step and exact step-up reference', () => {
  const brightness = valid.device.controls.find((control) => control.controlId === 'control:brightness');
  const lock = valid.device.controls.find((control) => control.controlId === 'control:lock');
  const command = (control, value, extra = {}) => ({ commandId: 'command:test', homeId: valid.device.homeId, homeMembershipId: valid.context.homeMembershipId, deviceId: valid.device.id, controlId: control.controlId, descriptorRevision: valid.device.descriptorRevision, value, issuedAt: '2026-09-27T10:00:00Z', idempotencyKey: 'idempotency-key-0001', ...extra });
  assert.equal(native.validateCommandAgainstDevice(command(brightness, 25), valid.device, brightness, valid.context.homeMembershipId), true);
  for (const badValue of [100000, -1, 2.5, '50', NaN]) assert.equal(native.validateCommandAgainstDevice(command(brightness, badValue), valid.device, brightness, valid.context.homeMembershipId), false);
  assert.equal(native.validateCommandAgainstDevice(command(lock, true), valid.device, lock, valid.context.homeMembershipId), false);
  assert.equal(native.validateCommandAgainstDevice(command(lock, true, { stepUpOperationId: 'step-up:one-use' }), valid.device, lock, valid.context.homeMembershipId), true);
  assert.equal(native.validateCommandAgainstDevice(command(brightness, 25), valid.device, { ...brightness, constraints: { ...brightness.constraints, maximum: 1000000 } }, valid.context.homeMembershipId), false, 'caller cannot substitute a looser descriptor with the same revision');
  assert.equal(native.validateNativeDevice({ ...valid.device, controls: valid.device.controls.map((item) => item.controlId === lock.controlId ? { ...item, stepUpPolicy: 'none' } : item) }), false, 'security controls must require step-up in the descriptor itself');
});
test('Platform step-up proof signature matches the OS decoded-canonical-JSON verifier', () => {
  const codecSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/stepUpProofCodec.ts'), 'utf8');
  const codecCompiled = ts.transpileModule(codecSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const codecModule = { exports: {} };
  new Function('require','module','exports',codecCompiled)(require,codecModule,codecModule.exports);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = { jti: 'operation:1', actorId: 'account:1', trustedDeviceId: 'phone:1', customerSessionId: 'session:1', homeId: 'home:1', membershipId: 'membership:1', hubInstallId: 'hub:1', operationDigest: 'digest', issuedAt: 100, expiresAt: 160 };
  const [encoded, signature] = codecModule.exports.signStepUpPayload(payload, privateKey).split('.');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(crypto.verify(null, Buffer.from(JSON.stringify(decoded), 'utf8'), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(crypto.verify(null, Buffer.from(encoded, 'utf8'), publicKey, Buffer.from(signature, 'base64url')), false);
});
test('area and error schemas use the settled wire names and uppercase codes', () => {
  const areaSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/area` });
  const errorSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/error` });
  assert.equal(areaSchema({ id: 'area:a', homeId: 'home:a', originalName: 'Kitchen', overrideName: null, revision: 1, lifecycle: 'active' }), true);
  assert.equal(areaSchema({ id: 'area:a', homeId: 'home:a', canonicalName: 'Kitchen', overrideName: null, revision: 1, lifecycle: 'active' }), false);
  assert.equal(errorSchema({ error: { code: 'AUTH_REQUIRED', message: 'Sign in', requestId: 'request:a' } }), true);
  assert.equal(errorSchema({ error: { code: 'auth_required', message: 'Sign in', requestId: 'request:a' } }), false);
});
test('control state becomes Unknown at validUntil and rejects stale descriptor/home binding', () => {
  const control = valid.device.controls[0];
  const state = { deviceId: valid.device.id, controlId: control.controlId, homeId: valid.device.homeId, descriptorRevision: valid.device.descriptorRevision, revision: 1, observedAt: '2026-09-27T10:00:00Z', receivedAt: '2026-09-27T10:00:01Z', validUntil: '2026-09-27T10:02:00Z', quality: 'fresh', value: true, deviceAvailability: 'online', analyticsActivity: 'on' };
  assert.equal(native.validateControlState(state, valid.device, control), true);
  assert.equal(native.effectiveControlQuality(state, Date.parse(state.validUntil) - 1), 'fresh');
  assert.equal(native.effectiveControlQuality(state, Date.parse(state.validUntil)), 'unknown');
  assert.equal(native.validateControlState({ ...state, homeId: 'home:other' }, valid.device, control), false);
  assert.equal(native.validateControlState({ ...state, descriptorRevision: 2 }, valid.device, control), false);
});
test('decision-bearing lifecycle examples satisfy canonical schemas and preserve non-membership states', () => {
  const compile = (name) => ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` });
  const fixtures = [
    ['membershipInvitation', 'invitation-pending-no-membership.json'],
    ['claimReservation', 'claim-first-wins.json'],
    ['notification', 'notification-security-mandatory.json'],
    ['hubInstallation', 'hub-cloudurl-verified.json'],
  ];
  for (const [schema, name] of fixtures) {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', name), 'utf8'));
    assert.equal(compile(schema)(value), true, `${name}: ${JSON.stringify(compile(schema).errors)}`);
  }
  const invitation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invitation-pending-no-membership.json'), 'utf8'));
  assert.equal(invitation.membershipId, null);
  const claim = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/claim-first-wins.json'), 'utf8'));
  assert.equal(Date.parse(claim.expiresAt) - Date.parse(claim.createdAt), 30 * 60 * 1000);
  const badClaim = { ...claim, firstWins: false };
  assert.equal(compile('claimReservation')(badClaim), false);
});
test('analytics activity and aggregation semantics match the canonical shared fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/analytics-semantics.json'), 'utf8'));
  const analyticsSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/contracts/analyticsV1.ts'), 'utf8');
  const analyticsCompiled = ts.transpileModule(analyticsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const analyticsModule = { exports: {} };
  new Function('module','exports',analyticsCompiled)(analyticsModule,analyticsModule.exports);
  const api = analyticsModule.exports;
  const now = Date.parse(fixture.now);
  for (const item of fixture.activityCases) assert.equal(api.classifyActivityV1(item, now), item.expected, item.id);
  assert.deepEqual(api.averageContributingSamplesV1(fixture.aggregation.periodSamples), fixture.aggregation.periodExpected);
  assert.deepEqual(api.sumSelectedDevicesPerHourV1(fixture.aggregation.hourSamples), fixture.aggregation.hourExpected);
  assert.deepEqual(api.averageDisplayedBucketsV1(fixture.aggregation.displayedBuckets), fixture.aggregation.summaryExpected);
  assert.equal(api.classifyActivityV1({ category: 'light', quality: 'fresh', validUntil: 'invalid', signals: { powerOn: true } }, now), 'unknown');
  const invalid = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/analytics-invalid-sample.json'), 'utf8'));
  assert.throws(() => api.averageContributingSamplesV1([invalid.sample]), /Invalid analytics sample/);
});
test('numeric precision and option descriptors have one strict bound across the canonical validators', () => {
  const control = valid.device.controls.find((item) => item.controlId === 'control:brightness');
  const deviceFor = (constraints) => ({ ...valid.device, controls: valid.device.controls.map((item) => item.controlId === control.controlId ? { ...item, constraints } : item) });
  assert.equal(native.validateNativeDevice(deviceFor({ ...control.constraints, precision: 13 })), false);
  assert.equal(native.validateNativeDevice(deviceFor({ ...control.constraints, options: [{ value: 'a', label: 'A', privileged: true }] })), false);
  const emptyWritableOption = { ...valid.device, controls: valid.device.controls.map((item) => item.controlId === control.controlId ? { ...item, valueType: 'option', writable: true, constraints: { options: [] } } : item) };
  assert.equal(native.validateNativeDevice(emptyWritableOption), false);
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/device` });
  assert.equal(schema(deviceFor({ ...control.constraints, precision: 13 })), false);
  const optionSchemaDevice = { ...valid.device, controls: valid.device.controls.map((item) => item.controlId === control.controlId ? { ...item, valueType: 'option', interactionKind: 'picker', writable: true, constraints: { options: [] } } : item) };
  assert.equal(schema(optionSchemaDevice), false);
});
