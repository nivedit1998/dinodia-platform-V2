import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('foundation and Stage 1 schema is exactly native and bounded', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  assert.equal([...schema.matchAll(/^model\s+/gm)].length, 44);
  assert.doesNotMatch(schema, /HaConnection|HomeAssistant|SupportRequest|NativeAutomation|AlexaRefreshToken/);
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
