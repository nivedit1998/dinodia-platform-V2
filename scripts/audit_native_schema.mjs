import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const schemaPath = path.join(root, 'prisma/schema.prisma');
const migrationPath = path.join(root, 'prisma/migrations/20261003000000_native_v2_stage3_domain_schema/migration.sql');
const classificationPath = path.join(root, 'docs/native-schema-classification.md');
const schema = fs.readFileSync(schemaPath, 'utf8');
const migration = fs.readFileSync(migrationPath, 'utf8');
const classification = fs.readFileSync(classificationPath, 'utf8');
const models = [...schema.matchAll(/^model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{/gm)].map((match) => match[1]);
const modelSet = new Set(models);
const rows = [...classification.matchAll(/^\|\s*([A-Za-z][A-Za-z0-9_]*)\s*\|\s*(Reuse unchanged|Evolve|Add native)\s*\|\s*$/gm)];
const classified = rows.map((match) => match[1]);
const duplicateClassifications = classified.filter((name, index) => classified.indexOf(name) !== index);
const missing = [...modelSet].filter((name) => !classified.includes(name));
const stale = classified.filter((name) => !modelSet.has(name));
const added = classified.filter((name, index) => rows[index][2] === 'Add native');
const addedDetail = [...classification.matchAll(/^\|\s*([A-Za-z][A-Za-z0-9_]*)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$/gm)]
  .map((match) => ({ name: match[1], cells: match.slice(2).map((cell) => cell.trim()) }));
const missingAddedMetadata = added.filter((name) => {
  const detail = addedDetail.find((item) => item.name === name)?.cells ?? [];
  return detail.length !== 3 || detail.some((cell) => cell.length < 24 || /\b(?:TBC|TBD|decide later)\b/i.test(cell));
});
const forbiddenNames = /\b(?:HaConnection|HaEntity|HaDevice|HaAutomation|haConnectionId|haEntityId|oldUserId|ownerUserId)\b/i;
const destructiveSql = /\b(?:DROP\s+TABLE|DROP\s+COLUMN|DROP\s+TYPE|DROP\s+CONSTRAINT|TRUNCATE|DROP\s+SCHEMA)\b/i;
const droppedIndexes = [...migration.matchAll(/DROP\s+INDEX\s+(?:IF EXISTS\s+)?"([^"]+)"/gi)].map((match) => match[1]);
const expectedTaskSeeds = ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry', 'expired_dispatch_lease_cleanup'];
const seededTasks = [...migration.matchAll(/\('([a-z_]+)',\s*'(OPERATIONS|MAINTENANCE)'/g)].map((match) => match[1]);
const requiredGuards = [
  'Home_single_active_owner_guard', 'HomeMembership_tenant_device_decommission_guard',
  'NativeDevice_tenant_owner_guard', 'Home_active_hub_pointer_guard',
  'TenantAreaGrant_membership_home_stage3_fkey', 'TenantAreaGrant_area_home_stage3_fkey',
  'NativeDevice_hub_home_stage3_fkey', 'MembershipInvitationArea_area_home_stage3_fkey',
  'AreaAccessRequest_qr_area_stage3_fkey', 'HomeClaimChallenge_reference_hub_guard',
  'PendingHomeSetup_reservation_binding_guard',
  'SupportRequest_ticket_home_stage3_fkey', 'SupportRequest_hub_home_stage3_fkey',
  'SupportRequest_target_membership_home_stage3_fkey', 'SupportRequest_approver_membership_home_stage3_fkey',
  'SupportSession_request_home_stage3_fkey', 'SupportSession_ticket_home_stage3_fkey',
  'SupportSession_hub_home_stage3_fkey', 'SupportSession_target_membership_home_stage3_fkey',
  'SupportNotification_ticket_home_stage3_fkey', 'SupportNotification_request_home_stage3_fkey',
  'SupportNotification_session_home_stage3_fkey',
  'NativeTask_fixed_registry_check', 'NativeTask_lease_pair_check',
  'NativeOutage_exactly_one_source_check', 'AlexaNativeEndpoint_tenant_scope_guard',
];
const missingGuards = requiredGuards.filter((guard) => !migration.includes(guard));
const errors = [];
if (modelSet.size !== models.length) errors.push('duplicate Prisma model names');
if (missing.length) errors.push(`unclassified Prisma models: ${missing.join(', ')}`);
if (stale.length) errors.push(`classification rows without Prisma models: ${stale.join(', ')}`);
if (duplicateClassifications.length) errors.push(`models classified more than once: ${[...new Set(duplicateClassifications)].join(', ')}`);
if (missingAddedMetadata.length) errors.push(`add-native rows missing ownership/privacy/retention metadata: ${missingAddedMetadata.join(', ')}`);
if (!classification.includes('| Model | Authority and lifecycle | Home binding and privacy | Uniqueness, retention and consumer |')) errors.push('add-native model register does not declare the required authority, privacy, retention and consumer columns');
if (forbiddenNames.test(schema)) errors.push('forbidden legacy/HA authority appears in Prisma schema');
if (destructiveSql.test(migration)) errors.push('migration contains a destructive table/column/type/constraint operation');
if (droppedIndexes.some((name) => name !== 'HubInstallation_homeId_key')) errors.push(`unapproved index removal: ${droppedIndexes.join(', ')}`);
if (expectedTaskSeeds.some((name) => !seededTasks.includes(name)) || seededTasks.length !== expectedTaskSeeds.length) errors.push('fixed dispatcher task seed rows do not match the exact four-task registry');
if (missingGuards.length) errors.push(`missing database guards: ${missingGuards.join(', ')}`);
if (!/hub\."state" IN \('ACTIVE','MAINTENANCE','DEREGISTRATION_PENDING','WAITING_FOR_CLEANUP'\)[\s\S]*home\."installationStatus" = 'COMPLETE'[\s\S]*home\."lifecycle"::text <> 'RETIRED'/.test(migration)) errors.push('hub active-pointer backfill does not exclude inactive, incomplete or retired installations');
if (!migration.endsWith(`${fs.readFileSync(path.join(root, 'prisma/stage3_invariants.sql'), 'utf8').trim()}\n`)) errors.push('migration invariant appendix diverges from the reviewed SQL source');
if (!/INSERT INTO "NativeBackgroundTaskState"[\s\S]*?ON CONFLICT \("taskId"\) DO NOTHING/.test(migration)) errors.push('bounded dispatcher state is not seeded idempotently');
if (!migration.includes('AreaQrCredential_one_active_generation_idx') || !migration.includes('AreaAccessRequest_one_pending_requester_area_idx')) errors.push('QR and pending Room request cardinality is not enforced');

const report = {
  ok: errors.length === 0,
  modelCount: models.length,
  classificationCount: classified.length,
  classificationCounts: Object.fromEntries(['Reuse unchanged', 'Evolve', 'Add native'].map((kind) => [kind, rows.filter((row) => row[2] === kind).length])),
  addNativeModelCount: added.length,
  migrationBytes: Buffer.byteLength(migration),
  migrationSha256: crypto.createHash('sha256').update(migration).digest('hex'),
  approvedIndexTransition: droppedIndexes,
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
