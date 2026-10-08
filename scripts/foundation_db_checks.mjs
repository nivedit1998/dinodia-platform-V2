import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const expected = new Set([
  'CustomerAccount', 'CompanyEmployeeAccount', 'TrustedDevice', 'CustomerSession', 'PolicyAcceptance', 'AuthChallenge', 'StepUpAuthorization', 'Home', 'HomeMembership', 'Area', 'TenantAreaGrant', 'NativeDevice', 'DeviceAreaAssignment', 'HubManufacturingIdentity', 'CompanyOperationalWorkItem', 'HubInstallation', 'HubCredentialVersion', 'HubProvisioningAttempt', 'MembershipInvitation', 'MembershipInvitationArea', 'AreaQrCredential', 'AreaAccessRequest', 'HomeClaimReference', 'HomeClaimChallenge', 'HomeClaimReservation', 'PendingHomeSetup', 'HomeDocument', 'MemberPreferenceDocument', 'AuditEvent', 'DeletionSecurityReceipt', 'IdempotencyRecord', 'ReplayNonce', 'AuthRateLimitBucket', 'InitialCxoBootstrap', 'EmployeeSession', 'OperatorHandoff', 'OperatorBrowserAttempt', 'StepUpChallenge', 'SupportTicket', 'SupportAccessRequest', 'SupportSession', 'OfflineMembershipAuthorisation', 'CloudUrlVerification', 'SupportAccessNotification',
  'AreaSourceAlias', 'NativeDeviceSourceAlias', 'PermanentDeviceInstallationRequest', 'NativeCommissioningSession', 'NativeDeviceUsageBucket', 'NativeTemperatureSample', 'NativeAutomation', 'NativeAutomationTrigger', 'NativeAutomationAction', 'NativeAutomationExecution', 'AlexaNativeLink', 'AlexaNativeHomeScope', 'AlexaNativeEndpointProjection', 'AlexaNativeDirectiveReceipt', 'NativeBackgroundTaskState', 'NativeDomainOutbox', 'NativeNotificationDeliveryReceipt', 'NativeDeviceOutageIncident', 'NativeSupportTicketTimeline', 'ExceptionalOwnershipTransfer', 'NativeTenantDeviceRecovery', 'HubSyncReceipt', 'RoomAccessEmailAttempt',
]);
try {
  const tables = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`;
  const names = new Set(tables.map((row) => row.table_name));
  const missing = [...expected].filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !expected.has(name));
  if (missing.length || extra.length) throw new Error(`table inventory mismatch; missing=${missing.join(',')} extra=${extra.join(',')}`);
  const grantRows = await prisma.$queryRaw`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`;
  if (grantRows.length) throw new Error(`anon/authenticated table grants are present (${grantRows.length})`);
  const migration = await prisma.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST`;
  const stage10Rows = await prisma.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '20261008130000_stage10_analytics_maintenance_tasks'`;
  const stage10CoverageRows = await prisma.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '20261008150000_stage10_partial_usage_coverage'`;
  if (stage10Rows.length > 1 || (stage10Rows.length === 1 && (stage10Rows[0].checksum !== '6c651d5b697c6ca295ed21dc9c646db7be2673bbb95e0a05fa29009123f4da2e' || !stage10Rows[0].finished_at || stage10Rows[0].rolled_back_at))) throw new Error('Stage 10 maintenance migration ledger checksum or completion state is not the reviewed additive migration');
  if (stage10CoverageRows.length > 1 || (stage10CoverageRows.length === 1 && (stage10CoverageRows[0].checksum !== '85df08bf3f56a01edee6ebac68ac05d61375bed6ac0ffa28e052b791fbcf73b4' || !stage10CoverageRows[0].finished_at || stage10CoverageRows[0].rolled_back_at))) throw new Error('Stage 10 coverage migration ledger checksum or completion state is not the reviewed additive migration');
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
    '20260926191500_r11_support_possession_proof',
    '20260927010000_nr3_hub_lan_endpoint_observation',
    '20260927020000_nr4_operator_endpoint_binding',
    '20261003000000_native_v2_stage3_domain_schema',
    '20261004050000_stage4_customer_lan_tls_identity',
    '20261004150000_stage5_hub_sync_v2',
    '20261005070000_stage5_hub_incident_deadline',
    '20261005100000_stage5_incident_source_kind',
    '20261005120000_stage6_customer_refresh_families',
    '20261005130000_stage6_mobile_access_credentials',
    '20261006100000_stage6_apns_registration_and_notification_preferences',
    '20261006120000_stage6_invited_tenant_username_setup',
    '20261006150000_stage6_ownership_transfer_claim',
    '20261006170000_stage6_prospective_room_access',
    '20261006180000_stage8_commissioning_and_installation',
    '20261008100000_stage9_deregister_redacted_support_guard',
  ];
  if (stage10Rows.length > 1) throw new Error('Stage 10 migration ledger contains duplicate rows');
  if (stage10Rows.length === 1) {
    const stage10 = stage10Rows[0];
    if (stage10.checksum !== '6c651d5b697c6ca295ed21dc9c646db7be2673bbb95e0a05fa29009123f4da2e'
      || !stage10.finished_at || stage10.rolled_back_at) throw new Error('Stage 10 migration ledger checksum or completion state is not the reviewed additive migration');
    required.push('20261008130000_stage10_analytics_maintenance_tasks');
  }
  if (stage10CoverageRows.length === 1) required.push('20261008150000_stage10_partial_usage_coverage');
  if (migration.length !== required.length || required.some((name) => !migrations.has(name)) || required.some((name) => !migrations.get(name).finished_at || migrations.get(name).rolled_back_at)) throw new Error('migration ledger is not exactly the completed native baseline with the reviewed additive migrations');
  console.log(`[test:stage9-schema] OK: ${names.size} tables, no direct anon/authenticated grants, native baseline and additive migrations through Stage ${stage10Rows.length || stage10CoverageRows.length ? '10' : '9'} completed`);
} finally {
  await prisma.$disconnect();
}
