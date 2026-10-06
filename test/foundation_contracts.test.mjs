import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { safeBuildId } from '../src/lib/buildIdentity.mjs';

function loadFoundationRuntime() {
  const compiled = ts.transpileModule(fs.readFileSync('src/lib/foundation.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === './runtimeTarget.mjs') return { runtimeTargetIsValid: () => true };
    if (specifier === './buildIdentity.mjs') return { safeBuildId: () => 'test-build' };
    throw new Error(`Unexpected foundation dependency: ${specifier}`);
  };
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

function loadDinodiaContractRuntime() {
  const compiled = ts.transpileModule(fs.readFileSync('src/lib/contracts/dinodiaV1.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (specifier === 'node:crypto') return { createHash };
    throw new Error(`Unexpected contract dependency: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

test('pending relationship projection enforces exact per-kind actions, bounded fields and server time', () => {
  const { validateCustomerPendingRelationshipsProjection: validate } = loadDinodiaContractRuntime();
  const asOf = '2026-10-05T12:00:00.000Z';
  const common = { id: 'pending-1', postcode: 'N1 1AA', createdAt: '2026-10-05T11:00:00.000Z', expiresAt: '2026-10-12T12:00:00.000Z', state: 'PENDING' };
  const rows = [
    { ...common, type: 'INVITATION', role: 'TENANT', inviterLabel: 'Home owner', decisionRevision: '2026-10-05T11:30:00.000Z', allowedActions: ['ACCEPT', 'DECLINE'] },
    { ...common, id: 'pending-2', type: 'ROOM_ACCESS_REQUEST', areaLabel: 'Living Room', decisionRevision: '2026-10-05T11:30:00.000Z', allowedActions: ['VIEW_STATUS', 'CANCEL'] },
    { ...common, id: 'pending-3', type: 'HOME_SETUP', revision: 3, requiredStep: 'PROFILE', allowedActions: ['RESUME_SETUP'] },
    { ...common, id: 'pending-4', type: 'INSTALLATION_PENDING', revision: 7, requiredStep: 'AREA_SYNC', allowedActions: ['VIEW_STATUS', 'REFRESH'] },
  ];
  const projection = { schemaVersion: 'dinodia.v1', asOf, pendingRelationships: rows };
  assert.equal(validate(projection, Date.parse(asOf)), true);
  assert.equal(validate({ ...projection, pendingRelationships: [{ ...rows[0], allowedActions: ['ACCEPT', 'DECLINE', 'OPEN_HOME'] }] }, Date.parse(asOf)), false);
  assert.equal(validate({ ...projection, pendingRelationships: [{ ...rows[0], homeId: 'unselected-home' }] }, Date.parse(asOf)), false);
  assert.equal(validate({ ...projection, pendingRelationships: [{ ...rows[1], streetAddress: 'private' }] }, Date.parse(asOf)), false);
  assert.equal(validate({ ...projection, pendingRelationships: [{ ...rows[0], id: 'same' }, { ...rows[1], id: 'same' }] }, Date.parse(asOf)), false);
  assert.equal(validate({ ...projection, asOf: '2026-02-30T12:00:00Z' }, Date.parse(asOf)), false);
  assert.equal(validate({ ...projection, pendingRelationships: [{ ...rows[0], expiresAt: '2026-10-05T11:59:00.000Z' }] }, Date.parse(asOf)), false);
  const preAddressClaim = { schemaVersion: 'dinodia.v1', asOf, pendingRelationships: [{ id: 'pending-claim', type: 'HOME_SETUP', postcode: null, createdAt: '2026-10-05T11:00:00.000Z', expiresAt: '2026-10-05T12:30:00.000Z', state: 'PROFILE_REQUIRED', revision: 0, requiredStep: 'PROFILE', allowedActions: ['RESUME_SETUP'] }] };
  assert.equal(validate(preAddressClaim, Date.parse(asOf)), true, 'an initial claim before address entry has no fabricated postcode');
  const {
    validateCustomerHomeClaimResolveRequest: validateClaimResolve,
    validateCustomerHomeClaimSetupRequest: validateClaimSetup,
    validateCustomerHomeClaimCompleteRequest: validateClaimComplete,
  } = loadDinodiaContractRuntime();
  assert.equal(validateClaimResolve({ reference: `dno_home_${'a'.repeat(43)}` }), true);
  assert.equal(validateClaimResolve({ reference: `dno_home_${'a'.repeat(43)}`, homeId: 'caller-selected' }), false);
  assert.equal(validateClaimSetup({ expectedRevision: 1, step: 'ADDRESS', mutation: { addressLine1: '1 Lane', addressLine2: '', city: 'London', region: '', postcode: 'N1 1AA', country: 'GB', timezone: 'Europe/London' } }), true);
  assert.equal(validateClaimSetup({ expectedRevision: 1, step: 'POLICY', mutation: { policyVersion: 'current', homeId: 'attacker-selected' } }), false);
  assert.equal(validateClaimComplete({ expectedRevision: 2, idempotencyKey: 'claim-complete-1234567890' }), true);
  assert.equal(validateClaimComplete({ expectedRevision: 2, idempotencyKey: 'short' }), false);
  const { validateCustomerInvitationDecisionRequest: validateDecisionRequest, validateCustomerInvitationDecisionReceipt: validateDecisionReceipt } = loadDinodiaContractRuntime();
  assert.equal(validateDecisionRequest({ decision: 'ACCEPT', expectedUpdatedAt: '2026-10-05T11:30:00.000Z' }), true);
  assert.equal(validateDecisionRequest({ decision: 'ACCEPT', expectedUpdatedAt: '2026-10-05T11:30:00.000Z', homeId: 'caller-authority' }), false);
  assert.equal(validateDecisionReceipt({ schemaVersion: 'dinodia.v1', ok: true, invitationId: 'invite-1', decision: 'ACCEPT', state: 'ACCEPTED', homeMembershipId: 'membership-1', idempotentReplay: false }, 'invite-1'), true);
  assert.equal(validateDecisionReceipt({ schemaVersion: 'dinodia.v1', ok: true, invitationId: 'invite-1', decision: 'DECLINE', state: 'ACCEPTED', homeMembershipId: 'membership-1', idempotentReplay: false }, 'invite-1'), false);
});

test('safe build identity prefers the real Vercel commit or deployment and never reports a stale pin', () => {
  assert.equal(safeBuildId({
    VERCEL_GIT_COMMIT_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
    VERCEL_DEPLOYMENT_ID: 'dpl_Production123',
    FOUNDATION_SOURCE_FINGERPRINT: '453997b5cf659f6b',
  }), 'abcdef012345');
  assert.equal(safeBuildId({
    VERCEL_DEPLOYMENT_ID: 'dpl_Production123',
    FOUNDATION_SOURCE_FINGERPRINT: '453997b5cf659f6b',
  }), 'dpl_Production123');
  assert.equal(safeBuildId({
    VERCEL: '1',
    FOUNDATION_SOURCE_FINGERPRINT: '453997b5cf659f6b',
  }), 'vercel-deployment-id-unavailable');
  assert.equal(safeBuildId({ FOUNDATION_SOURCE_FINGERPRINT: 'abcdef0123456789' }), 'abcdef0123456789');
  assert.equal(safeBuildId({ FOUNDATION_SOURCE_FINGERPRINT: 'not-a-fingerprint' }), 'local');
});

test('readiness accepts the exact Stage 3 head plus only reviewed additive Stage 4, Stage 5 and Stage 6 migrations', () => {
  const { REQUIRED_MIGRATION, REQUIRED_MODEL_COUNT, COMPATIBLE_ADDITIVE_MIGRATIONS, isSchemaReady } = loadFoundationRuntime();
  const stage3Checksum = 'b'.repeat(64);
  const stage3 = [{ migration_name: REQUIRED_MIGRATION, checksum: stage3Checksum }];
  const migration = (name) => ({ migration_name: name, checksum: COMPATIBLE_ADDITIVE_MIGRATIONS[name] });
  const stage4 = [migration('20261004050000_stage4_customer_lan_tls_identity'), ...stage3];
  const stage5 = [migration('20261005100000_stage5_incident_source_kind'), migration('20261005070000_stage5_hub_incident_deadline'), migration('20261004150000_stage5_hub_sync_v2'), ...stage4];
  const ownershipTransfer = migration('20261006150000_stage6_ownership_transfer_claim');
  const prospectiveRoomAccess = migration('20261006170000_stage6_prospective_room_access');
  const invitedTenantUsername = migration('20261006120000_stage6_invited_tenant_username_setup');
  const apnsRegistration = migration('20261006100000_stage6_apns_registration_and_notification_preferences');
  const mobileAccess = migration('20261005130000_stage6_mobile_access_credentials');
  const refreshFamilies = migration('20261005120000_stage6_customer_refresh_families');
  const stage6 = [prospectiveRoomAccess, ownershipTransfer, invitedTenantUsername, apnsRegistration, mobileAccess, refreshFamilies, ...stage5];
  assert.equal(isSchemaReady(stage3, REQUIRED_MODEL_COUNT, stage3Checksum), true);
  assert.equal(isSchemaReady(stage4, REQUIRED_MODEL_COUNT, stage3Checksum), true, 'the app rollback remains ready after the additive migration');
  assert.equal(isSchemaReady(stage5, REQUIRED_MODEL_COUNT + 1, stage3Checksum), true, 'the Stage 5 app and Stage 4 rollback remain ready on the additive Stage 5 schema');
  assert.equal(isSchemaReady(stage6, REQUIRED_MODEL_COUNT + 2, stage3Checksum), true, 'the Stage 6 app and compatible rollback remain ready on all reviewed additive Stage 6 schema');
  assert.equal(isSchemaReady([ownershipTransfer, ...stage5], REQUIRED_MODEL_COUNT + 1, stage3Checksum), true, 'ownership transfer adds nullable data and remains compatible with the prior Stage 5 app');
  assert.equal(isSchemaReady([invitedTenantUsername, ...stage5], REQUIRED_MODEL_COUNT + 1, stage3Checksum), true, 'the invited-tenant username migration remains compatible with the prior Stage 5 app');
  assert.equal(isSchemaReady([apnsRegistration, ...stage5], REQUIRED_MODEL_COUNT + 1, stage3Checksum), false, 'APNs registration requires the mobile access and refresh-family migrations');
  assert.equal(isSchemaReady([{ ...stage6[0], checksum: '0'.repeat(64) }, ...stage6.slice(1)], REQUIRED_MODEL_COUNT + 2, stage3Checksum), false, 'an unreviewed Stage 6 migration checksum is not schema-ready');
  assert.equal(isSchemaReady([{ ...stage5[0], checksum: '0'.repeat(64) }, ...stage5.slice(1)], REQUIRED_MODEL_COUNT + 1, stage3Checksum), false, 'an unreviewed Stage 5 follow-on checksum is not schema-ready');
  assert.equal(isSchemaReady([stage5[0], stage5[1], stage5[2], ...stage3], REQUIRED_MODEL_COUNT + 1, stage3Checksum), false, 'Stage 5 cannot be accepted without its Stage 4 prerequisite');
  assert.equal(isSchemaReady([{ migration_name: 'unreviewed_migration', checksum: 'c'.repeat(64) }, ...stage4], REQUIRED_MODEL_COUNT, stage3Checksum), false);
  assert.equal(isSchemaReady([{ ...stage4[0], checksum: '0'.repeat(64) }, ...stage3], REQUIRED_MODEL_COUNT, stage3Checksum), false);
  assert.equal(isSchemaReady([{ ...stage5[2], checksum: '0'.repeat(64) }, ...stage5.slice(3)], REQUIRED_MODEL_COUNT + 1, stage3Checksum), false);
  assert.equal(isSchemaReady(stage4, REQUIRED_MODEL_COUNT + 1, stage3Checksum), false);
  assert.equal(isSchemaReady(stage5, REQUIRED_MODEL_COUNT, stage3Checksum), false);
  assert.equal(isSchemaReady(stage6, REQUIRED_MODEL_COUNT + 1, stage3Checksum), false, 'the prospective Room attempt table is included in the Stage 6 migration/table-count contract');
  assert.equal(isSchemaReady(stage4, REQUIRED_MODEL_COUNT, '0'.repeat(64)), false);
});

test('foundation and Stage 1 schema is exactly native and bounded', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const modelNames = [...schema.matchAll(/^model\s+(\w+)/gm)].map((match) => match[1]);
  const stage3Models = [
    'AreaSourceAlias', 'NativeDeviceSourceAlias', 'PermanentDeviceInstallationRequest', 'NativeCommissioningSession',
    'NativeDeviceUsageBucket', 'NativeTemperatureSample', 'NativeAutomation', 'NativeAutomationTrigger',
    'NativeAutomationAction', 'NativeAutomationExecution', 'AlexaNativeLink', 'AlexaNativeHomeScope',
    'AlexaNativeEndpointProjection', 'AlexaNativeDirectiveReceipt', 'NativeBackgroundTaskState',
    'NativeDomainOutbox', 'NativeNotificationDeliveryReceipt', 'NativeDeviceOutageIncident',
    'NativeSupportTicketTimeline', 'ExceptionalOwnershipTransfer', 'NativeTenantDeviceRecovery',
  ];
  assert.equal(modelNames.length, 67);
  assert.equal(modelNames.filter((name) => name === 'HubSyncReceipt').length, 1);
  assert.deepEqual(modelNames.filter((name) => stage3Models.includes(name)).sort(), [...stage3Models].sort());
  assert.equal(modelNames.length - stage3Models.length, 46, 'Stage 1/foundation, Stage 5 receipt and Stage 6 private Room verification tables remain intact; Stage 3 is additive');
  assert.doesNotMatch(schema, /HaConnection|HomeAssistant|SupportRequest|AlexaRefreshToken/);
  assert.match(schema, /model HomeMembership/);
  assert.match(schema, /model TenantAreaGrant/);
  assert.match(schema, /model NativeDevice/);
  assert.doesNotMatch(schema, /currentAreaId/);
  assert.match(schema, /model DeviceAreaAssignment/);
  assert.match(schema, /model EmployeeSession/);
  assert.match(schema, /model SupportAccessRequest/);
  assert.match(schema, /model CloudUrlVerification/);
  assert.match(schema, /model AuthRateLimitBucket/);
  assert.match(schema, /model InitialCxoBootstrap/);
  assert.match(schema, /model SupportAccessNotification/);
});

test('foundation HTTP surfaces are the only compiled application routes', () => {
  assert.equal(fs.existsSync('src/app/api/health/route.ts'), true);
  assert.equal(fs.existsSync('src/app/api/readiness/route.ts'), true);
  assert.equal(fs.existsSync('src/app/api/auth/login/route.ts'), false);
  assert.equal(fs.existsSync('src/app/api/homeassistant/state-change/route.ts'), false);
});

test('foundation source contains the reviewed integrity and generation guards', () => {
  const migration = fs.readFileSync('prisma/migrations/00000000000000_native_v2_lean_foundation/migration.sql', 'utf8');
  const stage1 = fs.readFileSync('prisma/migrations/20260922000000_stage1_security_authorities/migration.sql', 'utf8');
  for (const marker of [
    'TenantAreaGrant_membership_home_fkey',
    'NativeDevice_owner_home_fkey',
    'DeviceAreaAssignment_device_home_fkey',
    'MembershipInvitation_pending_target_unique',
    'AreaAccessRequest_pending_requester_area_unique',
    'HubManufacturingIdentity_active_serial_unique',
    'StepUpAuthorization_scope_guard',
  ]) assert.match(migration, new RegExp(marker));
  for (const marker of ['EmployeeSession', 'OperatorHandoff', 'StepUpChallenge', 'SupportTicket', 'SupportAccessRequest', 'SupportSession', 'OfflineMembershipAuthorisation', 'CloudUrlVerification']) assert.match(stage1, new RegExp(`CREATE TABLE "${marker}"`));
});
