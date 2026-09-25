import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const expectedResetConfirmation = 'I_UNDERSTAND_FRESH_V2_PROJECT_fppzzesvukjbsfmxmfxe';
const expectedMigrationConfirmation = 'I_UNDERSTAND_NEW_V2_DATABASE';
const expectedMigrations = [
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
];
const expectedModels = new Set([
  'CustomerAccount', 'CompanyEmployeeAccount', 'TrustedDevice', 'CustomerSession', 'PolicyAcceptance', 'AuthChallenge', 'StepUpAuthorization',
  'Home', 'HomeMembership', 'Area', 'TenantAreaGrant', 'NativeDevice', 'DeviceAreaAssignment',
  'HubManufacturingIdentity', 'CompanyOperationalWorkItem', 'HubInstallation', 'HubCredentialVersion', 'HubProvisioningAttempt',
  'MembershipInvitation', 'MembershipInvitationArea', 'AreaQrCredential', 'AreaAccessRequest', 'HomeClaimReference', 'HomeClaimChallenge', 'HomeClaimReservation', 'PendingHomeSetup',
  'HomeDocument', 'MemberPreferenceDocument', 'AuditEvent', 'DeletionSecurityReceipt', 'IdempotencyRecord', 'ReplayNonce',
  'EmployeeSession', 'OperatorHandoff', 'OperatorBrowserAttempt', 'StepUpChallenge', 'SupportTicket', 'SupportAccessRequest', 'SupportSession', 'OfflineMembershipAuthorisation', 'CloudUrlVerification',
]);

function fail(message) {
  console.error(`[db:reset:rc] BLOCKED: ${message}`);
  process.exit(1);
}

if (process.env.V2_ENVIRONMENT !== 'rc') fail('refusing remote reset unless V2_ENVIRONMENT=rc');
if (process.env.NODE_ENV === 'production') fail('refusing remote reset in production mode');
if (process.env.V2_ALLOW_REMOTE_RESET !== expectedResetConfirmation) fail('V2_ALLOW_REMOTE_RESET must contain the exact fresh V2 reset confirmation');
if (process.env.V2_ALLOW_REMOTE_MIGRATION !== expectedMigrationConfirmation) fail('V2_ALLOW_REMOTE_MIGRATION must contain the exact fresh V2 migration confirmation');
if (!process.env.V2_RC_ARTIFACT_DIR) fail('V2_RC_ARTIFACT_DIR must point to a temporary evidence directory');
if (!process.env.V2_EXPECTED_SCHEMA_FINGERPRINT) fail('V2_EXPECTED_SCHEMA_FINGERPRINT is required');
if (!process.env.V2_EXPECTED_MIGRATION_SHA256) fail('V2_EXPECTED_MIGRATION_SHA256 is required');
if (!process.env.DIRECT_URL) fail('DIRECT_URL is required in the calling process');

const root = process.cwd();
const artifactDir = path.resolve(process.env.V2_RC_ARTIFACT_DIR);
const migrationPaths = expectedMigrations.map((migration) => path.join(root, 'prisma', 'migrations', migration, 'migration.sql'));

function runTargetGuard() {
  const result = spawnSync(process.execPath, ['scripts/assert_v2_target.mjs', '--mode', 'rc'], {
    stdio: 'inherit',
    env: process.env,
    cwd: root,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function connectionEnvironment() {
  let url;
  try {
    url = new URL(process.env.DIRECT_URL);
  } catch {
    fail('DIRECT_URL is not a valid URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!database || !url.hostname || !url.username || !url.password) fail('DIRECT_URL must include host, database, username and password');
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.DIRECT_URL;
  environment.PGHOST = url.hostname;
  environment.PGPORT = url.port || '5432';
  environment.PGUSER = decodeURIComponent(url.username);
  environment.PGPASSWORD = decodeURIComponent(url.password);
  environment.PGDATABASE = database;
  environment.PGSSLMODE = url.searchParams.get('sslmode') || 'require';
  return environment;
}

function runPsql(args, label, options = {}) {
  const result = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', ...args], {
    cwd: root,
    env: connectionEnvironment(),
    encoding: 'utf8',
    input: options.input,
    stdio: options.capture === false ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]');
    fail(`${label} failed with exit ${result.status ?? 1}${detail ? `: ${detail.trim()}` : ''}`);
  }
  return String(result.stdout || '');
}

function queryJson(sql, label) {
  const output = runPsql(['-qAt', '-c', sql], label);
  try {
    return JSON.parse(output.trim());
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function safeJson(value) {
  return JSON.stringify(value, (_, nested) => typeof nested === 'bigint' ? nested.toString() : nested, 2);
}

function canonicalRows(rows) {
  return rows
    .map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function schemaFingerprint(snapshot) {
  const payload = JSON.stringify({
    tables: canonicalRows(snapshot.tables),
    columns: canonicalRows(snapshot.columns),
    constraints: canonicalRows(snapshot.constraints),
    indexes: canonicalRows(snapshot.indexes),
    functions: canonicalRows(snapshot.functions),
    triggers: canonicalRows(snapshot.triggers),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function captureSnapshot(label) {
  const metadata = queryJson(`SELECT json_build_object(
    'tables',(SELECT COALESCE(json_agg(q ORDER BY table_name),'[]'::json) FROM (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') q),
    'columns',(SELECT COALESCE(json_agg(q ORDER BY table_name,ordinal_position),'[]'::json) FROM (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public') q),
    'constraints',(SELECT COALESCE(json_agg(q ORDER BY table_name,conname),'[]'::json) FROM (SELECT conrelid::regclass::text AS table_name,conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace) q),
    'indexes',(SELECT COALESCE(json_agg(q ORDER BY table_name,indexname),'[]'::json) FROM (SELECT tablename AS table_name,indexname,indexdef FROM pg_indexes WHERE schemaname='public') q),
    'functions',(SELECT COALESCE(json_agg(q ORDER BY function_name,arguments),'[]'::json) FROM (SELECT n.nspname AS schema_name,p.proname AS function_name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') q),
    'triggers',(SELECT COALESCE(json_agg(q ORDER BY table_name,tgname),'[]'::json) FROM (SELECT pg_trigger.tgrelid::regclass::text AS table_name,tgname,pg_get_triggerdef(pg_trigger.oid) AS definition FROM pg_trigger JOIN pg_class ON pg_class.oid=pg_trigger.tgrelid JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE NOT tgisinternal AND pg_namespace.nspname='public') q)
  )`, `${label} schema metadata`);
  const rowCounts = [];
  for (const row of metadata.tables) {
    const table = String(row.table_name).replaceAll('"', '""');
    const count = runPsql(['-qAt', '-c', `SELECT COUNT(*)::text FROM "${table}"`], `${label} row count`).trim();
    rowCounts.push({ table: row.table_name, count });
  }
  let migrationLedger = [];
  if (metadata.tables.some((row) => row.table_name === '_prisma_migrations')) {
    migrationLedger = queryJson(`SELECT COALESCE(json_agg(q ORDER BY finished_at DESC NULLS LAST),'[]'::json) FROM (SELECT migration_name,finished_at,rolled_back_at FROM _prisma_migrations) q`, `${label} migration ledger`);
  }
  const snapshot = { label, ...metadata, rowCounts, migrationLedger };
  snapshot.fingerprint = schemaFingerprint(snapshot);
  return snapshot;
}

function writeArtifact(name, data) {
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const target = path.join(artifactDir, name);
  fs.writeFileSync(target, safeJson(data), { encoding: 'utf8', mode: 0o600 });
  return { path: target, sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') };
}

function verifyPostReset(snapshot) {
  const names = new Set(snapshot.tables.map((row) => row.table_name));
  const applicationNames = new Set([...names].filter((name) => name !== '_prisma_migrations'));
  const missing = [...expectedModels].filter((name) => !applicationNames.has(name));
  const extra = [...applicationNames].filter((name) => !expectedModels.has(name));
  if (missing.length || extra.length) fail(`remote table inventory mismatch; missing=${missing.join(',')} extra=${extra.join(',')}`);
  const nonZero = snapshot.rowCounts.filter((row) => row.table !== '_prisma_migrations' && Number(row.count) !== 0);
  if (nonZero.length) fail(`remote reset left application rows: ${nonZero.map((row) => `${row.table}=${row.count}`).join(',')}`);
  const migrationNames = snapshot.migrationLedger.map((row) => row.migration_name).sort();
  const expectedNames = [...expectedMigrations].sort();
  if (migrationNames.length !== expectedNames.length || migrationNames.some((name, index) => name !== expectedNames[index]) || snapshot.migrationLedger.some((row) => !row.finished_at || row.rolled_back_at)) {
    fail('remote migration ledger is not exactly the completed native baseline plus all checked-in Stage 1 migrations');
  }
  if (snapshot.fingerprint !== process.env.V2_EXPECTED_SCHEMA_FINGERPRINT) fail(`remote schema fingerprint mismatch: ${snapshot.fingerprint}`);
  const grants = queryJson(`SELECT COALESCE(json_agg(q),'[]'::json) FROM (SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated')) q`, 'remote privilege verification');
  if (grants.length) fail(`unexpected anon/authenticated grants remain: ${grants.length}`);
}

runTargetGuard();
const migrationSha = crypto.createHash('sha256').update(Buffer.concat(migrationPaths.map((file) => fs.readFileSync(file)))).digest('hex');
if (migrationSha !== process.env.V2_EXPECTED_MIGRATION_SHA256) fail('checked-in migration bundle SHA-256 does not match the supplied expected value');

const pre = captureSnapshot('pre-reset');
const preArtifact = writeArtifact('pre-reset-schema-metadata.json', pre);
const existingApplicationRows = pre.rowCounts.filter((row) => row.table !== '_prisma_migrations' && Number(row.count) !== 0);
if (existingApplicationRows.length) fail(`unexpected existing application rows; reset refused: ${existingApplicationRows.map((row) => `${row.table}=${row.count}`).join(',')}`);
console.log(`[db:reset:rc] target guard passed for fppzzesvukjbsfmxmfxe; pre-reset artifact SHA-256=${preArtifact.sha256}`);

runPsql(['-qAt', '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'], 'authorized V2 schema reset');
for (const migrationPath of migrationPaths) runPsql(['-f', migrationPath], `native SQL migration ${path.basename(path.dirname(migrationPath))}`);
runPsql(['-qAt', '-c', 'CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "applied_steps_count" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id"));'], 'migration ledger creation');
for (const [index, migration] of expectedMigrations.entries()) {
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(migrationPaths[index])).digest('hex');
  runPsql(['-qAt', '-c', `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count") VALUES (gen_random_uuid()::text,'${checksum}',CURRENT_TIMESTAMP,'${migration}',NULL,NULL,CURRENT_TIMESTAMP,1);`], `migration ledger recording ${migration}`);
}

const post = captureSnapshot('post-reset');
verifyPostReset(post);
const postArtifact = writeArtifact('post-reset-schema-metadata.json', post);

// Prisma migration idempotency is proven in both clean Docker databases by the
// required second `prisma migrate deploy` run. The remote guard records the
// same durable ledger invariant without passing a database URL to a Prisma
// child process, which is unsafe for a credential-bearing Supabase URL.
const idempotentLedger = queryJson(`SELECT COALESCE(json_agg(q),'[]'::json) FROM (SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations) q`, 'idempotent migration ledger check');
if (idempotentLedger.length !== expectedMigrations.length || idempotentLedger.some((row) => !expectedMigrations.includes(row.migration_name) || !row.finished_at || row.rolled_back_at)) fail('idempotent migration ledger check failed');
console.log(`[db:reset:rc] SUCCESS: native baseline plus Stage 1 applied to the authorised V2 project; fingerprint=${post.fingerprint}; post-reset artifact SHA-256=${postArtifact.sha256}`);
