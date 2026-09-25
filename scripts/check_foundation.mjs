import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const schema = read('prisma/schema.prisma');
const migration = read('prisma/migrations/00000000000000_native_v2_lean_foundation/migration.sql');
const stage1Migration = read('prisma/migrations/20260922000000_stage1_security_authorities/migration.sql');
const stage1RemediationMigration = read('prisma/migrations/20260922010000_stage1_r3_remediation/migration.sql');
const laterStage1Migrations = fs.readdirSync(path.join(root, 'prisma/migrations'))
  .filter((name) => name > '20260922010000_stage1_r3_remediation')
  .sort()
  .map((name) => path.join(root, 'prisma/migrations', name, 'migration.sql'))
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

const approvedModels = [
  'CustomerAccount', 'CompanyEmployeeAccount', 'TrustedDevice', 'CustomerSession', 'PolicyAcceptance', 'AuthChallenge', 'StepUpAuthorization',
  'Home', 'HomeMembership', 'Area', 'TenantAreaGrant', 'NativeDevice', 'DeviceAreaAssignment',
  'HubManufacturingIdentity', 'CompanyOperationalWorkItem', 'HubInstallation', 'HubCredentialVersion', 'HubProvisioningAttempt',
  'MembershipInvitation', 'MembershipInvitationArea', 'AreaQrCredential', 'AreaAccessRequest', 'HomeClaimReference', 'HomeClaimChallenge', 'HomeClaimReservation', 'PendingHomeSetup',
  'HomeDocument', 'MemberPreferenceDocument', 'AuditEvent', 'DeletionSecurityReceipt', 'IdempotencyRecord', 'ReplayNonce',
  'AuthRateLimitBucket', 'InitialCxoBootstrap', 'EmployeeSession', 'OperatorHandoff', 'OperatorBrowserAttempt', 'StepUpChallenge', 'SupportTicket', 'SupportAccessRequest', 'SupportSession', 'OfflineMembershipAuthorisation', 'CloudUrlVerification',
];
const actualModels = [...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);
if (actualModels.length !== approvedModels.length || actualModels.some((model, i) => model !== approvedModels[i])) {
  failures.push(`schema models are not the approved ${approvedModels.length}-model order: ${actualModels.join(', ')}`);
}
for (const model of approvedModels.slice(0, 32)) if (!migration.includes(`CREATE TABLE "${model}"`)) failures.push(`baseline migration does not create ${model}`);
for (const model of approvedModels.slice(32)) if (!(stage1Migration + stage1RemediationMigration + laterStage1Migrations).includes(`CREATE TABLE "${model}"`)) failures.push(`Stage 1 migration does not create ${model}`);

const forbidden = /HaConnection|HomeAssistant|homeassistant|haConnectionId|SupportRequest|NativeAutomation|AlexaRefreshToken|AWS_ORIGIN|dinodia-platform-aws|old\.vercel\.app|fppzzesvukjbsfmxmfxe-old/i;
for (const dir of ['src', 'prisma/schema.prisma']) {
  const target = path.join(root, dir);
  if (!fs.existsSync(target)) continue;
  const files = fs.statSync(target).isFile() ? [target] : fs.readdirSync(target, { recursive: true }).map((f) => path.join(target, f)).filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (forbidden.test(content)) failures.push(`forbidden legacy identifier in active source: ${path.relative(root, file)}`);
  }
}

const deployment = JSON.parse(read('vercel.json'));
if ((deployment.crons ?? []).length > 2) failures.push('Vercel cron ceiling exceeded');
if (!read('next.config.ts').includes("value: 'DENY'")) failures.push('frame denial is not configured');
if (!migration.includes('REVOKE ALL PRIVILEGES ON ALL TABLES')) failures.push('database privacy hardening is missing');
if (!migration.includes('Home_active_lifecycle_guard')) failures.push('active Home lifecycle guard is missing');
if (schema.includes('currentAreaId')) failures.push('NativeDevice.currentAreaId must not be an authoritative schema field');
for (const marker of [
  'TenantAreaGrant_membership_home_fkey',
  'NativeDevice_owner_home_fkey',
  'DeviceAreaAssignment_device_home_fkey',
  'MembershipInvitation_inviter_home_fkey',
  'AreaAccessRequest_qr_area_fkey',
  'HomeClaimReference_hub_home_fkey',
  'StepUpAuthorization_scope_guard',
  'HubManufacturingIdentity_active_serial_unique',
]) if (!migration.includes(marker)) failures.push(`missing foundation integrity object: ${marker}`);
if (/Content-Security-Policy[\s\S]{0,500}unsafe-eval/i.test(read('next.config.ts'))) failures.push('production CSP contains unsafe-eval');

if (failures.length) {
  console.error('[check:foundation] FAIL');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`[check:foundation] OK: ${actualModels.length} native models, baseline plus Stage 1 migration, no active legacy identifiers, <=2 Vercel crons`);
