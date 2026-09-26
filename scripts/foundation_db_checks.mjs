import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const expected = new Set([
  'CustomerAccount', 'CompanyEmployeeAccount', 'TrustedDevice', 'CustomerSession', 'PolicyAcceptance', 'AuthChallenge', 'StepUpAuthorization', 'Home', 'HomeMembership', 'Area', 'TenantAreaGrant', 'NativeDevice', 'DeviceAreaAssignment', 'HubManufacturingIdentity', 'CompanyOperationalWorkItem', 'HubInstallation', 'HubCredentialVersion', 'HubProvisioningAttempt', 'MembershipInvitation', 'MembershipInvitationArea', 'AreaQrCredential', 'AreaAccessRequest', 'HomeClaimReference', 'HomeClaimChallenge', 'HomeClaimReservation', 'PendingHomeSetup', 'HomeDocument', 'MemberPreferenceDocument', 'AuditEvent', 'DeletionSecurityReceipt', 'IdempotencyRecord', 'ReplayNonce', 'AuthRateLimitBucket', 'InitialCxoBootstrap', 'EmployeeSession', 'OperatorHandoff', 'OperatorBrowserAttempt', 'StepUpChallenge', 'SupportTicket', 'SupportAccessRequest', 'SupportSession', 'OfflineMembershipAuthorisation', 'CloudUrlVerification', 'SupportAccessNotification',
]);
try {
  const tables = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`;
  const names = new Set(tables.map((row) => row.table_name));
  const missing = [...expected].filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !expected.has(name));
  if (missing.length || extra.length) throw new Error(`table inventory mismatch; missing=${missing.join(',')} extra=${extra.join(',')}`);
  const grantRows = await prisma.$queryRaw`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`;
  if (grantRows.length) throw new Error(`anon/authenticated table grants are present (${grantRows.length})`);
  const migration = await prisma.$queryRaw`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST`;
  const migrations = new Map(migration.map((row) => [row.migration_name, row]));
  const required = [
    '00000000000000_native_v2_lean_foundation',
    '20260922000000_stage1_security_authorities',
    '20260922010000_stage1_r3_remediation',
    '20260924000000_r4_credential_purpose_separation',
    '20260924001000_r4_operator_handoff_binding',
    '20260924002000_r4_employee_bootstrap_invitation',
    '20260924003000_r4_cloudflare_reservation_token',
    '20260924004000_r4_step_up_hub_descriptor_nonce',
    '20260924005000_r4_operator_handoff_secret',
    '20260925000000_r4_support_hub_handoff',
    '20260925010000_r6_browser_attempt_binding',
    '20260925020000_r7_cxo_delivery_and_work_assignment',
    '20260925030000_r8_trusted_device_session_version',
    '20260925040000_r7_support_notifications',
    '20260925230000_r11_operator_mutation_idempotency',
  ];
  if (migration.length !== required.length || required.some((name) => !migrations.has(name)) || required.some((name) => !migrations.get(name).finished_at || migrations.get(name).rolled_back_at)) throw new Error('migration ledger is not exactly the completed native baseline and Stage 1 migrations');
  console.log(`[test:foundation] OK: ${names.size} tables, no direct anon/authenticated grants, native baseline and ${required.length - 1} Stage 1 migrations completed`);
} finally {
  await prisma.$disconnect();
}
