import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
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

test('readiness accepts the exact Stage 3 head plus only reviewed additive Stage 4 and Stage 5 migrations', () => {
  const { REQUIRED_MIGRATION, REQUIRED_MODEL_COUNT, COMPATIBLE_ADDITIVE_MIGRATIONS, isSchemaReady } = loadFoundationRuntime();
  const stage3Checksum = 'b'.repeat(64);
  const stage3 = [{ migration_name: REQUIRED_MIGRATION, checksum: stage3Checksum }];
  const migration = (name) => ({ migration_name: name, checksum: COMPATIBLE_ADDITIVE_MIGRATIONS[name] });
  const stage4 = [migration('20261004050000_stage4_customer_lan_tls_identity'), ...stage3];
  const stage5 = [migration('20261005070000_stage5_hub_incident_deadline'), migration('20261004150000_stage5_hub_sync_v2'), ...stage4];
  assert.equal(isSchemaReady(stage3, REQUIRED_MODEL_COUNT, stage3Checksum), true);
  assert.equal(isSchemaReady(stage4, REQUIRED_MODEL_COUNT, stage3Checksum), true, 'the app rollback remains ready after the additive migration');
  assert.equal(isSchemaReady(stage5, REQUIRED_MODEL_COUNT + 1, stage3Checksum), true, 'the Stage 5 app and Stage 4 rollback remain ready on the additive Stage 5 schema');
  assert.equal(isSchemaReady([{ ...stage5[0], checksum: '0'.repeat(64) }, ...stage5.slice(1)], REQUIRED_MODEL_COUNT + 1, stage3Checksum), false, 'an unreviewed Stage 5 follow-on checksum is not schema-ready');
  assert.equal(isSchemaReady([stage5[0], ...stage3], REQUIRED_MODEL_COUNT + 1, stage3Checksum), false, 'Stage 5 cannot be accepted without its Stage 4 prerequisite');
  assert.equal(isSchemaReady([{ migration_name: 'unreviewed_migration', checksum: 'c'.repeat(64) }, ...stage4], REQUIRED_MODEL_COUNT, stage3Checksum), false);
  assert.equal(isSchemaReady([{ ...stage4[0], checksum: '0'.repeat(64) }, ...stage3], REQUIRED_MODEL_COUNT, stage3Checksum), false);
  assert.equal(isSchemaReady([{ ...stage5[1], checksum: '0'.repeat(64) }, ...stage5.slice(2)], REQUIRED_MODEL_COUNT + 1, stage3Checksum), false);
  assert.equal(isSchemaReady(stage4, REQUIRED_MODEL_COUNT + 1, stage3Checksum), false);
  assert.equal(isSchemaReady(stage5, REQUIRED_MODEL_COUNT, stage3Checksum), false);
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
  assert.equal(modelNames.length, 66);
  assert.equal(modelNames.filter((name) => name === 'HubSyncReceipt').length, 1);
  assert.deepEqual(modelNames.filter((name) => stage3Models.includes(name)).sort(), [...stage3Models].sort());
  assert.equal(modelNames.length - stage3Models.length, 45, 'Stage 1/foundation and Stage 5 receipt tables remain intact; Stage 3 is additive');
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
