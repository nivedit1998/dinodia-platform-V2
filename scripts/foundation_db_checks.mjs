import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const expected = new Set([
  'CustomerAccount', 'CompanyEmployeeAccount', 'TrustedDevice', 'CustomerSession', 'PolicyAcceptance', 'AuthChallenge', 'StepUpAuthorization', 'Home', 'HomeMembership', 'Area', 'TenantAreaGrant', 'NativeDevice', 'DeviceAreaAssignment', 'HubManufacturingIdentity', 'CompanyOperationalWorkItem', 'HubInstallation', 'HubCredentialVersion', 'HubProvisioningAttempt', 'MembershipInvitation', 'MembershipInvitationArea', 'AreaQrCredential', 'AreaAccessRequest', 'HomeClaimReference', 'HomeClaimChallenge', 'HomeClaimReservation', 'PendingHomeSetup', 'HomeDocument', 'MemberPreferenceDocument', 'AuditEvent', 'DeletionSecurityReceipt', 'IdempotencyRecord', 'ReplayNonce',
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
  if (migration.length !== 1 || migration[0].migration_name !== '00000000000000_native_v2_lean_foundation' || !migration[0].finished_at || migration[0].rolled_back_at) throw new Error('migration ledger is not exactly one completed native foundation migration');
  console.log(`[test:foundation] OK: ${names.size} tables, no direct anon/authenticated grants, one completed baseline migration`);
} finally {
  await prisma.$disconnect();
}
