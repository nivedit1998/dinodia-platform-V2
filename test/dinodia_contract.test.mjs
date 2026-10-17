import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { assertAccountRelationshipLifecycle, assertStage2DecisionFixtures, assertPrototypeActionMatrixBindings, executeIndexedFixtureScenario, projectAutomationPropertyImpact, resolveInstallationRequestDecision, resolvePrototypeActionDecision, simulateClaimLifecycle } from '../scripts/dinodia_stage2_decisions.mjs';

const root = path.join(process.cwd(), 'contracts/dinodia-v1');
const osRoot = process.env.DINODIA_OS_ROOT || path.resolve(process.cwd(), '../Dinodia OS');
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js');
const ts = require('typescript');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'contract.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validUtcTimestamp = (value) => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
};
ajv.addFormat('date-time', validUtcTimestamp);
ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
ajv.addSchema(contract);
const deviceSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/device` });
const valid = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/multi-control-device.json'), 'utf8'));
const privateFixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/tenant-device-wrong-owner.json'), 'utf8'));
const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/contracts/dinodiaV1.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module','exports','require',compiled)(module,module.exports,require);
const native = module.exports;
test('home invitation management projection is bounded, role-safe, expiring and secret-free', () => {
  const schema = ajv.getSchema(`${contract.$id}#/$defs/homePendingInvitationsReceipt`);
  assert.ok(schema);
  const homeId = '11111111-1111-4111-8111-111111111111';
  const generatedAt = '2026-10-16T12:00:00.000Z';
  const tenant = {
    invitationId: '22222222-2222-4222-8222-222222222222', targetEmail: 'tenant@example.test', role: 'TENANT', state: 'PENDING',
    createdAt: '2026-10-15T12:00:00.000Z', expiresAt: '2026-10-22T12:00:00.000Z', deliveryStatus: 'UNKNOWN',
    areas: [{ areaId: '33333333-3333-4333-8333-333333333333', name: 'Room 1' }],
  };
  const valid = { schemaVersion: 'dinodia.v1', ok: true, homeId, managementRevision: 8, generatedAt, invitations: [tenant], nextCursor: null };
  assert.equal(schema(valid), true, JSON.stringify(schema.errors));
  assert.equal(native.validateHomePendingInvitationsReceipt(valid, homeId, 'OWNER'), true);
  assert.equal(native.validateHomePendingInvitationsReceipt(valid, homeId, 'PROPERTY_MANAGER'), true);
  for (const invalid of [
    { ...valid, invitations: [{ ...tenant, role: 'PROPERTY_MANAGER' }] },
    { ...valid, invitations: [{ ...tenant, tokenHash: 'must-not-leak' }] },
    { ...valid, invitations: [{ ...tenant, areas: [] }] },
    { ...valid, invitations: Array.from({ length: 51 }, (_, index) => ({ ...tenant, invitationId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}` })) },
  ]) {
    assert.equal(schema(invalid), false, `JSON Schema rejects invalid invitation projection: ${JSON.stringify(invalid).slice(0, 260)}`);
    assert.equal(native.validateHomePendingInvitationsReceipt(invalid, homeId, 'PROPERTY_MANAGER'), false);
  }
  const expired = { ...valid, invitations: [{ ...tenant, expiresAt: generatedAt }] };
  assert.equal(schema(expired), true, 'the schema validates timestamp shape while the request-time validator enforces expiry');
  assert.equal(native.validateHomePendingInvitationsReceipt(expired, homeId, 'OWNER'), false);
  const ownerInvite = { ...tenant, invitationId: '44444444-4444-4444-8444-444444444444', role: 'PROPERTY_MANAGER', areas: [] };
  const ownerProjection = { ...valid, invitations: [ownerInvite] };
  assert.equal(schema(ownerProjection), true, JSON.stringify(schema.errors));
  assert.equal(native.validateHomePendingInvitationsReceipt(ownerProjection, homeId, 'OWNER'), true);
  assert.equal(native.validateHomePendingInvitationsReceipt(ownerProjection, homeId, 'PROPERTY_MANAGER'), false);
});
test('customer requirements and policy acceptance bind the exact server-owned text hash', () => {
  const text = 'A sufficiently long disposable policy text used only by this contract unit test.';
  const contentSha256 = crypto.createHash('sha256').update(text).digest('hex');
  const projection = { version: 'policy-test-v1', title: 'Test policy', text, contentSha256 };
  assert.equal(native.validateCustomerRequirementsReceipt({ schemaVersion: 'dinodia.v1', ok: true, nextAction: 'ACCEPT_POLICY', accepted: false, policy: projection }), true);
  assert.equal(native.validateCustomerRequirementsReceipt({ schemaVersion: 'dinodia.v1', ok: true, nextAction: 'POLICY_UNAVAILABLE', accepted: false, policy: null }), true);
  assert.equal(native.validateCustomerRequirementsReceipt({ schemaVersion: 'dinodia.v1', ok: true, nextAction: 'CONTINUE', accepted: false, policy: projection }), false);
  assert.equal(native.validateCustomerRequirementsReceipt({ schemaVersion: 'dinodia.v1', ok: true, nextAction: 'ACCEPT_POLICY', accepted: false, policy: { ...projection, contentSha256: 'a'.repeat(64) } }), false);
  assert.equal(native.validateCustomerPolicyAcceptanceReceipt({ schemaVersion: 'dinodia.v1', ok: true, policyVersion: projection.version, contentSha256, idempotentReplay: false }), true);
  assert.equal(native.validateCustomerPolicyAcceptanceReceipt({ schemaVersion: 'dinodia.v1', ok: true, policyVersion: projection.version, contentSha256, idempotentReplay: false, currentPolicy: true }), false);
});

test('prospective Room email receipts distinguish private verification from an already verified pending request', () => {
  const schema = ajv.getSchema(`${contract.$id}#/$defs/publicRoomAccessEmailChallengeReceipt`);
  assert.ok(schema);
  const verifyEmail = {
    schemaVersion: 'dinodia.v1', ok: true, state: 'VERIFY_EMAIL',
    requestId: '11111111-1111-4111-8111-111111111111',
    challengeId: '22222222-2222-4222-8222-222222222222',
    expiresAt: '2026-10-06T12:10:00Z', emailSubmission: 'ACCEPTED', idempotentReplay: false,
  };
  const pending = {
    schemaVersion: 'dinodia.v1', ok: true, state: 'PENDING',
    requestId: '33333333-3333-4333-8333-333333333333',
    expiresAt: '2026-10-13T12:00:00Z', revision: '2026-10-06T12:00:00Z',
    emailSubmission: 'NOT_REQUIRED', idempotentReplay: true,
  };
  for (const receipt of [verifyEmail, pending]) {
    assert.equal(schema(receipt), true, JSON.stringify(schema.errors));
    assert.equal(native.validatePublicRoomAccessEmailChallengeReceipt(receipt), true);
  }
  for (const invalid of [
    { ...verifyEmail, challengeId: undefined },
    { ...pending, revision: undefined },
    { ...pending, challengeId: '44444444-4444-4444-8444-444444444444' },
    { ...pending, emailSubmission: 'ACCEPTED' },
    { ...verifyEmail, revision: '2026-10-06T12:00:00Z' },
  ]) {
    assert.equal(schema(invalid), false, `JSON Schema rejects contradictory receipt: ${JSON.stringify(invalid)}`);
    assert.equal(native.validatePublicRoomAccessEmailChallengeReceipt(invalid), false);
  }
});

test('Room approval receipt can remain membership-free until the invited recipient explicitly accepts', () => {
  const requestId = crypto.randomUUID();
  const invited = { schemaVersion: 'dinodia.v1', ok: true, requestId, state: 'APPROVED', membershipId: null, idempotentReplay: false };
  const existingCustomer = { ...invited, membershipId: crypto.randomUUID() };
  assert.equal(native.validateCustomerRoomAccessDecisionReceipt(invited, requestId), true);
  assert.equal(native.validateCustomerRoomAccessDecisionReceipt(existingCustomer, requestId), true);
  assert.equal(native.validateCustomerRoomAccessDecisionReceipt({ ...invited, state: 'REJECTED', membershipId: crypto.randomUUID() }, requestId), false);
});

test('ownership-transfer HTTP contract binds one current owner workflow and recipient-bound presentations', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/ownership-transfer-api.json'), 'utf8'));
  const homeId = fixture.status.homeId;
  for (const [name, value] of Object.entries(fixture.schemaCases)) {
    if (name === 'ownershipTransferLabelResolveRequest') continue;
    const validate = ajv.getSchema(`${contract.$id}#/$defs/${name}`);
    assert.ok(validate, `schema exists for ${name}`);
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
  const resolveRequestSchema = ajv.getSchema(`${contract.$id}#/$defs/ownershipTransferResolveRequest`);
  assert.equal(resolveRequestSchema(fixture.schemaCases.ownershipTransferLabelResolveRequest), true, JSON.stringify(resolveRequestSchema.errors));
  assert.equal(native.validateOwnershipTransferStatus(fixture.status, homeId), true);
  assert.equal(native.validateOwnershipTransferStatus({ ...fixture.status, homeId: fixture.otherHomeId }, homeId), false);
  assert.equal(native.validateOwnershipTransferStatus({ ...fixture.status, recipientEmail: 'leak@example.test' }, homeId), false);
  assert.equal(native.validateOwnershipTransferStartRequest(fixture.schemaCases.ownershipTransferStartRequest), true);
  assert.equal(native.validateOwnershipTransferStartRequest({ ...fixture.schemaCases.ownershipTransferStartRequest, proof: {} }), false);
  assert.equal(native.validateOwnershipTransferCancelRequest(fixture.schemaCases.ownershipTransferCancelRequest), true);
  assert.equal(native.validateOwnershipTransferResolveRequest(fixture.schemaCases.ownershipTransferResolveRequest), true);
  assert.equal(native.validateOwnershipTransferResolveRequest(fixture.schemaCases.ownershipTransferLabelResolveRequest), true);
  assert.equal(native.validateOwnershipTransferResolveRequest({ reference: 'DNO-HOME-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', idempotencyKey: 'transfer-resolve-without-proof' }), false);
  assert.equal(native.validateOwnershipTransferResolveRequest({ ...fixture.schemaCases.ownershipTransferResolveRequest, injectedRole: 'OWNER' }), false);
  assert.equal(native.validateOwnershipTransferStartReceipt(fixture.schemaCases.ownershipTransferStartReceipt), true);
  assert.equal(native.validateOwnershipTransferCancelReceipt(fixture.schemaCases.ownershipTransferCancelReceipt), true);
  assert.equal(native.validateOwnershipTransferResolveReceipt(fixture.schemaCases.ownershipTransferResolveReceipt), true);
});
test('permanent-label Home claims require a strict signed hub resolver proof while Portal QR claims do not', () => {
  const claimRequest = ajv.compile({ $ref: `${contract.$id}#/$defs/customerHomeClaimResolveRequest` });
  const qr = { reference: `dno_home_${'Q'.repeat(48)}` };
  const proof = { version: 1, serial: 'din-home-001', identityGeneration: 2,
    challengeId: '11111111-2222-4333-8444-555555555555', challenge: 'A'.repeat(32), resolverGeneration: 3,
    expiresAt: '2026-10-06T12:00:00Z', timestamp: '1791288000000', nonce: 'N'.repeat(24), bodyHash: 'a'.repeat(64), hubSignature: 'S'.repeat(64) };
  const permanent = { reference: `DNO-HOME-${'L'.repeat(40)}`, resolverProof: proof };
  assert.equal(claimRequest(qr), true, JSON.stringify(claimRequest.errors));
  assert.equal(claimRequest(permanent), true, JSON.stringify(claimRequest.errors));
  assert.equal(native.validateCustomerHomeClaimResolveRequest(qr), true);
  assert.equal(native.validateCustomerHomeClaimResolveRequest(permanent), true);
  assert.equal(claimRequest({ ...permanent, resolverProof: { ...proof, identityGeneration: 0 } }), false);
  assert.equal(native.validateCustomerHomeClaimResolveRequest({ ...permanent, resolverProof: { ...proof, hubSignature: 'not-a-signature' } }), false);
  assert.equal(claimRequest({ reference: permanent.reference }), false, 'a permanent label without live hub proof is not a claim credential');
  assert.equal(claimRequest({ ...qr, resolverProof: proof }), false, 'a QR cannot smuggle an unrelated resolver proof');
});
test('permanent-label LAN endpoint projection is strict, fresh and contains only the verified hub identity', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  const lanEndpoint = { state: 'verified_lan', origin: 'https://dinodia-0123456789abcdefabcd.local:8123',
    publicHubId: '0123456789abcdefabcd', certificateGeneration: 2,
    currentSpkiPin: 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    currentNotBefore: '2026-10-05T00:00:00.000Z', currentNotAfter: '2026-10-07T00:00:00.000Z',
    reportedAt: '2026-10-06T11:59:00.000Z', validUntil: '2026-10-06T12:06:00.000Z', lanAddress: '192.168.1.76',
    lanAddressReportedAt: '2026-10-06T11:59:00.000Z', lanAddressValidUntil: '2026-10-06T12:06:00.000Z' };
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/customerHomeClaimLanEndpointReceipt` });
  const receipt = { schemaVersion: 'dinodia.v1', ok: true, lanEndpoint };
  assert.equal(schema(receipt), true, JSON.stringify(schema.errors));
  assert.equal(native.validateCustomerHomeClaimLanEndpointRequest({ reference: `DNO-HOME-${'A'.repeat(40)}` }), true);
  assert.equal(native.validateCustomerHomeClaimLanEndpointRequest({ reference: `DNO-HOME-${'A'.repeat(40)}`, homeId: 'caller-controlled' }), false);
  assert.equal(native.validateCustomerHomeClaimLanEndpointReceipt(receipt, now), true);
  assert.equal(native.validateCustomerHomeClaimLanEndpointReceipt({ ...receipt, homeId: 'leaked-home' }, now), false);
  assert.equal(native.validateCustomerHomeClaimLanEndpointReceipt({ ...receipt, lanEndpoint: { ...lanEndpoint, validUntil: '2026-10-06T11:59:59.000Z' } }, now), false);
  assert.equal(native.validateCustomerHomeClaimLanEndpointReceipt({ ...receipt, lanEndpoint: { ...lanEndpoint, origin: 'http://dinodia-0123456789abcdefabcd.local:80' } }, now), false);
  assert.equal(native.validateCustomerHomeClaimLanEndpointReceipt({ ...receipt, lanEndpoint: { ...lanEndpoint, lanAddress: '8.8.8.8' } }, now), false);
  assert.equal(native.validateCustomerLanEndpoint({ ...lanEndpoint, lanAddress: '192.168.1.76' }, now), false, 'private routing stays exclusive to the authenticated claim-proof endpoint');
  assert.equal(native.validateCustomerHomeClaimLanEndpointReceipt({ ...receipt, lanEndpoint: { ...lanEndpoint, lanAddressValidUntil: '2026-10-06T12:07:00.000Z' } }, now), false, 'LAN address validity cannot exceed the signed report lifetime');
  const missingAddress = { ...lanEndpoint };
  delete missingAddress.lanAddress;
  assert.equal(native.validateCustomerHomeClaimLanEndpointReceipt({ ...receipt, lanEndpoint: missingAddress }, now), false, 'the claim proof route requires a signed, fresh direct connection address');
});
test('invited tenant cannot choose a username until the invitation credential, email and server gate are satisfied', () => {
  const invitationId = '55555555-5555-4555-8555-555555555555';
  const request = { invitationId, email: 'tenant@example.invalid', password: 'one-time-password-123' };
  assert.equal(native.validateInvitedTenantRegistrationRequest(request), true);
  assert.equal(native.validateInvitedTenantRegistrationRequest({ ...request, username: 'chosen-too-early' }), false);
  assert.equal(native.validateInvitedTenantRegistrationRequest({ ...request, email: 'Tenant@example.invalid' }), false);
  assert.equal(native.validateInvitedTenantRegistrationRequest({ ...request, invitationId: 'not-a-uuid' }), false);
  assert.equal(native.validateInvitedTenantRegistrationRequest({ ...request, password: 'short' }), false);
  const username = { username: 'tenant.new' };
  assert.equal(native.validateInvitedTenantUsernameRequest(username), true);
  assert.equal(native.validateInvitedTenantUsernameRequest({ ...username, accountId: 'caller-authority' }), false);
  const receipt = { schemaVersion: 'dinodia.v1', ok: true, username: 'tenant.new', usernameNormalized: 'tenant.new', nextAction: 'CONTINUE' };
  assert.equal(native.validateInvitedTenantUsernameReceipt(receipt, username.username), true);
  assert.equal(native.validateInvitedTenantUsernameReceipt({ ...receipt, usernameNormalized: 'someone-else' }, username.username), false);
  assert.equal(ajv.compile({ $ref: `${contract.$id}#/$defs/invitedTenantRegistrationRequest` })(request), true);
  assert.equal(ajv.compile({ $ref: `${contract.$id}#/$defs/invitedTenantUsernameRequest` })(username), true);
});
test('customer profile contract is account-only and profile updates require a bounded exact proof', () => {
  const receipt = { schemaVersion: 'dinodia.v1', ok: true, accountId: 'account:fixture', displayName: 'Fixture Customer', username: 'fixture-customer', phoneNumber: null, email: 'customer@example.invalid', emailVerified: true, profileRevision: '2026-10-05T10:00:00.000Z' };
  const request = { displayName: 'Fixture Customer', username: 'fixture-customer', phoneNumber: null, expectedProfileRevision: receipt.profileRevision, proof: `dno-step-up-${'p'.repeat(48)}` };
  for (const [name, value] of [['customerProfileReceipt', receipt], ['customerProfileUpdateRequest', request]]) {
    const validate = ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` });
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
  assert.equal(native.validateCustomerProfileReceipt(receipt), true);
  assert.equal(native.validateCustomerProfileReceipt({ ...receipt, homeId: 'must-not-be-profile-authority' }), false);
  assert.equal(native.validateCustomerProfileUpdateRequest(request), true);
  assert.equal(native.validateCustomerProfileUpdateRequest({ ...request, address: 'must-remain-read-only' }), false);
  assert.equal(native.validateCustomerProfileUpdateRequest({ ...request, phoneNumber: 'not a phone' }), false);
  const challenge = { operationKind: 'customer_profile_change', targetIds: [receipt.accountId], value: { displayName: request.displayName, usernameNormalized: request.username, phoneNumber: null, profileRevision: request.expectedProfileRevision } };
  assert.equal(native.validateStepUpChallengeRequest(challenge), true);
  assert.equal(native.validateStepUpChallengeRequest({ ...challenge, value: { ...challenge.value, profileRevision: 'not-a-timestamp' } }), true, 'generic challenge contract leaves operation-specific values to its actual authority route');
});
test('tenant removal binds selected-home revisions, explicit last-relationship warning, and anonymous deletion receipt', () => {
  const request = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/tenant-membership-removal-request.json'), 'utf8'));
  const preview = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/tenant-membership-removal-final-warning.json'), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/tenant-membership-removal-other-home-preserved.json'), 'utf8'));
  assert.equal(native.validateTenantMembershipRemovalRequest(request), true);
  assert.equal(native.validateTenantMembershipRemovalRequest({ ...request, homeMembershipId: 'caller-selected' }), false);
  assert.equal(native.validateTenantMembershipRemovalPreview(preview), true);
  assert.equal(native.validateTenantMembershipRemovalPreview({ ...preview, willDeleteAccount: false }), false);
  assert.equal(native.validateTenantMembershipRemovalReceipt(receipt), true);
  assert.equal(native.validateTenantMembershipRemovalReceipt({ ...receipt, accountDeleted: true }), false);
});
test('customer email change request is exact, proof-bound and cannot claim verification before confirmation', () => {
  const profileRevision = '2026-10-05T10:00:00.000Z';
  const request = { email: 'new-customer@example.invalid', expectedProfileRevision: profileRevision, proof: `dno-step-up-${'e'.repeat(48)}` };
  const receipt = { schemaVersion: 'dinodia.v1', ok: true, state: 'PENDING', challengeId: 'challenge:email-change', expiresAt: '2026-10-05T10:10:00.000Z', emailSubmission: 'ACCEPTED' };
  for (const [name, value] of [['customerEmailChangeRequest', request], ['customerEmailChangeReceipt', receipt]]) {
    const validate = ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` });
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
  assert.equal(native.validateCustomerEmailChangeRequest(request), true);
  assert.equal(native.validateCustomerEmailChangeRequest({ ...request, homeId: 'not-authority' }), false);
  assert.equal(native.validateCustomerEmailChangeRequest({ ...request, email: 'not-an-email' }), false);
  assert.equal(native.validateCustomerEmailChangeRequest({ ...request, expectedProfileRevision: '2026-02-31T10:00:00Z' }), false);
  assert.equal(native.validateCustomerEmailChangeReceipt(receipt), true);
  assert.equal(native.validateCustomerEmailChangeReceipt({ ...receipt, state: 'VERIFIED' }), false);
  assert.equal(native.validateCustomerEmailChangeReceipt({ ...receipt, emailSubmission: 'DELIVERED' }), false);
});
const lanEndpointSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/lanEndpoint.ts'), 'utf8');
const lanEndpointCompiled = ts.transpileModule(lanEndpointSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const lanEndpointModule = { exports: {} };
new Function('module', 'exports', 'require', lanEndpointCompiled)(lanEndpointModule, lanEndpointModule.exports, () => ({ Stage1AuthError: class Stage1AuthError extends Error {}, validateLanEndpointObservation: () => true, validateLanTlsIdentityObservation: () => true }));
test('installation request decision binds current role, selected home, revision and exact retry state', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/installation-request-lifecycle.json'), 'utf8'));
  for (const item of fixture.cases) {
    assert.equal(resolveInstallationRequestDecision(item), item.expectedDecision, item.id);
    assert.equal(item.expectedEffects.homeCreated, false, item.id);
    assert.equal(item.expectedEffects.installationCompleted, false, item.id);
  }
  const stale = structuredClone(fixture.cases.find((item) => item.id === 'owner-submit-current'));
  stale.currentRevision += 1;
  assert.equal(resolveInstallationRequestDecision(stale), 'REVISION_CONFLICT');
  const invalidDate = structuredClone(fixture.cases.find((item) => item.id === 'expired-owner-retry'));
  invalidDate.at = '2026-02-31T10:00:00Z';
  assert.equal(resolveInstallationRequestDecision(invalidDate), 'INVALID_INPUT');
  const invalidExpiry = structuredClone(fixture.cases.find((item) => item.id === 'expired-owner-retry'));
  invalidExpiry.expiresAt = '2026-02-31T10:00:00Z';
  assert.equal(resolveInstallationRequestDecision(invalidExpiry), 'INVALID_TRANSITION');
});
test('property automation projection is selected-membership scoped and removes tenant-private fields', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/automation-property-impact.json'), 'utf8'));
  for (const item of fixture.cases) {
    const actual = projectAutomationPropertyImpact(fixture, item.request);
    assert.equal(actual.decision, item.expectedDecision, item.id);
    assert.deepEqual(actual.projection, item.expectedProjection, item.id);
    assert.equal(actual.protectedEffects, item.expectedProtectedEffects, item.id);
    assert.equal(actual.protectedEffects, 0, item.id);
  }
  const rendered = JSON.stringify(projectAutomationPropertyImpact(fixture, fixture.cases[1].request).projection);
  for (const secret of [
    'device:private-sensor-NEVER-RENDER', 'Private sensor NEVER RENDER', 'private-value-NEVER-RENDER',
    'automation:private-only-NEVER-RENDER', 'Private-only rule NEVER RENDER',
  ]) assert.equal(rendered.includes(secret), false, `private automation content leaked: ${secret}`);
  const malformed = structuredClone(fixture);
  malformed.homes[0].revision = -1;
  assert.equal(projectAutomationPropertyImpact(malformed, fixture.cases[1].request).decision, 'DENIED_NO_PROJECTION');
});
test('property automation projection rejects unrecognized target authority metadata', () => {
  const vector = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/automation-property-target-extra-authority.json'), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(root, vector.sourceFixture), 'utf8'));
  const scenario = fixture.cases.find((item) => item.id === vector.caseId);
  const automation = fixture.homes.find((home) => home.homeId === scenario.request.homeId).automations.find((item) => item.automationId === vector.automationId);
  const target = automation.targets.find((item) => item.deviceId === vector.targetDeviceId);
  target[vector.addField] = vector.addValue;
  const actual = projectAutomationPropertyImpact(fixture, scenario.request);
  assert.equal(actual.decision, vector.expectedDecision);
  assert.deepEqual(actual.projection, vector.expectedProjection);
  assert.equal(actual.protectedEffects, 0);
});
test('claim and invitation decision adapters reject impossible UTC calendar timestamps', () => {
  const claimPath = path.join(root, 'fixtures/claim-lifecycle.json');
  const invalidExpiry = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  invalidExpiry.initial.expiresAt = '2026-02-31T10:00:00Z';
  assert.throws(() => simulateClaimLifecycle(invalidExpiry), /valid UTC expiry/);

  const invalidEventTime = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  invalidEventTime.events[0].at = '2026-02-31T10:00:00Z';
  assert.throws(() => simulateClaimLifecycle(invalidEventTime), /Invalid claim event clock/);

  const invitation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invitation-lifecycle.json'), 'utf8'));
  const candidate = invitation.cases[0];
  candidate.at = '2026-02-31T10:00:00Z';
  assert.equal(resolvePrototypeActionDecision('invitation', 'accept', invitation, [candidate.id]), null);
});

test('invitation status contract is recipient-minimal and binds active membership only to ACCEPTED', () => {
  const schema = ajv.getSchema(`${contract.$id}#/$defs/customerInvitationStatusReceipt`);
  assert.ok(schema);
  const receipt = {
    schemaVersion: 'dinodia.v1', ok: true,
    invitationId: '44444444-4444-4444-8444-444444444444',
    state: 'PENDING', homeId: '11111111-1111-4111-8111-111111111111',
    role: 'TENANT', homeMembershipId: null,
  };
  assert.equal(schema(receipt), true, JSON.stringify(schema.errors));
  assert.equal(native.validateCustomerInvitationStatusReceipt(receipt, receipt.invitationId), true);
  for (const [state, membership] of [
    ['ACCEPTED', '22222222-2222-4222-8222-222222222222'],
    ['DECLINED', null], ['EXPIRED', null], ['REPLACED', null], ['REVOKED', null],
  ]) {
    const exact = { ...receipt, state, homeMembershipId: membership };
    assert.equal(schema(exact), true, `${state} must have its exact membership shape`);
    assert.equal(native.validateCustomerInvitationStatusReceipt(exact, receipt.invitationId), true);
  }
  for (const invalid of [
    { ...receipt, homeMembershipId: '22222222-2222-4222-8222-222222222222' },
    { ...receipt, state: 'DECLINED', homeMembershipId: '22222222-2222-4222-8222-222222222222' },
    { ...receipt, recipientEmail: 'must-not-leak@example.test' },
  ]) {
    assert.equal(schema(invalid), false);
    assert.equal(native.validateCustomerInvitationStatusReceipt(invalid, receipt.invitationId), false);
  }
  assert.equal(native.validateCustomerInvitationStatusReceipt(receipt, '55555555-5555-4555-8555-555555555555'), false,
    'A status receipt must bind the exact invitation ID requested by this recipient');
});
test('decision fixture runner rejects structurally valid privacy, delivery, offline and claim contradictions', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'fixtures', name), 'utf8'));
  const baseline = {
    support: read('support-private-notification.json'),
    receipt: read('notification-delivery-is-not-authority.json'),
    offline: read('offline-scope-widening.json'),
    decisionMatrix: read('stage2-decision-matrix.json'),
    claim: read('claim-lifecycle.json'),
    accountRelationshipLifecycle: read('account-relationship-lifecycle.json'),
  };
  assert.equal(assertStage2DecisionFixtures(baseline), true);

  const privateLeak = structuredClone(baseline);
  privateLeak.support.expectedPrivateRecipients = ['membership:owner-a', 'membership:tenant-a'];
  assert.throws(() => assertStage2DecisionFixtures(privateLeak), /Private tenant-device support/);

  const receiptAuthority = structuredClone(baseline);
  receiptAuthority.receipt.expectedMembershipCreated = true;
  receiptAuthority.receipt.invitation = {
    ...receiptAuthority.receipt.invitation,
    state: 'accepted', membershipId: 'membership:invitee',
  };
  assert.throws(() => assertStage2DecisionFixtures(receiptAuthority), /delivery receipt cannot create/);

  const widenedOffline = structuredClone(baseline);
  widenedOffline.offline.expectedAllowed = true;
  assert.throws(() => assertStage2DecisionFixtures(widenedOffline), /Offline selection widened/);

  const falseClaimExtension = structuredClone(baseline);
  falseClaimExtension.claim.events.find((event) => event.eventId === 'event:noop-save').expectedExpiresAt = '2026-09-28T11:35:00Z';
  assert.throws(() => assertStage2DecisionFixtures(falseClaimExtension), /Claim lifecycle transition mismatch/);

  const decisionDrift = structuredClone(baseline);
  decisionDrift.decisionMatrix.offline.scopeCanWiden = true;
  assert.throws(() => assertStage2DecisionFixtures(decisionDrift), /Contradictory executable decision fixture/);

  const reclassifiedSupport = structuredClone(baseline);
  reclassifiedSupport.accountRelationshipLifecycle.retainedRelationshipKinds.push('open_support_ticket');
  reclassifiedSupport.accountRelationshipLifecycle.nonRetainingKinds = reclassifiedSupport.accountRelationshipLifecycle.nonRetainingKinds
    .filter((kind) => kind !== 'open_support_ticket');
  assert.throws(() => assertStage2DecisionFixtures(reclassifiedSupport), /taxonomy differs from the canonical decision register/);
});
test('Swift/Platform account-retention fixture taxonomy is anchored to the canonical decision register', () => {
  const account = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/account-relationship-lifecycle.json'), 'utf8'));
  assert.deepEqual(assertAccountRelationshipLifecycle(account), { cases: 8 });
  const forged = structuredClone(account);
  forged.retainedRelationshipKinds.push('open_support_ticket');
  forged.nonRetainingKinds = forged.nonRetainingKinds.filter((kind) => kind !== 'open_support_ticket');
  forged.cases.find((item) => item.id === 'open-support-ticket-does-not-retain-account').expected = 'ACCOUNT_RETAINED';
  assert.throws(() => assertAccountRelationshipLifecycle(forged), /taxonomy differs from the canonical decision register/);
});
test('V2 iOS distribution decision is concrete, configured locally, and externally unclaimed', () => {
  const decisions = JSON.parse(fs.readFileSync(path.join(root, 'decisions.json'), 'utf8')).distribution;
  const identity = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/ios-v2-distribution-identity.json'), 'utf8'));
  const ios = process.env.DINODIA_IOS_ROOT || path.resolve(process.cwd(), '../dinodia-ios-app-V2');
  const project = fs.readFileSync(path.join(ios, 'Dinodia.xcodeproj/project.pbxproj'), 'utf8');
  const entitlements = fs.readFileSync(path.join(ios, 'Dinodia/Dinodia.entitlements'), 'utf8');
  const info = fs.readFileSync(path.join(ios, 'Dinodia/Info.plist'), 'utf8');
  const aasa = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/.well-known/apple-app-site-association'), 'utf8'));
  const nextConfig = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');
  assert.equal(identity.bundleIdentifier, 'com.dinodia.DinodiaV2');
  assert.equal(identity.displayName, 'Dinodia Smart Living');
  assert.equal(identity.apnsTopic, identity.bundleIdentifier);
  assert.equal(identity.keychainAccessGroup, '$(AppIdentifierPrefix)com.dinodia.DinodiaV2');
  assert.equal(identity.teamIdentifier, 'P759CSZK34');
  assert.equal(identity.appSiteAssociationApplicationIdentifier, 'P759CSZK34.com.dinodia.DinodiaV2');
  assert.deepEqual(identity.associatedDomains, ['applinks:dinodia-platform-v2.vercel.app']);
  assert.equal(identity.deepLinkScheme, 'dinodia-v2');
  assert.equal(identity.universalLinkPathPrefix, '/app/');
  assert.equal(decisions.bundleIdentifier, identity.bundleIdentifier);
  assert.equal(decisions.keychainAccessGroup, identity.keychainAccessGroup);
  assert.equal(identity.appStoreRecordStatus, 'external_record_and_signing_required');
  for (const field of ['oldAppImportAllowed', 'oldAppSessionReuseAllowed', 'oldAppPushTokenReuseAllowed', 'oldAppCachedHomeImportAllowed', 'oldAppDeepLinkAuthenticationAllowed']) {
    assert.equal(identity.forbiddenLegacyState[field], false, field);
  }
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.dinodia\.DinodiaV2;/);
  assert.match(project, /INFOPLIST_KEY_CFBundleDisplayName = "Dinodia Smart Living";/);
  assert.equal((project.match(/CODE_SIGN_ENTITLEMENTS = Dinodia\/Dinodia\.entitlements;/g) ?? []).length, 2);
  assert.match(entitlements, /<string>\$\(DINODIA_APS_ENVIRONMENT\)<\/string>/);
  assert.match(entitlements, /\$\(AppIdentifierPrefix\)com\.dinodia\.DinodiaV2/);
  assert.match(entitlements, /applinks:dinodia-platform-v2\.vercel\.app/);
  assert.match(info, /<string>dinodia-v2<\/string>/);
  assert.doesNotMatch(entitlements, /com\.apple\.security\.application-groups|ubiquity-kvstore/);
  assert.deepEqual(aasa.applinks.details[0].appIDs, ['P759CSZK34.com.dinodia.DinodiaV2']);
  assert.deepEqual(aasa.applinks.details[0].components, [{ '/': '/app/*' }]);
  assert.match(nextConfig, /source: '\/\.well-known\/apple-app-site-association'/);
  assert.match(nextConfig, /key: 'Content-Type', value: 'application\/json'/);
  assert.doesNotMatch(entitlements, /com\.apple\.application-identifier/);
});
test('indexed matrix scenario runner executes the owning semantic decision and fails closed on drift', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'fixtures', name), 'utf8'));
  const support = read('support-private-notification.json');
  const adapters = {
    os: require(path.join(osRoot, 'src/contracts/dinodiaV1.js')),
    platform: native,
    analytics: require(path.join(osRoot, 'src/contracts/analyticsV1.js')),
    schema: (name, value) => ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` })(value),
    readFixture: (reference) => read(reference.replace(/^fixtures\//, '')),
  };
  const result = executeIndexedFixtureScenario({
    screenKey: 'owner.support', fixturePath: 'fixtures/support-private-notification.json', fixture: support,
    schemaChecks: [], adapters,
  });
  assert.equal(result.actualOutcome, 'matched');
  assert.equal(result.semantic, 'accepted');
  const contradiction = structuredClone(support);
  contradiction.expectedPrivateRecipients = ['membership:owner-a', 'membership:tenant-a'];
  assert.throws(() => executeIndexedFixtureScenario({
    screenKey: 'owner.support', fixturePath: 'fixtures/support-private-notification.json', fixture: contradiction,
    schemaChecks: [], adapters,
  }), /private support recipient projection differs/);
  assert.throws(() => executeIndexedFixtureScenario({
    screenKey: 'system.unregistered', fixturePath: 'fixtures/not-indexed.json', fixture: {},
    schemaChecks: [], adapters,
  }), /no owning semantic validator, adapter, reducer or decision executor/);
});
test('every rendered action decision fixture is indexed by a rendered screen', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'fixtures', name), 'utf8'));
  const index = read('index.json');
  const prototype = read('prototype-scenarios.json');
  assert.equal(assertPrototypeActionMatrixBindings(prototype, index), true);
  const driftedIndex = structuredClone(index);
  driftedIndex.screenFixtures['auth.customer.recovery'] = driftedIndex.screenFixtures['auth.customer.recovery']
    .filter((reference) => reference !== 'fixtures/customer-recovery-lifecycle.json');
  driftedIndex.screenFixtures['auth.owner.recovery'] = driftedIndex.screenFixtures['auth.owner.recovery']
    .filter((reference) => reference !== 'fixtures/customer-recovery-lifecycle.json');
  assert.throws(() => assertPrototypeActionMatrixBindings(prototype, driftedIndex), /decision fixture is not indexed/);
});
test('quiet-hours projection declares the precise individual deferral result consistently', () => {
  const prototype = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/prototype-scenarios.json'), 'utf8'));
  const flow = prototype.flows['quiet-hours'];
  const action = flow.actions.find((item) => item.id === 'optional');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/notification-lifecycle.json'), 'utf8'));
  const decision = resolvePrototypeActionDecision('quiet-hours', action.id, fixture, action.decisionCases);
  assert.equal(decision, 'DEFERRED_INDIVIDUALLY_UNTIL_QUIET_HOURS_END');
  assert.equal(action.expectedDecision, decision);
  assert.notEqual(decision, 'DEFERRED_UNTIL_QUIET_HOURS_END');
});
test('duplicate-name area scenario binds exact Home and membership-scoped grants', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'fixtures', name), 'utf8'));
  const adapters = {
    os: require(path.join(osRoot, 'src/contracts/dinodiaV1.js')),
    platform: native,
    analytics: require(path.join(osRoot, 'src/contracts/analyticsV1.js')),
    schema: (name, value) => ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` })(value),
    readFixture: (reference) => read(reference.replace(/^fixtures\//, '')),
  };
  const fixture = read('duplicate-display-names.json');
  const run = (value) => executeIndexedFixtureScenario({
    screenKey: 'owner.floorplan', fixturePath: 'fixtures/duplicate-display-names.json', fixture: value,
    schemaChecks: [], adapters,
  });
  assert.equal(run(fixture).semantic, 'accepted');

  const wrongHome = structuredClone(fixture);
  wrongHome.homeId = 'home:another-property';
  assert.throws(() => run(wrongHome), /same-name area scenario must bind/);

  const tenantScopeWidened = structuredClone(adapters.readFixture('fixtures/stage2-decision-matrix.json'));
  tenantScopeWidened.property.partialGrantCombinedAreaIds = ['area:bedroom-a', 'area:bedroom-b'];
  adapters.readFixture = (reference) => reference.endsWith('stage2-decision-matrix.json')
    ? tenantScopeWidened
    : read(reference.replace(/^fixtures\//, ''));
  assert.throws(() => run(fixture), /same-name area scenario must bind/);

  const wrongMembership = structuredClone(tenantScopeWidened);
  wrongMembership.property.partialGrantCombinedAreaIds = ['area:bedroom-a'];
  wrongMembership.property.areaScopeMemberships.partialTenantMembershipId = 'membership:other-tenant';
  adapters.readFixture = (reference) => reference.endsWith('stage2-decision-matrix.json')
    ? wrongMembership
    : read(reference.replace(/^fixtures\//, ''));
  assert.throws(() => run(fixture), /same-name area scenario must bind/);
});
test('canonical timestamps reject impossible Gregorian dates in schema and Platform runtime', () => {
  const invalid = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/impossible-calendar-date-envelope.json'), 'utf8'));
  const validator = ajv.compile({ $ref: `${contract.$id}#/$defs/envelope` });
  assert.equal(validator(invalid), false);
  assert.equal(native.validateEnvelope(invalid), false);
  assert.equal(native.validateEnvelope({ ...invalid, generatedAt: '2024-02-29T23:59:59Z' }), true);
  assert.equal(native.validateEnvelope({ ...invalid, generatedAt: '2025-02-29T23:59:59Z' }), false);
});
test('command issuedAt rejects impossible Gregorian dates across schema, Platform and OS validators', () => {
  const invalid = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/impossible-calendar-date-command.json'), 'utf8'));
  const device = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/multi-control-device.json'), 'utf8')).device;
  const control = device.controls.find((item) => item.controlId === invalid.command.controlId);
  const commandSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/command` });
  assert.equal(commandSchema(invalid.command), false);
  assert.equal(native.validateCommandAgainstDevice(invalid.command, device, control, invalid.command.homeMembershipId), false);
  const os = require(path.join(osRoot, 'src/contracts/dinodiaV1.js'));
  assert.equal(os.validateCommand(invalid.command, device, control, invalid.command.homeMembershipId), false);
  for (const issuedAt of ['2026-02-28T23:59:59Z', '2024-02-29T12:00:00Z']) {
    const candidate = { ...invalid.command, issuedAt };
    assert.equal(commandSchema(candidate), true, issuedAt);
    assert.equal(native.validateCommandAgainstDevice(candidate, device, control, candidate.homeMembershipId), true, issuedAt);
    assert.equal(os.validateCommand(candidate, device, control, candidate.homeMembershipId), true, issuedAt);
  }
  for (const issuedAt of ['2025-02-29T12:00:00Z', '2026-04-31T10:00:00Z']) {
    const candidate = { ...invalid.command, issuedAt };
    assert.equal(commandSchema(candidate), false, issuedAt);
    assert.equal(native.validateCommandAgainstDevice(candidate, device, control, candidate.homeMembershipId), false, issuedAt);
    assert.equal(os.validateCommand(candidate, device, control, candidate.homeMembershipId), false, issuedAt);
  }
});
test('Platform rejects a noncanonical stepUpPolicy before descriptor projection', () => {
  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/device-invalid-step-up-policy.json'), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(root, mutation.sourceFixture), 'utf8'));
  const device = structuredClone(fixture.device);
  const control = device.controls.find((item) => item.controlId === mutation.controlId);
  assert.ok(control);
  control[mutation.field] = mutation.invalidValue;
  assert.equal(deviceSchema(device), false);
  assert.equal(native.validateNativeDevice(device), false);
});
test('customer login text limits use canonical Unicode code points', () => {
  assert.equal(native.boundedContractText('😀', 1), '😀');
  assert.equal(native.boundedContractText('😀😀', 1), '');
  assert.equal(native.boundedContractText('é', 2), 'é');
  assert.equal(native.boundedContractText('é', 1), '');
  assert.equal(native.boundedContractText('  id  ', 2), 'id');
  assert.equal(native.boundedContractText('id', -1), '');
});
test('customer login request has one strict canonical shape without fixture credentials', () => {
  const request = {
    email: 'customer@example.invalid',
    password: 'ephemeral-test-input-only',
    deviceInstallationId: 'installation:test-only',
    publicKey: 'synthetic-test-public-key',
    deviceName: 'Dinodia Smart Living test client',
    model: 'test model',
    osFamily: 'test',
    osVersion: 'test',
  };
  const validator = ajv.compile({ $ref: `${contract.$id}#/$defs/customerSessionLoginRequest` });
  assert.equal(validator(request), true, JSON.stringify(validator.errors));
  assert.equal(native.validateCustomerSessionLoginRequest(request), true);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, extraAuthority: true }), false);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, password: '' }), false);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, deviceName: '   ' }), false);
  assert.equal(validator({ ...request, deviceInstallationId: '   ' }), false);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, deviceInstallationId: '   ' }), false);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, email: 'not-an-email' }), false);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, deviceInstallationId: `😀${'a'.repeat(160)}` }), false);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, publicKey: 'x'.repeat(4097) }), false);
  assert.equal(native.validateCustomerSessionLoginRequest({ ...request, model: 7 }), false);
});
test('customer logout receipt is exact and contains no reusable session material', () => {
  const validator = ajv.compile({ $ref: `${contract.$id}#/$defs/customerSessionLogoutReceipt` });
  assert.equal(validator({ ok: true }), true);
  assert.equal(native.validateCustomerSessionLogoutReceipt({ ok: true }), true);
  assert.equal(native.validateCustomerSessionLogoutReceipt({ ok: true, token: 'not-permitted' }), false);
  assert.equal(native.validateCustomerSessionLogoutReceipt({ ok: false }), false);
});
test('active Native V2 security routes validate their canonical request and response DTOs', () => {
  const schema = (name, value) => {
    const validator = ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` });
    assert.equal(validator(value), true, `${name}: ${JSON.stringify(validator.errors)}`);
  };
  const challenge = { operationKind: 'support_access_approve', targetIds: ['ticket:1', 'request:1'], value: 'I approve this support access for my property' };
  schema('stepUpChallengeRequest', challenge);
  assert.equal(native.validateStepUpChallengeRequest(challenge), true);
  assert.equal(native.validateStepUpChallengeRequest({ ...challenge, targetIds: ['ticket:1', 'ticket:1'] }), false);
  assert.equal(native.validateStepUpChallengeRequest({ ...challenge, extraAuthority: true }), false);
  for (const operationKind of ['home.tenant_automation_disable', 'home.tenant_automation_delete']) {
    const automationIntervention = { operationKind, targetIds: ['123e4567-e89b-42d3-a456-426614174000'],
      value: { action: operationKind.endsWith('_disable') ? 'disable' : 'delete', expectedAutomationRevision: 1,
        expectedManagementRevision: 1, reason: 'safety' } };
    schema('stepUpChallengeRequest', automationIntervention);
    assert.equal(native.validateStepUpChallengeRequest(automationIntervention), true, `${operationKind} must be supported by the shared request validator`);
  }
  const descriptor = { version: 1, serial: 'serial:1', identityGeneration: 2, actorId: 'account:1', customerSessionId: 'session:1', trustedDeviceId: 'trusted:1', homeId: 'home:1', membershipId: 'membership:1', hubInstallId: 'hub:1', operationKind: 'device_sensitive_command', targetIds: ['device:1'], controlId: 'control:1', descriptorRevision: 5, descriptorDigest: null, operationDigest: 'a'.repeat(64), nonce: 'n'.repeat(24), issuedAt: 1790000000000, hubSignature: 's'.repeat(64) };
  const descriptorChallenge = { operationKind: 'device_sensitive_command', targetIds: ['device:1'], value: true, descriptorAttestation: descriptor };
  schema('stepUpChallengeRequest', descriptorChallenge);
  assert.equal(native.validateStepUpChallengeRequest(descriptorChallenge), true);
  assert.equal(native.validateStepUpChallengeRequest({ ...descriptorChallenge, descriptorAttestation: { ...descriptor, targetIds: ['device:2'] } }), false);
  assert.equal(native.validateStepUpCancellationRequest({ challengeId: 'challenge:1' }), true);
  assert.equal(native.validateStepUpCancellationRequest({ challengeId: 'challenge:1', extra: 1 }), false);
  const issueRequest = { challengeId: 'challenge:1', nonce: 'n'.repeat(24), deviceSignature: 's'.repeat(64) };
  schema('stepUpIssueRequest', issueRequest);
  assert.equal(native.validateStepUpIssueRequest(issueRequest), true);
  const consumeRequest = { operationKind: 'device_sensitive_command', targetIds: ['device:1'], proof: 'proof-value', descriptorDigests: { 'device:1': 'b'.repeat(64) }, value: true };
  schema('stepUpConsumeRequest', consumeRequest);
  assert.equal(native.validateStepUpConsumeRequest(consumeRequest), true);
  assert.equal(native.validateStepUpConsumeRequest({ ...consumeRequest, descriptorDigests: { 'device:1': 'not-a-digest' } }), false);
  const offlineRequest = { trustedDeviceId: 'trusted:1', publicKey: 'PUBLIC KEY' };
  schema('offlineAuthorisationRequest', offlineRequest);
  assert.equal(native.validateOfflineAuthorisationRequest(offlineRequest), true);
  const offlineReceipt = { ok: true, authorisation: { id: 'offline:1', homeId: 'home:1', membershipId: 'membership:1', trustedDeviceId: 'trusted:1', areaIds: ['area:1'], scopes: ['tenant:device-command'], policyRevision: 2 } };
  schema('offlineAuthorisationReceipt', offlineReceipt);
  assert.equal(native.validateOfflineAuthorisationReceipt(offlineReceipt), true);
  assert.equal(native.validateOfflineAuthorisationReceipt({ ...offlineReceipt, authorisation: { ...offlineReceipt.authorisation, scopes: ['property:admin'] } }), false);
  const notification = { ok: true, notifications: [{ id: 'notification:1', ticketId: 'ticket:1', eventType: 'STARTED', createdAt: '2026-09-29T10:00:00Z' }] };
  schema('supportNotificationProjection', notification);
  assert.equal(native.validateSupportNotificationProjection(notification), true);
  assert.equal(native.validateSupportNotificationProjection({ ok: true, notifications: [{ ...notification.notifications[0], privateDescription: 'must not escape' }] }), false);
  const closeRequest = { action: 'close', proof: 'proof-value' };
  schema('supportTicketCloseRequest', closeRequest);
  assert.equal(native.validateSupportTicketCloseRequest(closeRequest), true);
  assert.equal(native.validateSupportTicketCloseRequest({ action: 'close', proof: 'proof', privateNote: 'extra' }), false);
  const closeReceipt = { ok: true, ticketId: 'ticket:1', status: 'CLOSED', message: 'Support request closed; no hub access required enforcement', hubEnforcement: 'NOT_REQUIRED' };
  schema('supportTicketCloseReceipt', closeReceipt);
  assert.equal(native.validateSupportTicketCloseReceipt(closeReceipt), true);
  assert.equal(native.validateSupportTicketCloseReceipt({ ...closeReceipt, hubEnforcement: 'PENDING' }), true);
  assert.equal(native.validateSupportTicketCloseReceipt({ ...closeReceipt, hubEnforcement: 'MAYBE' }), false);
});
test('support create boundaries enforce the seven-category and exact scoped-request DTOs', () => {
  const schema = (name, value) => {
    const validator = ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` });
    assert.equal(validator(value), true, `${name}: ${JSON.stringify(validator.errors)}`);
  };
  const ticketRequest = { category: 'ACCESS_OR_PERMISSIONS', description: 'The door sensor is not reporting.' };
  schema('supportTicketCreateRequest', ticketRequest);
  assert.equal(native.validateSupportTicketCreateRequest(ticketRequest), true);
  assert.equal(native.validateSupportTicketCreateRequest({ ...ticketRequest, category: 'HARNESS_PRIVATE' }), false);
  assert.equal(native.validateSupportTicketCreateRequest({ ...ticketRequest, hiddenInternalNote: 'not customer supplied' }), false);
  const ticketReceipt = { ok: true, ticket: { id: 'ticket:1', publicReference: 'DNO-123456', status: 'OPEN', createdAt: '2026-09-29T10:00:00Z' } };
  schema('supportTicketCreateReceipt', ticketReceipt);
  assert.equal(native.validateSupportTicketCreateReceipt(ticketReceipt), true);
  const request = { requestedScope: 'TENANT_SCOPE', targetMembershipId: 'membership:1', areaIds: ['area:1'], targetIds: ['device:1'] };
  schema('supportAccessRequestCreateRequest', request);
  assert.equal(native.validateSupportAccessRequestCreateRequest(request), true);
  assert.equal(native.validateSupportAccessRequestCreateRequest({ ...request, areaIds: ['area:1', 'area:1'] }), false);
  assert.equal(native.validateSupportAccessRequestCreateRequest({ ...request, targetIds: ['device:1', 'device:1'] }), false);
  const receipt = { ok: true, accessRequest: { id: 'request:1', status: 'REQUESTED', requestedScope: 'TENANT_SCOPE', touchesPropertyInfrastructure: false, createdAt: '2026-09-29T10:00:00Z' } };
  schema('supportAccessRequestCreateReceipt', receipt);
  assert.equal(native.validateSupportAccessRequestCreateReceipt(receipt), true);
  assert.equal(native.validateSupportAccessRequestCreateReceipt({ ...receipt, accessRequest: { ...receipt.accessRequest, targetUserId: 'private' } }), false);
});
test('support decision contract requires an explicit choice and keeps denial receipts secret-free', () => {
  const schema = (name, value) => {
    const validator = ajv.compile({ $ref: `${contract.$id}#/$defs/${name}` });
    assert.equal(validator(value), true, `${name}: ${JSON.stringify(validator.errors)}`);
  };
  const approval = { approve: true, confirmation: 'I approve this support access for my property', proof: 'step-up-proof' };
  schema('supportAccessDecisionRequest', approval);
  assert.equal(native.validateSupportAccessDecisionRequest(approval), true);
  assert.equal(native.validateSupportAccessDecisionRequest({}), false);
  assert.equal(native.validateSupportAccessDecisionRequest({ approve: false, proof: 'must-not-ride-a-denial' }), false);
  assert.equal(native.validateSupportAccessDecisionRequest({ ...approval, unexpected: true }), false);
  const denied = { ok: true, requestId: 'request:1', status: 'DENIED' };
  schema('supportAccessDecisionReceipt', denied);
  assert.equal(native.validateSupportAccessDecisionReceipt(denied), true);
  assert.equal(native.validateSupportAccessDecisionReceipt({ ...denied, oneUseCode: 'must-not-exist' }), false);
  const approved = { ok: true, requestId: 'request:1', status: 'APPROVED' };
  schema('supportAccessDecisionReceipt', approved);
  assert.equal(native.validateSupportAccessDecisionReceipt(approved), true);
  assert.equal(native.validateSupportAccessDecisionReceipt({ ...approved, oneUseCode: 'never-return-this-to-the-customer' }), false);
  const issued = { ok: true, requestId: 'request:1', status: 'ISSUED', oneUseCode: `DNO-S-${'A'.repeat(24)}`, supportUrl: 'https://dinodia-example.local/support-access', codeExpiresAt: '2026-09-29T10:10:00Z' };
  schema('supportAccessIssueReceipt', issued);
  assert.equal(native.validateSupportAccessIssueReceipt(issued), true);
  assert.equal(native.validateSupportAccessIssueReceipt({ ...issued, supportUrl: 'https://attacker.example/support-access?code=secret' }), false);
});
test('support revocation DTOs match the customer step-up route and reject caller-supplied authority', () => {
  const requestSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/supportAccessRevokeRequest` });
  const receiptSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/supportAccessRevokeReceipt` });
  const request = { confirmation: 'I revoke this support access for my property', proof: 'fixture-only-step-up-proof' };
  const receipt = { ok: true, requestId: 'request:1', status: 'REVOKED', message: 'Property support access revoked — waiting for hub confirmation' };
  assert.equal(requestSchema(request), true);
  assert.equal(native.validateSupportAccessRevokeRequest(request), true);
  assert.equal(native.validateSupportAccessRevokeRequest({ confirmation: request.confirmation, homeId: 'home:attacker' }), false);
  assert.equal(native.validateSupportAccessRevokeRequest({ confirmation: 'wrong confirmation' }), false);
  assert.equal(receiptSchema(receipt), true);
  assert.equal(native.validateSupportAccessRevokeReceipt(receipt), true);
  assert.equal(native.validateSupportAccessRevokeReceipt({ ...receipt, proof: 'must-not-be-echoed' }), false);
});
test('trusted-device revocation request and receipt match the actual account-wide DELETE route', () => {
  const requestSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/trustedDeviceRemovalRequest` });
  const receiptSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/trustedDeviceRemovalReceipt` });
  for (const request of [{}, { proof: 'one-use-proof' }]) {
    assert.equal(requestSchema(request), true, JSON.stringify(requestSchema.errors));
    assert.equal(native.validateTrustedDeviceRemovalRequest(request), true);
  }
  for (const request of [{ extraAuthority: true }, { proof: '' }, { proof: 'p'.repeat(8193) }]) {
    assert.equal(requestSchema(request), false);
    assert.equal(native.validateTrustedDeviceRemovalRequest(request), false);
  }
  const receipt = { ok: true, trustedDeviceId: 'trusted:2', accountWide: true };
  assert.equal(receiptSchema(receipt), true);
  assert.equal(native.validateTrustedDeviceRemovalReceipt(receipt), true);
  assert.equal(receiptSchema({ ...receipt, accountWide: false }), false);
  assert.equal(native.validateTrustedDeviceRemovalReceipt({ ...receipt, accountWide: false }), false);
  assert.equal(native.validateTrustedDeviceRemovalReceipt({ ...receipt, privateKey: 'must-not-escape' }), false);
});
test('canonical device fixture passes schema and selected-home binding', () => {
  assert.equal(deviceSchema(valid.device), true);
  assert.equal(valid.device.homeId, valid.context.homeId);
  assert.ok(valid.device.controls.length >= 2);
  const unreadableWritable = { ...valid.device, controls: valid.device.controls.map((control) => control.controlId === 'control:power' ? { ...control, readable: false } : control) };
  assert.equal(deviceSchema(unreadableWritable), false, 'writable controls must also be readable');
  const safeUnknown = { ...valid.device, controls: valid.device.controls.map((control) => control.controlId === 'control:power' ? { ...control, interactionKind: 'vendor_future', writable: false, automatable: false, idempotency: 'none', confirmationPolicy: 'none', stepUpPolicy: 'none' } : control) };
  assert.equal(deviceSchema(safeUnknown), true);
  assert.equal(native.validateNativeDevice(safeUnknown), true);
  const unsafeUnknown = { ...safeUnknown, controls: safeUnknown.controls.map((control) => control.controlId === 'control:power' ? { ...control, writable: true } : control) };
  assert.equal(deviceSchema(unsafeUnknown), false);
  assert.equal(native.validateNativeDevice(unsafeUnknown), false);
});
test('customer labels share the 40-Unicode-code-point presentation-only boundary', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/customer-label-unicode-boundaries.json'), 'utf8'));
  assert.equal(fixture.countingUnit, 'unicode_code_points');
  for (const item of fixture.cases) {
    const raw = typeof item.value === 'string' ? item.value : String(item.repeat || '').repeat(Number(item.repeatCount || 0));
    const projected = raw.length === 0 ? null : Array.from(raw).slice(0, fixture.maximumPublicCodePoints).join('');
    const candidate = { ...valid.device, customerLabel: raw };
    assert.equal(Array.from(projected || '').length, item.projectedCodePoints, item.id);
    assert.equal(deviceSchema(candidate), item.wireValid, `schema ${item.id}`);
    assert.equal(native.validateNativeDevice(candidate), item.wireValid, `Platform validator ${item.id}`);
  }
});
test('bounded dinodia.v1 strings use Unicode code points across descriptor and command fields', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/bounded-string-unicode-semantics.json'), 'utf8'));
  const deviceSchemaValidator = deviceSchema;
  const areaSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/area` });
  const baseArea = { id: 'area:living', homeId: valid.device.homeId, originalName: 'Living', overrideName: null, revision: 1, lifecycle: 'active' };
  const baseCommand = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/command-valid.json'), 'utf8'));
  const repeat = (item, count) => item.repeat.repeat(count);
  assert.equal(fixture.lengthUnit, 'unicode_code_points');
  for (const item of [...fixture.boundaryCases, ...fixture.combiningSequenceCases]) {
    const at = repeat(item, item.validRepeatCount);
    const over = repeat(item, item.invalidRepeatCount);
    if (item.field === 'opaqueId') {
      const withId = (id) => ({ ...valid.device, id, controls: valid.device.controls.map((control) => ({ ...control, deviceId: id })) });
      assert.equal(native.validateNativeDevice(withId(at)), true, `${item.id} at limit`);
      assert.equal(native.validateNativeDevice(withId(over)), false, `${item.id} over limit`);
    } else if (item.field === 'areaName') {
      assert.equal(areaSchema({ ...baseArea, originalName: at }), true, `${item.id} schema at limit`);
      assert.equal(native.validateNativeArea({ ...baseArea, originalName: at }), true, `${item.id} runtime at limit`);
      assert.equal(areaSchema({ ...baseArea, originalName: over }), false, `${item.id} schema over limit`);
      assert.equal(native.validateNativeArea({ ...baseArea, originalName: over }), false, `${item.id} runtime over limit`);
    } else if (item.field === 'controlLabel') {
      const candidate = { ...valid.device, controls: valid.device.controls.map((control, index) => index ? control : { ...control, label: at }) };
      const invalid = { ...candidate, controls: candidate.controls.map((control, index) => index ? control : { ...control, label: over }) };
      assert.equal(deviceSchemaValidator(candidate), true, `${item.id} schema at limit`);
      assert.equal(native.validateNativeDevice(candidate), true, `${item.id} runtime at limit`);
      assert.equal(deviceSchemaValidator(invalid), false, `${item.id} schema over limit`);
      assert.equal(native.validateNativeDevice(invalid), false, `${item.id} runtime over limit`);
    } else if (item.field === 'constraintUnit' || item.field === 'optionLabel') {
      const controlsFor = (value) => [{ ...valid.device.controls[0], valueType: 'option', interactionKind: 'picker', constraints: { unit: item.field === 'constraintUnit' ? value : 'mode', options: [{ value: 'on', label: item.field === 'optionLabel' ? value : 'On' }] } }];
      assert.equal(native.validateNativeDevice({ ...valid.device, controls: controlsFor(at) }), true, `${item.id} runtime at limit`);
      assert.equal(native.validateNativeDevice({ ...valid.device, controls: controlsFor(over) }), false, `${item.id} runtime over limit`);
    } else if (item.field === 'textCommand' || item.field === 'idempotencyKey') {
      const control = { ...valid.device.controls[0], valueType: item.field === 'textCommand' ? 'text' : 'boolean', interactionKind: item.field === 'textCommand' ? 'text_input' : 'toggle' };
      const candidate = { ...valid.device, controls: [control] };
      const command = { ...baseCommand, homeId: candidate.homeId, deviceId: candidate.id, controlId: control.controlId, descriptorRevision: candidate.descriptorRevision, value: item.field === 'textCommand' ? at : true, idempotencyKey: item.field === 'idempotencyKey' ? at : baseCommand.idempotencyKey };
      const invalid = { ...command, value: item.field === 'textCommand' ? over : true, idempotencyKey: item.field === 'idempotencyKey' ? over : baseCommand.idempotencyKey };
      assert.equal(native.validateCommandAgainstDevice(command, candidate, control, baseCommand.homeMembershipId), true, `${item.id} runtime at limit`);
      assert.equal(native.validateCommandAgainstDevice(invalid, candidate, control, baseCommand.homeMembershipId), false, `${item.id} runtime over limit`);
      if (item.invalidMinimumRepeatCount) {
        assert.equal(native.validateCommandAgainstDevice({ ...command, idempotencyKey: repeat(item, item.invalidMinimumRepeatCount) }, candidate, control, baseCommand.homeMembershipId), false, `${item.id} below minimum`);
      }
    }
  }
});
test('Platform runtime consumes shared negative Area, state, and descriptor fixtures', () => {
  const negativeArea = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/area-negative-revision.json'), 'utf8'));
  const areaValidator = ajv.compile({ $ref: `${contract.$id}#/$defs/area` });
  assert.equal(areaValidator(negativeArea), false);
  assert.equal(native.validateNativeArea(negativeArea), false);

  const invalidState = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/control-state-boolean-string.json'), 'utf8')).data;
  const booleanControl = valid.device.controls.find((control) => control.valueType === 'boolean');
  assert.equal(native.validateControlState(invalidState, valid.device, booleanControl), false);

  const optionState = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/control-state-option-outside-descriptor.json'), 'utf8'));
  const optionDevice = optionState.device;
  const optionControl = optionDevice.controls.find((control) => control.controlId === optionState.state.controlId);
  const stateSchema = ajv.compile({ $ref: `${contract.$id}#/$defs/controlState` });
  assert.equal(deviceSchema(optionDevice), true, JSON.stringify(deviceSchema.errors));
  assert.equal(stateSchema(optionState.validState), true, JSON.stringify(stateSchema.errors));
  assert.equal(stateSchema(optionState.state), true, JSON.stringify(stateSchema.errors));
  assert.equal(native.validateControlState(optionState.validState, optionDevice, optionControl), true);
  assert.equal(native.validateControlState(optionState.state, optionDevice, optionControl), false,
    'option-valued state must be one of the current descriptor options');

  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/writable-unreadable-control.json'), 'utf8'));
  const sourceFixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', mutation.sourceFixture.replace(/^fixtures\//, '')), 'utf8'));
  const unreadable = structuredClone(sourceFixture.device);
  Object.assign(unreadable.controls.find((control) => control.controlId === mutation.mutation.controlId), mutation.mutation);
  assert.equal(native.validateNativeDevice(unreadable), false);
  assert.equal(deviceSchema(unreadable), false);
});
test('account session fixture is multi-home, active, and rejects stale or mismatched memberships', () => {
  const value = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/account-session-two-homes.json'), 'utf8'));
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/accountSessionContext` });
  assert.equal(schema(value), true, JSON.stringify(schema.errors));
  assert.equal(native.validateAccountSessionContext(value, Date.parse('2029-01-01T00:00:00Z')), true);
  assert.equal(native.validateAccountSessionContext({ ...value, sessionId: undefined }, Date.parse('2029-01-01T00:00:00Z')), false, 'restoration must include the current opaque session context for operation-bound step-up');
  assert.equal(native.validateAccountSessionContext({ ...value, trustedDeviceId: undefined }, Date.parse('2029-01-01T00:00:00Z')), false, 'restoration must include the current trusted installation context');
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
  assert.equal(native.validateCustomerHubSession(syntheticHubSession, expected, now), true, 'fresh authenticated current/next LAN pins are an optional customer transport candidate');
  const lan = syntheticHubSession.hubEndpoint.lan;
  for (const invalidLan of [
    { ...lan, origin: 'https://192.168.1.20:8123' },
    { ...lan, publicHubId: 'a'.repeat(19) },
    { ...lan, currentSpkiPin: 'sha256/not-a-pin' },
    { ...lan, validUntil: '2026-09-27T10:08:00Z' },
    { ...lan, nextCertificateGeneration: 1 },
    { ...lan, nextSpkiPin: lan.currentSpkiPin },
  ]) assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, hubEndpoint: { ...syntheticHubSession.hubEndpoint, lan: invalidLan } }, expected, now), false);
  assert.equal(native.validateCustomerHubSession({ ...syntheticHubSession, hubEndpoint: { state: 'unavailable', lan: { ...lan, reportedAt: '2026-09-27T09:52:59Z', validUntil: '2026-09-27T09:59:59Z' } } }, expected, now), false, 'stale LAN pin report is not a customer endpoint');
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
test('hub heartbeat is online through the inclusive 420-second boundary and offline immediately after', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/hub-heartbeat-freshness.json'), 'utf8'));
  const now = Date.parse(fixture.now);
  assert.equal(fixture.heartbeatCadenceSeconds, 120);
  assert.equal(fixture.onlineThroughSeconds, contract.wireRules.freshness.onlineThroughSeconds);
  for (const scenario of fixture.cases) {
    assert.equal(
      native.effectiveHubOnlineState(scenario.lastHeartbeatAt, now),
      scenario.expected,
      `Hub freshness mismatch for ${scenario.id}`,
    );
  }
});
test('canonical signed LAN endpoint contract keeps private installer routing out of customer DTOs', () => {
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/lanEndpointObservation` });
  const current = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/lan-endpoint-current.json'), 'utf8'));
  const unavailable = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/lan-endpoint-unavailable.json'), 'utf8'));
  const publicAddress = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/lan-endpoint-public-address.json'), 'utf8'));
  const extraAuthority = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/lan-endpoint-extra-authority-field.json'), 'utf8'));
  assert.equal(schema(current), true, JSON.stringify(schema.errors));
  const setupHttp = { ...current, baseUrl: 'http://192.168.0.110:80' };
  assert.equal(schema(setupHttp), true, JSON.stringify(schema.errors));
  assert.equal(schema(unavailable), true, JSON.stringify(schema.errors));
  assert.equal(schema(publicAddress), false);
  assert.equal(schema(extraAuthority), false);
  assert.equal(native.validateLanEndpointObservation(current, 'din-home-001'), true);
  assert.equal(native.validateLanEndpointObservation(setupHttp, 'din-home-001'), true);
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
test('machine-authenticated LAN TLS identity report is immutable, versioned and pin-bounded', () => {
  const report = {
    version: 1, revision: 2, state: 'CURRENT', publicHubId: '0123456789abcdef0123', host: 'dinodia-0123456789abcdef0123.local', port: 8123,
    certificateGeneration: 1, currentSpkiPin: 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', currentNotBefore: '2026-09-27T09:00:00Z', currentNotAfter: '2028-09-26T09:00:00Z',
    nextCertificateGeneration: 2, nextSpkiPin: 'sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', nextNotBefore: '2026-09-27T09:30:00Z', nextNotAfter: '2028-09-26T09:30:00Z', acknowledgedGeneration: 0,
  };
  const schema = ajv.compile({ $ref: `${contract.$id}#/$defs/lanTlsIdentityObservation` });
  assert.equal(schema(report), true, JSON.stringify(schema.errors));
  assert.equal(native.validateLanTlsIdentityObservation(report), true);
  const invalidReports = [
    { ...report, publicHubId: 'different-public-id' },
    { ...report, host: 'dinodia-other.local' },
    { ...report, port: 8124 },
    { ...report, revision: 0 },
    { ...report, currentSpkiPin: 'sha256/invalid' },
    { ...report, nextCertificateGeneration: 1 },
    { ...report, nextSpkiPin: report.currentSpkiPin },
    { ...report, nextNotAfter: '2026-01-01T00:00:00Z' },
    { ...report, privateKey: 'must-not-be-published' },
  ];
  for (const invalid of invalidReports) {
    assert.equal(native.validateLanTlsIdentityObservation(invalid), false);
  }
  for (const invalid of [...invalidReports.slice(0, 6), invalidReports.at(-1)]) assert.equal(schema(invalid), false);
  assert.equal(schema(invalidReports[6]), true, 'JSON Schema cannot compare the current and next SPKI values; the owning runtime validator rejects equality');
  assert.equal(schema(invalidReports[7]), true, 'JSON Schema cannot order two timestamp fields; the owning runtime validator rejects reversed validity');
  const openapi = fs.readFileSync(path.join(root, 'openapi.yaml'), 'utf8');
  assert.match(openapi, /HubLanTlsIdentityObservation:\s*\n\s+\$ref: "\.\/contract\.json#\/\$defs\/lanTlsIdentityObservation"/);
});
test('customer LAN projection is bound to the current active manufacturing generation', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  const identity = {
    manufacturingIdentityGeneration: 7, manufacturingIdentityStatus: 'ACTIVE',
    baseUrl: 'http://192.168.1.76:8123', lanEndpointState: 'CURRENT', lanEndpointReportedAt: new Date(now.getTime() - 1000), lanEndpointIdentityGeneration: 7,
    publicHubId: '0123456789abcdef0123', lanTlsReportedAt: new Date(now.getTime() - 1000), lanTlsState: 'CURRENT',
    lanTlsIdentityGeneration: 7, lanTlsCertificateGeneration: 2,
    lanTlsCurrentSpkiPin: 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    lanTlsCurrentNotBefore: new Date('2026-10-01T00:00:00Z'), lanTlsCurrentNotAfter: new Date('2027-10-01T00:00:00Z'),
    lanTlsNextCertificateGeneration: null, lanTlsNextSpkiPin: null, lanTlsNextNotBefore: null, lanTlsNextNotAfter: null,
  };
  const projected = lanEndpointModule.exports.verifiedCustomerLanEndpoint(identity, now);
  assert.equal(projected?.origin, 'https://dinodia-0123456789abcdef0123.local:8123');
  assert.equal(lanEndpointModule.exports.verifiedCustomerClaimLanAddress(identity, now), '192.168.1.76');
  assert.equal(lanEndpointModule.exports.verifiedCustomerClaimLanAddress({ ...identity, lanEndpointIdentityGeneration: 6 }, now), undefined, 'old manufacturing generation cannot supply the connection address');
  assert.equal(lanEndpointModule.exports.verifiedCustomerClaimLanAddress({ ...identity, lanEndpointReportedAt: new Date(now.getTime() - 420_001) }, now), undefined, 'stale signed endpoint cannot supply the address');
  assert.equal(lanEndpointModule.exports.verifiedCustomerClaimLanAddress({ ...identity, baseUrl: 'http://8.8.8.8:8123' }, now), undefined, 'public addresses are never projected');
  assert.equal(lanEndpointModule.exports.verifiedCustomerLanEndpoint({ ...identity, manufacturingIdentityGeneration: 8 }, now), undefined, 'old TLS report is not authority after manufacturing rotation');
  assert.equal(lanEndpointModule.exports.verifiedCustomerLanEndpoint({ ...identity, manufacturingIdentityStatus: 'REVOKED' }, now), undefined);
  assert.equal(lanEndpointModule.exports.verifiedCustomerLanEndpoint({ ...identity, lanTlsReportedAt: new Date(now.getTime() - 420_001) }, now), undefined);
});
test('command validation enforces descriptor type, range, step and exact step-up reference', () => {
  const brightness = valid.device.controls.find((control) => control.controlId === 'control:brightness');
  const lock = valid.device.controls.find((control) => control.controlId === 'control:lock');
  const command = (control, value, extra = {}) => ({ commandId: 'command:test', homeId: valid.device.homeId, homeMembershipId: valid.context.homeMembershipId, deviceId: valid.device.id, controlId: control.controlId, descriptorRevision: valid.device.descriptorRevision, value, issuedAt: '2026-09-27T10:00:00Z', idempotencyKey: 'idempotency-key-0001', ...extra });
  assert.equal(native.validateCommandAgainstDevice(command(brightness, 25), valid.device, brightness, valid.context.homeMembershipId), true);
  for (const badValue of [100000, -1, 2.5, '50', NaN]) assert.equal(native.validateCommandAgainstDevice(command(brightness, badValue), valid.device, brightness, valid.context.homeMembershipId), false);
  assert.equal(native.validateCommandAgainstDevice(command(lock, true), valid.device, lock, valid.context.homeMembershipId), false);
  assert.equal(native.validateCommandAgainstDevice(command(lock, true, { stepUpOperationId: 'step-up:one-use' }), valid.device, lock, valid.context.homeMembershipId), true);
  assert.equal(native.validateCommandAgainstDevice(command(brightness, 25), { ...valid.device, lifecycle: 'retired' }, brightness, valid.context.homeMembershipId), false);
  assert.equal(native.validateCommandAgainstDevice(command(brightness, 25), { ...valid.device, lifecycle: 'view_only' }, brightness, valid.context.homeMembershipId), false);
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
  assert.equal(areaSchema({ id: 'area:a', homeId: 'home:a', originalName: 'Kitchen', overrideName: null, revision: -1, lifecycle: 'active' }), false);
  assert.equal(native.validateNativeArea({ id: 'area:a', homeId: 'home:a', originalName: 'Kitchen', overrideName: null, revision: -1, lifecycle: 'active' }), false);
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
  assert.equal(native.validateControlState({ ...state, value: 'true' }, valid.device, control), false, 'a string value is not boolean state');
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
test('updater maintenance status is bounded and never exposes signing or artifact authority', () => {
  const validate = ajv.compile({ $ref: `${contract.$id}#/$defs/updaterMaintenanceStatus` });
  const good = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/updater-maintenance-status-unprovisioned.json'), 'utf8'));
  const bad = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/updater-maintenance-status-exposes-authority.json'), 'utf8'));
  assert.equal(validate(good), true, JSON.stringify(validate.errors));
  assert.equal(validate(bad), false);
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
