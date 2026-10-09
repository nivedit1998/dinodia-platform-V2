import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const sourceRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-v2-clean-source-'));
const dockerName = `dinodia-v2-clean-${process.pid}`;
const dockerPort = process.env.V2_CLEAN_CLONE_PORT || String(55488 + (process.pid % 100));
const databasePassword = 'local-clean-clone-only';
const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/dinodia_v2_foundation`;
const independentDatabaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/dinodia_v2_foundation_independent`;
const upgradeDatabaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/dinodia_v2_foundation_upgrade`;
const priorHeadDatabaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/dinodia_v2_prior_stage3`;
const priorStage6DatabaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/dinodia_v2_prior_stage6`;
const priorStage8DatabaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/dinodia_v2_prior_stage8`;
const priorHeadMigrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-v2-prior-head-migrations-'));
const priorStage6MigrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-v2-prior-stage6-migrations-'));
const priorStage8MigrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-v2-prior-stage8-migrations-'));
const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-v2-schema-compatible-rollback-'));
const schemaCompatibleRollbackCommit = '35c63a57e71b6f4b8103eff2292a9f36d377bbe4';
let dockerStarted = false;

function safeProcessEnvironment() {
  const safe = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']) {
    if (process.env[name]) safe[name] = process.env[name];
  }
  return safe;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? sourceRoot, env: options.env ?? safeProcessEnvironment(), stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 1}`);
}

function runWithInput(command, args, input, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? sourceRoot, env: options.env ?? safeProcessEnvironment(), input, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 1}`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? sourceRoot, env: options.env ?? safeProcessEnvironment(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 1}`);
  return result.stdout;
}

function git(args) {
  return execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
}

function sourceFiles() {
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const statusEntries = git(['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean);
  const deleted = new Set();
  for (const entry of statusEntries) {
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.includes('D')) deleted.add(file);
  }
  const files = new Set(tracked.filter((file) => !deleted.has(file)));
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const file of untracked) files.add(file);

  const forbidden = [];
  const allowed = [];
  for (const file of [...files].sort()) {
    if (file === '.git' || file.startsWith('.git/') || file.startsWith('node_modules/') || file.startsWith('.next/')) continue;
    if (file === '.env.local' || file === '.env.preview' || file === '.env.production' || file.startsWith('.vercel/') || file.startsWith('.supabase/') || /\.(pem|key|p12|pfx|dump|sql\.gz)$/i.test(file)) {
      forbidden.push(file);
      continue;
    }
    const absolute = path.join(sourceRoot, file);
    if (!fs.existsSync(absolute)) continue;
    allowed.push(file);
  }
  if (forbidden.length) throw new Error(`clean source contains forbidden local/secret files: ${forbidden.join(', ')}`);
  return allowed;
}

function copyPreservingLink(relativeFile) {
  const source = path.join(sourceRoot, relativeFile);
  const destination = path.join(tempRoot, relativeFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
  else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, stat.mode & 0o777);
}

function copyCrossRepositoryFixture(source, destination, files) {
  if (!fs.existsSync(source)) throw new Error(`required cross-repository source is missing: ${source}`);
  for (const file of files) {
    const from = path.join(source, file);
    if (!fs.existsSync(from)) throw new Error(`required cross-repository contract file is missing: ${from}`);
    const to = path.join(destination, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function copyCrossRepositoryTree(source, destination, relativeDirectories) {
  if (!fs.existsSync(source)) throw new Error(`required cross-repository source is missing: ${source}`);
  for (const relativeDirectory of relativeDirectories) {
    const from = path.join(source, relativeDirectory);
    if (!fs.existsSync(from)) throw new Error(`required cross-repository directory is missing: ${from}`);
    const to = path.join(destination, relativeDirectory);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, {
      recursive: true,
      filter: (entry) => {
        const relative = path.relative(source, entry);
        return !relative.startsWith('node_modules') && !relative.startsWith('.git') && !relative.startsWith('.env.local');
      },
    });
  }
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('docker', ['exec', dockerName, 'pg_isready', '-U', 'postgres', '-d', 'dinodia_v2_foundation'], { encoding: 'utf8' });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('temporary PostgreSQL did not become ready');
}

function cleanup() {
  // The disposable Postgres container uses Docker's anonymous data volume.
  // Remove that volume with the owned container to avoid leaving test data
  // behind as a dangling local volume after clean-clone checks.
  if (dockerStarted) spawnSync('docker', ['rm', '-f', '-v', dockerName], { stdio: 'ignore' });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(priorHeadMigrationRoot, { recursive: true, force: true });
  fs.rmSync(priorStage6MigrationRoot, { recursive: true, force: true });
  fs.rmSync(priorStage8MigrationRoot, { recursive: true, force: true });
  fs.rmSync(rollbackRoot, { recursive: true, force: true });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function probeApplication(source, env, fixture) {
  // Exercise a real browser-session refresh before the selected-home denial.
  // The previous rehearsal hand-built a refresh row, which made a rejection
  // ambiguous: it could fail at session authentication instead of reaching
  // the wrong-home boundary. Give each app candidate its own fresh disposable
  // session family so the rollback probe cannot consume the forward probe's
  // credential.
  const sessionId = crypto.randomUUID();
  const sessionFamilyId = crypto.randomUUID();
  const rawSession = `dno-customer-session-${crypto.randomBytes(32).toString('base64url')}`;
  const refreshTokenHash = crypto.createHash('sha256').update(rawSession).digest('hex');
  const seedSessionSql = `INSERT INTO "CustomerSession" ("id","customerAccountId","trustedDeviceId","sessionFamilyId","refreshTokenHash","securityVersion","trustedDeviceSessionVersion","issuedAt","expiresAt","absoluteExpiresAt","lastUsedAt","updatedAt") VALUES ('${sessionId}','${fixture.accountId}','${fixture.trustedDeviceId}','${sessionFamilyId}','${refreshTokenHash}',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP + INTERVAL '180 days',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_foundation', '-v', 'ON_ERROR_STOP=1'], seedSessionSql);
  const port = await freePort();
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { cwd: source, env, stdio: 'ignore' });
  try {
    let result;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null) throw new Error('application rollback candidate exited before readiness');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
        const body = await response.json();
        if (response.status === 200 && body.ready === true) { result = body; break; }
      } catch { /* Startup may not have bound its loopback port yet. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!result) throw new Error('application did not become schema-ready on the disposable Stage 3 database');
    const denied = await fetch(`http://127.0.0.1:${port}/api/v2/session`);
    if (denied.status !== 401) throw new Error('schema-compatible application did not preserve the anonymous customer boundary');
    const automationDenied = await fetch(`http://127.0.0.1:${port}/api/automations`);
    if (automationDenied.status !== 401) throw new Error(`schema-compatible application did not preserve the protected Stage 11 automation route (status=${automationDenied.status})`);
    const preRefreshCookie = `dinodia_customer_session=${encodeURIComponent(rawSession)}`;
    const allowed = await fetch(`http://127.0.0.1:${port}/api/v2/session`, { headers: { cookie: preRefreshCookie } });
    const allowedBody = await allowed.json();
    if (allowed.status !== 200 || allowedBody.accountId !== fixture.accountId || allowedBody.memberships?.length !== 1 || allowedBody.memberships[0]?.homeId !== fixture.allowedHomeId || allowedBody.memberships[0]?.role !== 'OWNER') {
      throw new Error('schema-compatible application failed the authenticated account-session refresh before wrong-home denial');
    }
    const setCookie = allowed.headers.get('set-cookie') ?? '';
    const refreshedCookie = setCookie.match(/(?:^|,\s*)dinodia_customer_session=([^;,]+)/)?.[1];
    if (!refreshedCookie) throw new Error('schema-compatible application did not rotate the disposable browser session cookie');
    const sessionCookie = `dinodia_customer_session=${refreshedCookie}`;
    const wrongHome = await fetch(`http://127.0.0.1:${port}/api/v2/hub-sessions`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ homeId: fixture.privateHomeId }),
    });
    const wrongHomeBody = await wrongHome.text();
    if (wrongHome.status !== 403 || wrongHomeBody.includes(fixture.privateHomeMarker) || wrongHomeBody.includes(fixture.privateHomeId) || wrongHomeBody.includes(fixture.allowedHomeId)) {
      let wrongHomeErrorCode = 'non-json';
      try { wrongHomeErrorCode = JSON.parse(wrongHomeBody)?.error?.code ?? 'missing-code'; } catch { /* Report only a safe classification. */ }
      throw new Error(`schema-compatible application wrong-home check failed (status=${wrongHome.status}, errorCode=${String(wrongHomeErrorCode).slice(0, 64)}, privateMarker=${wrongHomeBody.includes(fixture.privateHomeMarker)}, privateHomeId=${wrongHomeBody.includes(fixture.privateHomeId)}, allowedHomeId=${wrongHomeBody.includes(fixture.allowedHomeId)})`);
    }
    return result;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 2000); } });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

try {
  const files = sourceFiles();
  for (const file of files) copyPreservingLink(file);
  // The clean-source proof must exercise the real cross-repository security
  // contracts. Copy only the reviewed contract surfaces into an isolated
  // fixture; no dependency or local/secret material is imported.
  const crossRoot = path.join(tempRoot, '.cross-repository');
  const osFixture = path.join(crossRoot, 'Dinodia OS');
  const edgeFixture = path.join(crossRoot, 'dinodia-edge-worker-V2');
  const iosFixture = path.join(crossRoot, 'dinodia-ios-app-V2');
  copyCrossRepositoryTree(path.resolve(sourceRoot, '../Dinodia OS'), osFixture, ['src', 'public']);
  copyCrossRepositoryFixture(path.resolve(sourceRoot, '../Dinodia OS'), osFixture, [
    'package.json', 'package-lock.json', '.env.example',
  ]);
  copyCrossRepositoryFixture(path.resolve(sourceRoot, '../dinodia-edge-worker-V2'), edgeFixture, ['wrangler.toml', 'src/index.ts']);
  copyCrossRepositoryFixture(path.resolve(sourceRoot, '../dinodia-ios-app-V2'), iosFixture, [
    'Dinodia.xcodeproj/project.pbxproj',
    'Dinodia/Dinodia.entitlements',
    'Dinodia/Info.plist',
  ]);
  if (!fs.existsSync(path.join(tempRoot, '.env.example'))) throw new Error('.env.example is missing from the clean source snapshot');
  const example = fs.readFileSync(path.join(tempRoot, '.env.example'), 'utf8');
  if (/postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/i.test(example.replaceAll('USER:PASSWORD', 'PLACEHOLDER'))) throw new Error('.env.example appears to contain a real database credential');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(example)) throw new Error('.env.example contains a private key');

  // Deployment metadata is deliberately excluded from the source snapshot.
  // The target-guard integration tests still need to exercise the approved
  // Vercel identity, so create a temporary value-free link from the checked-in
  // public target manifest. It is removed with the temporary source tree.
  const target = JSON.parse(fs.readFileSync(path.join(tempRoot, 'scripts', 'v2-target.json'), 'utf8'));
  const temporaryVercelDirectory = path.join(tempRoot, '.vercel');
  fs.mkdirSync(temporaryVercelDirectory, { recursive: true });
  fs.writeFileSync(path.join(temporaryVercelDirectory, 'project.json'), JSON.stringify({ projectId: target.vercelProjectId, orgId: target.vercelOrgId }));

  run('npm', ['ci'], { cwd: tempRoot, env: { ...safeProcessEnvironment(), CI: '1', NODE_ENV: 'test' } });
  const existingContainer = spawnSync('docker', ['inspect', '--type=container', dockerName], { stdio: 'ignore' });
  if (existingContainer.status === 0) throw new Error('unique disposable PostgreSQL container name already exists; preserve it and rerun with a fresh process');
  if (existingContainer.status !== 1) throw new Error('could not safely verify the disposable PostgreSQL container name');
  // Mark the unique, preflighted name as owned before invoking `docker run`:
  // Docker can create a stopped container and then return a failed start, and
  // cleanup must still remove only that exact newly-owned disposable target.
  dockerStarted = true;
  run('docker', ['run', '-d', '--name', dockerName, '-e', `POSTGRES_PASSWORD=${databasePassword}`, '-e', 'POSTGRES_DB=dinodia_v2_foundation', '-p', `127.0.0.1:${dockerPort}:5432`, 'postgres:16-alpine']);
  waitForPostgres();

  const localEnv = {
    ...safeProcessEnvironment(),
    CI: '1',
    NODE_ENV: 'test',
    NEXT_TELEMETRY_DISABLED: '1',
    PRISMA_TELEMETRY_DISABLED: '1',
    CHECKPOINT_DISABLE: '1',
    V2_ENVIRONMENT: 'local',
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    DINODIA_OS_ROOT: osFixture,
    DINODIA_IOS_ROOT: iosFixture,
    DINODIA_EDGE_ROOT: edgeFixture,
  };
  run('npx', ['prisma', 'validate'], { cwd: tempRoot, env: localEnv });
  run('npx', ['prisma', 'generate'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/assert_v2_target.mjs', '--mode', 'local', '--run-prisma'], { cwd: tempRoot, env: localEnv });
  // The second guarded deployment is part of the clean-source proof: a
  // release candidate must be safe to restart after an interrupted deploy.
  run('node', ['scripts/assert_v2_target.mjs', '--mode', 'local', '--run-prisma'], { cwd: tempRoot, env: localEnv });

  // Prove a second independent empty PostgreSQL database reaches the same
  // schema fingerprint after a fresh deployment and an idempotent replay.
  run('docker', ['exec', dockerName, 'createdb', '-U', 'postgres', 'dinodia_v2_foundation_independent']);
  const independentEnv = { ...localEnv, DATABASE_URL: independentDatabaseUrl, DIRECT_URL: independentDatabaseUrl };
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: independentEnv });
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: independentEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: independentEnv });
  const firstEmptySchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: localEnv }));
  const secondEmptySchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: independentEnv }));
  const firstEmptyFingerprint = firstEmptySchema.fingerprint;
  const secondEmptyFingerprint = secondEmptySchema.fingerprint;
  if (!firstEmptyFingerprint || firstEmptyFingerprint !== secondEmptyFingerprint) throw new Error('independent empty PostgreSQL migration proofs produced different schema fingerprints');
  console.log(`[clean-clone:check] PASS: two independent empty PostgreSQL databases produced the same schema fingerprint ${firstEmptyFingerprint} after fresh and idempotent migration deploys`);

  // Reconstruct the exact current pre-Stage-3 migration head in another empty
  // database, then apply Stage 3 from that head and prove the schema matches
  // both empty-database paths. This is distinct from replaying the chain from
  // the original foundation below.
  run('docker', ['exec', dockerName, 'createdb', '-U', 'postgres', 'dinodia_v2_prior_stage3']);
  const priorPrismaDirectory = path.join(priorHeadMigrationRoot, 'prisma');
  const priorMigrationsDirectory = path.join(priorPrismaDirectory, 'migrations');
  fs.mkdirSync(priorMigrationsDirectory, { recursive: true });
  fs.writeFileSync(path.join(priorMigrationsDirectory, 'migration_lock.toml'), '# Please do not edit this file manually.\n# This file should be committed to your version control system.\nprovider = "postgresql"\n');
  for (const migration of fs.readdirSync(path.join(tempRoot, 'prisma/migrations')).filter((name) => /^\d/.test(name) && !['20261003000000_native_v2_stage3_domain_schema', '20261004050000_stage4_customer_lan_tls_identity', '20261004150000_stage5_hub_sync_v2', '20261005070000_stage5_hub_incident_deadline', '20261005100000_stage5_incident_source_kind', '20261005120000_stage6_customer_refresh_families', '20261005130000_stage6_mobile_access_credentials', '20261006100000_stage6_apns_registration_and_notification_preferences', '20261006120000_stage6_invited_tenant_username_setup', '20261006150000_stage6_ownership_transfer_claim', '20261006170000_stage6_prospective_room_access', '20261006180000_stage8_commissioning_and_installation', '20261008100000_stage9_deregister_redacted_support_guard', '20261008130000_stage10_analytics_maintenance_tasks', '20261008150000_stage10_partial_usage_coverage', '20261009100000_stage11_automation_action_order', '20261009110000_stage12_alexa_oauth_scope'].includes(name)).sort()) {
    fs.cpSync(path.join(tempRoot, 'prisma/migrations', migration), path.join(priorMigrationsDirectory, migration), { recursive: true });
  }
  const priorHeadSchema = path.join(priorPrismaDirectory, 'schema.prisma');
  fs.writeFileSync(priorHeadSchema, 'datasource db {\n  provider = "postgresql"\n  url = env("DIRECT_URL")\n}\n');
  const priorHeadEnv = { ...localEnv, DATABASE_URL: priorHeadDatabaseUrl, DIRECT_URL: priorHeadDatabaseUrl };
  const localPrisma = path.join(tempRoot, 'node_modules', '.bin', 'prisma');
  run(localPrisma, ['migrate', 'deploy', '--schema', priorHeadSchema], { cwd: priorHeadMigrationRoot, env: priorHeadEnv });
  const backfillFixtureSql = `
INSERT INTO "CustomerAccount" ("id","displayName","username","usernameNormalized","email","emailNormalized","passwordHash","updatedAt") VALUES
  ('00000000-0000-4000-8000-000000002001','Stage 3 prior-head owner','stage3-prior-owner','stage3-prior-owner','stage3-prior-owner@example.invalid','stage3-prior-owner@example.invalid','test-only-not-authenticatable',CURRENT_TIMESTAMP);
INSERT INTO "Home" ("id","lifecycle","installationStatus","installationCompletedAt","updatedAt") VALUES
  ('00000000-0000-4000-8000-000000001001','INSTALLING','COMPLETE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000001002','INSTALLING','DRAFT',NULL,CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000001003','UNOWNED','COMPLETE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "HomeMembership" ("id","customerAccountId","homeId","role","status","updatedAt") VALUES
  ('00000000-0000-4000-8000-000000003001','00000000-0000-4000-8000-000000002001','00000000-0000-4000-8000-000000001001','OWNER','ACTIVE',CURRENT_TIMESTAMP);
INSERT INTO "HubManufacturingIdentity" ("id","serialNumber","signingPublicKey","encryptionPublicKey","signingKeyFingerprint","encryptionKeyFingerprint","updatedAt") VALUES
  ('00000000-0000-4000-8000-000000004001','stage3-backfill-installed','test-signing-public-key','test-encryption-public-key','stage3-backfill-signing-1','stage3-backfill-encryption-1',CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000004002','stage3-backfill-incomplete','test-signing-public-key','test-encryption-public-key','stage3-backfill-signing-2','stage3-backfill-encryption-2',CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000004003','stage3-backfill-revoked','test-signing-public-key','test-encryption-public-key','stage3-backfill-signing-3','stage3-backfill-encryption-3',CURRENT_TIMESTAMP);
INSERT INTO "HubInstallation" ("id","homeId","manufacturingIdentityId","serialNumberSnapshot","state","cloudUrl","cloudUrlVerifiedAt","remoteVerificationAt","updatedAt") VALUES
  ('00000000-0000-4000-8000-000000005001','00000000-0000-4000-8000-000000001001','00000000-0000-4000-8000-000000004001','stage3-backfill-installed','ACTIVE','https://stage3.invalid/hub',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000005002','00000000-0000-4000-8000-000000001002','00000000-0000-4000-8000-000000004002','stage3-backfill-incomplete','PROVISIONED',NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000005003','00000000-0000-4000-8000-000000001003','00000000-0000-4000-8000-000000004003','stage3-backfill-revoked','REVOKED',NULL,NULL,NULL,CURRENT_TIMESTAMP);
INSERT INTO "Area" ("id","homeId","osAreaId","originalName","updatedAt") VALUES
  ('00000000-0000-4000-8000-000000006001','00000000-0000-4000-8000-000000001001','stage3-backfill-area','Stage 3 backfill area',CURRENT_TIMESTAMP);
UPDATE "Home" SET "lifecycle" = 'ACTIVE', "addressStatus" = 'VERIFIED',
  "addressLine1" = '1 Test Road', "city" = 'Test City', "postcode" = 'TST 1', "country" = 'GB', "timezone" = 'Europe/London', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-4000-8000-000000001001';
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage3', '-v', 'ON_ERROR_STOP=1'], backfillFixtureSql);
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: priorHeadEnv });
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: priorHeadEnv });
  run('node', ['scripts/stage3_backfill_checks.mjs'], { cwd: tempRoot, env: priorHeadEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: priorHeadEnv });
  const priorHeadUpgradeSchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: priorHeadEnv }));
  const priorHeadUpgradeFingerprint = priorHeadUpgradeSchema.fingerprint;
  const differingSchemaComponents = Object.keys(firstEmptySchema.componentFingerprints ?? {}).filter((key) =>
    firstEmptySchema.componentFingerprints[key] !== priorHeadUpgradeSchema.componentFingerprints?.[key]);
  if (!priorHeadUpgradeFingerprint || priorHeadUpgradeFingerprint !== firstEmptyFingerprint) {
    throw new Error(`exact prior-head Stage 3 upgrade did not match empty schema; differing=${differingSchemaComponents.join(',') || 'fingerprint-only'} empty=${firstEmptyFingerprint} prior=${priorHeadUpgradeFingerprint}`);
  }
  console.log(`[clean-clone:check] PASS: exact pre-Stage-3 migration head upgraded and reapplied idempotently to matching schema fingerprint ${priorHeadUpgradeFingerprint}`);

  // Reconstruct the exact pre-Stage-9 Production migration head (30
  // migrations) separately, then apply Stage 9 twice. Preserve an existing
  // account, membership, SupportTicket, and in-progress installer request.
  run('docker', ['exec', dockerName, 'createdb', '-U', 'postgres', 'dinodia_v2_prior_stage6']);
  const stage6PriorPrismaDirectory = path.join(priorStage6MigrationRoot, 'prisma');
  const stage6PriorMigrationsDirectory = path.join(stage6PriorPrismaDirectory, 'migrations');
  fs.mkdirSync(stage6PriorMigrationsDirectory, { recursive: true });
  fs.writeFileSync(path.join(stage6PriorMigrationsDirectory, 'migration_lock.toml'), '# Please do not edit this file manually.\n# This file should be committed to your version control system.\nprovider = "postgresql"\n');
  const stage6MigrationNames = new Set(['20261005120000_stage6_customer_refresh_families', '20261005130000_stage6_mobile_access_credentials', '20261006100000_stage6_apns_registration_and_notification_preferences', '20261006120000_stage6_invited_tenant_username_setup', '20261006150000_stage6_ownership_transfer_claim', '20261006170000_stage6_prospective_room_access', '20261006180000_stage8_commissioning_and_installation', '20261008100000_stage9_deregister_redacted_support_guard', '20261008130000_stage10_analytics_maintenance_tasks', '20261008150000_stage10_partial_usage_coverage', '20261009100000_stage11_automation_action_order', '20261009110000_stage12_alexa_oauth_scope']);
  for (const migration of fs.readdirSync(path.join(tempRoot, 'prisma/migrations')).filter((name) => /^\d/.test(name) && !stage6MigrationNames.has(name)).sort()) {
    fs.cpSync(path.join(tempRoot, 'prisma/migrations', migration), path.join(stage6PriorMigrationsDirectory, migration), { recursive: true });
  }
  const stage6PriorSchema = path.join(stage6PriorPrismaDirectory, 'schema.prisma');
  fs.writeFileSync(stage6PriorSchema, 'datasource db {\n  provider = "postgresql"\n  url = env("DIRECT_URL")\n}\n');
  const stage6PriorEnv = { ...localEnv, DATABASE_URL: priorStage6DatabaseUrl, DIRECT_URL: priorStage6DatabaseUrl };
  run(localPrisma, ['migrate', 'deploy', '--schema', stage6PriorSchema], { cwd: priorStage6MigrationRoot, env: stage6PriorEnv });
  const priorStage6Count = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage6', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  if (priorStage6Count !== '23') throw new Error(`Stage 6 upgrade proof did not reconstruct the exact 23-migration Production head (observed ${priorStage6Count})`);
  const preservedAccountId = crypto.randomUUID();
  const preservedDeviceId = crypto.randomUUID();
  const preservedSessionId = crypto.randomUUID();
  const preservedChallengeId = crypto.randomUUID();
  const preservedRefreshHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const preservedChallengeHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const stage6PreservationSql = `
INSERT INTO "CustomerAccount" ("id","displayName","username","usernameNormalized","email","emailNormalized","passwordHash","updatedAt") VALUES
  ('${preservedAccountId}','Stage 6 schema fixture','stage6-owner-${preservedAccountId.slice(0, 8)}','stage6-owner-${preservedAccountId.slice(0, 8)}','stage6-${preservedAccountId}@example.invalid','stage6-${preservedAccountId}@example.invalid','disposable-not-authenticatable',CURRENT_TIMESTAMP);
INSERT INTO "TrustedDevice" ("id","customerAccountId","deviceInstallationId","publicKey","publicKeyThumbprint","deviceName","updatedAt") VALUES
  ('${preservedDeviceId}','${preservedAccountId}','stage6-device-${preservedAccountId.slice(0, 8)}','disposable-public-key','disposable-thumbprint','Disposable schema fixture',CURRENT_TIMESTAMP);
INSERT INTO "CustomerSession" ("id","customerAccountId","trustedDeviceId","refreshTokenHash","securityVersion","expiresAt","updatedAt") VALUES
  ('${preservedSessionId}','${preservedAccountId}','${preservedDeviceId}','${preservedRefreshHash}',1,CURRENT_TIMESTAMP + INTERVAL '7 days',CURRENT_TIMESTAMP);
INSERT INTO "AuthChallenge" ("id","customerAccountId","purpose","tokenHash","expiresAt") VALUES
  ('${preservedChallengeId}','${preservedAccountId}','EMAIL_VERIFICATION','${preservedChallengeHash}',CURRENT_TIMESTAMP + INTERVAL '10 minutes');
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage6', '-v', 'ON_ERROR_STOP=1'], stage6PreservationSql);
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: stage6PriorEnv });
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: stage6PriorEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: stage6PriorEnv });
  const preservedStage6Rows = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage6', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE s."id" = '${preservedSessionId}' AND s."refreshTokenHash" = '${preservedRefreshHash}' AND s."sessionFamilyId" = s."id" AND s."absoluteExpiresAt" = s."issuedAt" + INTERVAL '180 days' AND s."accessTokenHash" IS NULL AND s."accessTokenExpiresAt" IS NULL), count(*) FILTER (WHERE c."id" = '${preservedChallengeId}' AND c."deliveryStatus" = 'PENDING') FROM "CustomerSession" s CROSS JOIN "AuthChallenge" c WHERE s."id" = '${preservedSessionId}' AND c."id" = '${preservedChallengeId}'`]).trim();
  if (preservedStage6Rows !== '1|1') throw new Error('Stage 6 upgrade changed seeded session/challenge authority or failed to initialize additive session fields safely');
  console.log('[clean-clone:check] PASS: exact 23-migration Stage 5 Production head upgraded/reapplied idempotently through the reviewed Stage 6 migration bundle; seeded account/device/session/challenge survived with isolated refresh-family defaults, null app-access credentials and APNs fields');

  // Prove Stage 8 from the exact preceding Stage 7/Stage 6 schema, including
  // an existing in-progress customer request. The additive change must retain
  // its provenance/status while introducing only nullable linkage fields.
  run('docker', ['exec', dockerName, 'createdb', '-U', 'postgres', 'dinodia_v2_prior_stage8']);
  const stage8PriorPrismaDirectory = path.join(priorStage8MigrationRoot, 'prisma');
  const stage8PriorMigrationsDirectory = path.join(stage8PriorPrismaDirectory, 'migrations');
  fs.mkdirSync(stage8PriorMigrationsDirectory, { recursive: true });
  fs.writeFileSync(path.join(stage8PriorMigrationsDirectory, 'migration_lock.toml'), '# Please do not edit this file manually.\n# This file should be committed to your version control system.\nprovider = "postgresql"\n');
  const stage8MigrationName = '20261006180000_stage8_commissioning_and_installation';
  const stage9MigrationName = '20261008100000_stage9_deregister_redacted_support_guard';
  const stage10MigrationName = '20261008130000_stage10_analytics_maintenance_tasks';
  const stage10CoverageMigrationName = '20261008150000_stage10_partial_usage_coverage';
  const stage11MigrationName = '20261009100000_stage11_automation_action_order';
  const stage12MigrationName = '20261009110000_stage12_alexa_oauth_scope';
  for (const migration of fs.readdirSync(path.join(tempRoot, 'prisma/migrations')).filter((name) => /^\d/.test(name) && name !== stage8MigrationName && name !== stage9MigrationName && name !== stage10MigrationName && name !== stage10CoverageMigrationName && name !== stage11MigrationName && name !== stage12MigrationName).sort()) {
    fs.cpSync(path.join(tempRoot, 'prisma/migrations', migration), path.join(stage8PriorMigrationsDirectory, migration), { recursive: true });
  }
  const stage8PriorSchema = path.join(stage8PriorPrismaDirectory, 'schema.prisma');
  fs.writeFileSync(stage8PriorSchema, 'datasource db {\n  provider = "postgresql"\n  url = env("DIRECT_URL")\n}\n');
  const stage8PriorEnv = { ...localEnv, DATABASE_URL: priorStage8DatabaseUrl, DIRECT_URL: priorStage8DatabaseUrl };
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  const stage8PriorCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  if (stage8PriorCount !== '29') throw new Error(`Stage 8 upgrade proof did not reconstruct the exact 29-migration Stage 7 schema (observed ${stage8PriorCount})`);
  const stage8HomeId = '00000000-0000-4000-8000-000000008001';
  const stage8AccountId = '00000000-0000-4000-8000-000000008002';
  const stage8MembershipId = '00000000-0000-4000-8000-000000008003';
  const stage8RequestId = '00000000-0000-4000-8000-000000008004';
  const stage8PreservationSql = `
INSERT INTO "CustomerAccount" ("id","displayName","username","usernameNormalized","email","emailNormalized","passwordHash","updatedAt") VALUES
  ('${stage8AccountId}','Stage 8 migration fixture','stage8-prior-owner','stage8-prior-owner','stage8-prior-owner@example.invalid','stage8-prior-owner@example.invalid','disposable-not-authenticatable',CURRENT_TIMESTAMP);
INSERT INTO "Home" ("id","lifecycle","installationStatus","updatedAt") VALUES
  ('${stage8HomeId}','INSTALLING','IN_PROGRESS',CURRENT_TIMESTAMP);
INSERT INTO "HomeMembership" ("id","customerAccountId","homeId","role","status","updatedAt") VALUES
  ('${stage8MembershipId}','${stage8AccountId}','${stage8HomeId}','OWNER','ACTIVE',CURRENT_TIMESTAMP);
INSERT INTO "PermanentDeviceInstallationRequest" ("id","customerReference","homeId","requesterMembershipId","category","customerNotes","status","revision","operationsEmailKey","updatedAt") VALUES
  ('${stage8RequestId}','DIN-STAGE8-MIGRATION','${stage8HomeId}','${stage8MembershipId}','LIGHTING','Preservation marker only','IN_PROGRESS',3,'stage8-migration-preservation-key',CURRENT_TIMESTAMP);
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage8PreservationSql);
  fs.cpSync(path.join(tempRoot, 'prisma/migrations', stage8MigrationName), path.join(stage8PriorMigrationsDirectory, stage8MigrationName), { recursive: true });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  const stage8AppliedCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  if (stage8AppliedCount !== '30') throw new Error(`Stage 8 schema proof did not land on its exact 30-migration head (observed ${stage8AppliedCount})`);

  const stage9TicketId = '00000000-0000-4000-8000-000000008005';
  const stage9InvalidTicketId = '00000000-0000-4000-8000-000000008006';
  const stage9AccountOnlyTicketId = '00000000-0000-4000-8000-000000008007';
  const stage9SupportTicketSql = `
INSERT INTO "SupportTicket" ("id","publicReference","customerAccountId","homeId","selectedMembershipId","status","category","description","updatedAt") VALUES
  ('${stage9TicketId}','DIN-STAGE9-SUPPORT-KEEP','${stage8AccountId}','${stage8HomeId}','${stage8MembershipId}','OPEN','ACCOUNT','Disposable preservation row',CURRENT_TIMESTAMP);
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage9SupportTicketSql);
  fs.cpSync(path.join(tempRoot, 'prisma/migrations', stage9MigrationName), path.join(stage8PriorMigrationsDirectory, stage9MigrationName), { recursive: true });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: stage8PriorEnv });
  const stage9RedactionSql = `
UPDATE "SupportTicket" SET "status"='CLOSED',"customerAccountId"=NULL,"selectedMembershipId"=NULL,"description"='[Closed and redacted after full-home deregistration]',"title"=NULL,"closedAt"=CURRENT_TIMESTAMP WHERE "id"='${stage9TicketId}';
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage9RedactionSql);
  const stage9RedactedTicket = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT (SELECT count(*) FROM "SupportTicket" WHERE "id"='${stage9TicketId}' AND "homeId"='${stage8HomeId}' AND "customerAccountId" IS NULL AND "selectedMembershipId" IS NULL AND "status"='CLOSED' AND "description"='[Closed and redacted after full-home deregistration]'), (SELECT count(*) FROM "PermanentDeviceInstallationRequest" WHERE "id"='${stage8RequestId}' AND "status"='IN_PROGRESS' AND "revision"=3), (SELECT count(*) FROM "HomeMembership" WHERE "id"='${stage8MembershipId}' AND "status"='ACTIVE')`]).trim();
  if (stage9RedactedTicket !== '1|1|1') throw new Error('Stage 9 trigger migration failed to preserve and safely redact the support row alongside the in-progress request and membership');
  const stage9InvalidTicketSql = `
DO $$ BEGIN
  BEGIN
    INSERT INTO "SupportTicket" ("id","publicReference","customerAccountId","homeId","selectedMembershipId","status","category","description","updatedAt") VALUES
      ('${stage9InvalidTicketId}','DIN-STAGE9-SUPPORT-DENY','${stage8AccountId}','${stage8HomeId}',NULL,'OPEN','ACCOUNT','Must remain rejected',CURRENT_TIMESTAMP);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'stage9_expected_invalid_scope_was_accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'stage9_expected_invalid_scope_was_accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%support ticket membership must belong to the ticket customer and home%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "SupportTicket" ("id","publicReference","customerAccountId","homeId","selectedMembershipId","status","category","description","updatedAt") VALUES
      ('${stage9AccountOnlyTicketId}','DIN-STAGE9-ACCOUNT-ONLY','${stage8AccountId}',NULL,NULL,'OPEN','ACCOUNT','Must remain rejected',CURRENT_TIMESTAMP);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'stage9_expected_account_scope_was_accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'stage9_expected_account_scope_was_accepted' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%support ticket membership must belong to the ticket customer and home%' THEN RAISE; END IF;
  END;
END $$;
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage9InvalidTicketSql);
  const stage9DeniedTicketCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', `SELECT count(*) FROM "SupportTicket" WHERE "id" IN ('${stage9InvalidTicketId}','${stage9AccountOnlyTicketId}')`]).trim();
  if (stage9DeniedTicketCount !== '0') throw new Error('Stage 9 support-ticket scope guard admitted an account/Home ticket without a matching membership');
  const maintenanceBefore = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE "taskId"='expired_dispatch_lease_cleanup' AND "dispatcher"='MAINTENANCE'), count(*) FILTER (WHERE "taskId" IN ('retentionCleanup','analyticsAndStorageMaintenance')) FROM "NativeBackgroundTaskState"`]).trim();
  if (maintenanceBefore !== '1|0') throw new Error(`Stage 9 pre-Stage-10 dispatcher registry is unexpected (${maintenanceBefore})`);
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], `UPDATE "NativeBackgroundTaskState" SET "cursor"='{"preservation":"stage10"}'::jsonb,"consecutiveFailures"=2,"lastCompletedAt"=CURRENT_TIMESTAMP WHERE "taskId"='expired_dispatch_lease_cleanup';`);
  const preservedMaintenanceBefore = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT "cursor"::text,"consecutiveFailures",("lastCompletedAt" IS NOT NULL)::text FROM "NativeBackgroundTaskState" WHERE "taskId"='expired_dispatch_lease_cleanup'`]).trim();
  fs.cpSync(path.join(tempRoot, 'prisma/migrations', stage10MigrationName), path.join(stage8PriorMigrationsDirectory, stage10MigrationName), { recursive: true });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: stage8PriorEnv });
  const usageHomeId = stage8HomeId;
  const usageHubIdentityId = '00000000-0000-4000-8000-000000008008';
  const usageHubId = '00000000-0000-4000-8000-000000008009';
  const usageAreaId = '00000000-0000-4000-8000-000000008010';
  const usageDeviceId = '00000000-0000-4000-8000-000000008011';
  const usageBucketId = '00000000-0000-4000-8000-000000008012';
  const legacyPartialUsageSql = `
INSERT INTO "HubManufacturingIdentity" ("id","serialNumber","signingPublicKey","encryptionPublicKey","signingKeyFingerprint","encryptionKeyFingerprint","updatedAt") VALUES
  ('${usageHubIdentityId}','stage10-partial-coverage','disposable-signing-public','disposable-encryption-public','stage10-sign-${usageHubIdentityId}','stage10-enc-${usageHubIdentityId}',CURRENT_TIMESTAMP);
INSERT INTO "HubInstallation" ("id","homeId","manufacturingIdentityId","serialNumberSnapshot","state","updatedAt") VALUES
  ('${usageHubId}','${usageHomeId}','${usageHubIdentityId}','stage10-partial-coverage','ACTIVE',CURRENT_TIMESTAMP);
INSERT INTO "Area" ("id","homeId","osAreaId","originalName","updatedAt") VALUES
  ('${usageAreaId}','${usageHomeId}','stage10-partial-coverage','Stage 10 coverage fixture',CURRENT_TIMESTAMP);
INSERT INTO "NativeDevice" ("id","homeId","hubInstallationId","osDeviceId","originalName","technicalLabel","managementClass","deviceType","analyticsCategory","lifecycle","updatedAt") VALUES
  ('${usageDeviceId}','${usageHomeId}','${usageHubId}','stage10-partial-coverage','Coverage fixture','Radiator','PROPERTY_DEVICE','test-radiator','RADIATOR','INSTALLED',CURRENT_TIMESTAMP);
INSERT INTO "NativeDeviceUsageBucket" ("id","homeId","deviceId","areaId","analyticsCategory","controlId","bucketStart","sourceGeneration","revision","onSeconds","offSeconds","unknownSeconds","closedAt","purgeAt","updatedAt") VALUES
  ('${usageBucketId}','${usageHomeId}','${usageDeviceId}','${usageAreaId}','RADIATOR','heating','2026-10-05 10:00:00',1,1,120,0,1680,NULL,'2027-10-05 10:00:00',CURRENT_TIMESTAMP);
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], legacyPartialUsageSql);
  fs.cpSync(path.join(tempRoot, 'prisma/migrations', stage10CoverageMigrationName), path.join(stage8PriorMigrationsDirectory, stage10CoverageMigrationName), { recursive: true });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: stage8PriorEnv });
  const stage10AppliedCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  const maintenanceAfter = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE "taskId"='expired_dispatch_lease_cleanup' AND "dispatcher"='MAINTENANCE'), count(*) FILTER (WHERE "taskId" IN ('retentionCleanup','analyticsAndStorageMaintenance') AND "dispatcher"='MAINTENANCE'), (SELECT count(*) FROM "NativeBackgroundTaskState" WHERE "taskId"='expired_dispatch_lease_cleanup' AND "cursor"='{"preservation":"stage10"}'::jsonb AND "consecutiveFailures"=2 AND "lastCompletedAt" IS NOT NULL) FROM "NativeBackgroundTaskState"`]).trim();
  const preservedMaintenanceAfter = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT "cursor"::text,"consecutiveFailures",("lastCompletedAt" IS NOT NULL)::text FROM "NativeBackgroundTaskState" WHERE "taskId"='expired_dispatch_lease_cleanup'`]).trim();
  if (stage10AppliedCount !== '33' || maintenanceAfter !== '1|2|1' || preservedMaintenanceAfter !== preservedMaintenanceBefore) throw new Error(`Stage 10 migration failed idempotency/registry preservation (migrations=${stage10AppliedCount}, tasks=${maintenanceAfter}, priorTaskStatePreserved=${preservedMaintenanceAfter === preservedMaintenanceBefore})`);
  const preservedLegacyPartial = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT "onSeconds"::text,"offSeconds"::text,"unknownSeconds"::text,("closedAt" IS NULL)::text,("coverageStartAt" IS NULL)::text,("coverageEndAt" IS NULL)::text FROM "NativeDeviceUsageBucket" WHERE "id"='${usageBucketId}'`]).trim();
  if (preservedLegacyPartial !== '120|0|1680|true|true|true') throw new Error(`Stage 10 coverage migration did not preserve the existing open partial-hour row and its explicit legacy-null coverage representation (observed=${preservedLegacyPartial || 'missing'})`);
  const partialCloseSql = `UPDATE "NativeDeviceUsageBucket" SET "coverageStartAt"='2026-10-05 10:30:00',"coverageEndAt"='2026-10-05 11:00:00',"closedAt"='2026-10-05 11:00:00',"updatedAt"=CURRENT_TIMESTAMP WHERE "id"='${usageBucketId}';`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], partialCloseSql);
  const acceptedPartialClose = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE "onSeconds"=120 AND "offSeconds"=0 AND "unknownSeconds"=1680 AND "coverageStartAt"='2026-10-05 10:30:00' AND "coverageEndAt"='2026-10-05 11:00:00' AND "closedAt"='2026-10-05 11:00:00') FROM "NativeDeviceUsageBucket" WHERE "id"='${usageBucketId}'`]).trim();
  if (acceptedPartialClose !== '1') throw new Error('Stage 10 migration failed to admit the exact 1,800-second closed partial-hour coverage');
  const invalidPartialCloseSql = `DO $$ BEGIN BEGIN UPDATE "NativeDeviceUsageBucket" SET "coverageEndAt"='2026-10-05 11:00:00.001' WHERE "id"='${usageBucketId}'; RAISE EXCEPTION 'stage10_expected_coverage_mismatch_rejection'; EXCEPTION WHEN check_violation THEN NULL; END; END $$;`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], invalidPartialCloseSql);
  const exactPartialStillPresent = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE "onSeconds"=120 AND "unknownSeconds"=1680 AND "coverageEndAt"='2026-10-05 11:00:00') FROM "NativeDeviceUsageBucket" WHERE "id"='${usageBucketId}'`]).trim();
  if (exactPartialStillPresent !== '1') throw new Error('Stage 10 coverage constraint accepted a mismatched millisecond span or changed the preserved row');
  // The 33-migration Stage 10 fingerprint must be compared with an independent
  // empty Stage 10 database, not the current 34-migration Stage 11 schema.
  // The latter intentionally adds Stage 11 columns and an index.
  const stage10EmptyDatabase = 'dinodia_v2_empty_stage10';
  const stage10EmptyDatabaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/${stage10EmptyDatabase}`;
  run('docker', ['exec', dockerName, 'createdb', '-U', 'postgres', stage10EmptyDatabase]);
  const stage10EmptyEnv = { ...localEnv, DATABASE_URL: stage10EmptyDatabaseUrl, DIRECT_URL: stage10EmptyDatabaseUrl };
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage10EmptyEnv });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage10EmptyEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: stage10EmptyEnv });
  const stage10EmptySchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: stage10EmptyEnv }));
  const stage10UpgradeSchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: stage8PriorEnv }));
  if (!stage10EmptySchema.fingerprint || stage10UpgradeSchema.fingerprint !== stage10EmptySchema.fingerprint) throw new Error('Stage 10 prior-head upgrade does not match the independent empty Stage 10 schema fingerprint');
  console.log(`[clean-clone:check] PASS: exact Stage 9 head upgraded and replayed both Stage 10 migrations to ${stage10UpgradeSchema.fingerprint}; maintenance task state and a pre-existing partial-hour row survived, exact 1,800-second close succeeded, and a 1ms mismatch was rejected`);
  const stage8Preserved = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE r."id"='${stage8RequestId}' AND r."customerReference"='DIN-STAGE8-MIGRATION' AND r."homeId"='${stage8HomeId}' AND r."requesterMembershipId"='${stage8MembershipId}' AND r."requesterAccountId" IS NULL AND r."category"='LIGHTING' AND r."status"='IN_PROGRESS' AND r."revision"=3 AND r."operationsEmailKey"='stage8-migration-preservation-key'), count(*) FILTER (WHERE h."id"='${stage8HomeId}' AND h."lifecycle"='INSTALLING'), count(*) FILTER (WHERE a."id"='${stage8AccountId}') FROM "PermanentDeviceInstallationRequest" r CROSS JOIN "Home" h CROSS JOIN "CustomerAccount" a WHERE r."id"='${stage8RequestId}' AND h."id"='${stage8HomeId}' AND a."id"='${stage8AccountId}'`]).trim();
  if (stage8Preserved !== '1|1|1') throw new Error('Stage 8 upgrade changed existing request provenance/status or failed to retain its Home/account rows');
  console.log('[clean-clone:check] PASS: exact Stage 7 head upgraded through Stage 8 and Stage 9; support-ticket redaction and invalid live-scope denial were proven while in-progress request/Home/account rows remained preserved');

  // Stage 11 is applied from the exact 33-migration Stage 10 head.
  // Seed a live permanent-device rule before applying the additive action-order
  // and redacted-property-impact migration, then prove the rule, children and
  // creator survive, the order is backfilled, the privacy marker is derived,
  // and reapplying both the SQL and migration deploy remains harmless.
  const stage11PriorCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  if (stage11PriorCount !== '33') throw new Error(`Stage 11 migration proof did not reconstruct the exact 33-migration Stage 10 head (observed ${stage11PriorCount})`);
  const stage11AutomationId = '00000000-0000-4000-8000-000000008013';
  const stage11TriggerId = '00000000-0000-4000-8000-000000008014';
  const stage11ActionId = '00000000-0000-4000-8000-000000008015';
  const stage11RuleSql = `
INSERT INTO "NativeAutomation" ("id","homeId","createdByMembershipId","name","status","revision","definitionChecksum","timezone","enabledAt","createdAt","updatedAt") VALUES
  ('${stage11AutomationId}','${stage8HomeId}','${stage8MembershipId}','Stage 11 migration preservation','ACTIVE',1,'${'a'.repeat(64)}','Europe/London',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "NativeAutomationTrigger" ("id","automationId","kind","configuration","revision","createdAt","updatedAt") VALUES
  ('${stage11TriggerId}','${stage11AutomationId}','SCHEDULE','{"minuteOfDay":420,"weekdays":[1]}',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "NativeAutomationAction" ("id","homeId","automationId","deviceId","areaId","controlId","descriptorRevision","actionValue","needsAttention","createdAt","updatedAt") VALUES
  ('${stage11ActionId}','${stage8HomeId}','${stage11AutomationId}','${usageDeviceId}','${usageAreaId}','power',1,'{"type":"boolean","boolean":true}',false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage11RuleSql);
  fs.cpSync(path.join(tempRoot, 'prisma/migrations', stage11MigrationName), path.join(stage8PriorMigrationsDirectory, stage11MigrationName), { recursive: true });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  const stage11PreservedRule = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE automation."id"='${stage11AutomationId}' AND automation."homeId"='${stage8HomeId}' AND automation."createdByMembershipId"='${stage8MembershipId}' AND automation."status"='ACTIVE' AND automation."propertyImpact"=true), count(*) FILTER (WHERE trigger."id"='${stage11TriggerId}' AND trigger."automationId"='${stage11AutomationId}'), count(*) FILTER (WHERE action."id"='${stage11ActionId}' AND action."automationId"='${stage11AutomationId}' AND action."sortOrder"=0) FROM "NativeAutomation" automation JOIN "NativeAutomationTrigger" trigger ON trigger."automationId"=automation."id" JOIN "NativeAutomationAction" action ON action."automationId"=automation."id" WHERE automation."id"='${stage11AutomationId}'`]).trim();
  if (stage11PreservedRule !== '1|1|1') throw new Error(`Stage 11 migration did not preserve/backfill the seeded definition and children (${stage11PreservedRule || 'missing'})`);
  const stage11Sql = fs.readFileSync(path.join(tempRoot, 'prisma/migrations', stage11MigrationName, 'migration.sql'), 'utf8');
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage11Sql);
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage11Sql);
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  const stage11AppliedCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  const stage11PreservedAfterReplay = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE automation."id"='${stage11AutomationId}' AND automation."createdByMembershipId"='${stage8MembershipId}' AND automation."propertyImpact"=true), count(*) FILTER (WHERE action."id"='${stage11ActionId}' AND action."sortOrder"=0) FROM "NativeAutomation" automation JOIN "NativeAutomationAction" action ON action."automationId"=automation."id" WHERE automation."id"='${stage11AutomationId}'`]).trim();
  const stage11UpgradeSchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: stage8PriorEnv }));
  const stage11EmptyDatabase = 'dinodia_v2_empty_stage11';
  const stage11EmptyDatabaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/${stage11EmptyDatabase}`;
  run('docker', ['exec', dockerName, 'createdb', '-U', 'postgres', stage11EmptyDatabase]);
  const stage11EmptyEnv = { ...localEnv, DATABASE_URL: stage11EmptyDatabaseUrl, DIRECT_URL: stage11EmptyDatabaseUrl };
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage11EmptyEnv });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage11EmptyEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: stage11EmptyEnv });
  const stage11EmptySchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: stage11EmptyEnv }));
  if (stage11AppliedCount !== '34' || stage11PreservedAfterReplay !== '1|1' || stage11UpgradeSchema.fingerprint !== stage11EmptySchema.fingerprint) throw new Error(`Stage 11 migration reapplication changed the exact schema head or seeded automation rows (migrations=${stage11AppliedCount}, preserved=${stage11PreservedAfterReplay}, schemaMatchesIndependentEmpty=${stage11UpgradeSchema.fingerprint === stage11EmptySchema.fingerprint})`);
  console.log('[clean-clone:check] PASS: exact 33-migration Stage 10 head upgraded to 34 migrations; seeded live automation, trigger, action, creator and property-impact classification survived; sort order backfilled; SQL replay and Prisma migration reapplication were idempotent');

  // Stage 12 adds normalized Alexa Area selections and OAuth lifecycle tables.
  // Start from the exact 34-migration Stage 11 schema and preserve a valid
  // linked-tenant scope plus a revoked legacy scope. A malformed legacy
  // compatibility cache is deliberately seeded only in this disposable DB
  // with its old trigger briefly disabled; the new migration must select only
  // the one current canonical Area grant and must not revive revoked scope.
  const stage12PriorCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  if (stage12PriorCount !== '34') throw new Error(`Stage 12 migration proof did not start from the exact 34-migration Stage 11 head (observed ${stage12PriorCount})`);
  const stage12AccountId = '00000000-0000-4000-8000-000000008016';
  const stage12MembershipId = '00000000-0000-4000-8000-000000008017';
  const stage12LinkId = '00000000-0000-4000-8000-000000008018';
  const stage12ScopeId = '00000000-0000-4000-8000-000000008019';
  const stage12RevokedAccountId = '00000000-0000-4000-8000-000000008020';
  const stage12RevokedMembershipId = '00000000-0000-4000-8000-000000008021';
  const stage12RevokedLinkId = '00000000-0000-4000-8000-000000008022';
  const stage12RevokedScopeId = '00000000-0000-4000-8000-000000008023';
  const stage12ValidScopeSql = `
INSERT INTO "CustomerAccount" ("id","displayName","username","usernameNormalized","email","emailNormalized","emailVerifiedAt","passwordHash","updatedAt") VALUES
  ('${stage12AccountId}','Stage 12 Alexa migration fixture','stage12-tenant-a','stage12-tenant-a','stage12-tenant-a@example.invalid','stage12-tenant-a@example.invalid',CURRENT_TIMESTAMP,'disposable-not-authenticatable',CURRENT_TIMESTAMP),
  ('${stage12RevokedAccountId}','Stage 12 revoked Alexa migration fixture','stage12-tenant-b','stage12-tenant-b','stage12-tenant-b@example.invalid','stage12-tenant-b@example.invalid',CURRENT_TIMESTAMP,'disposable-not-authenticatable',CURRENT_TIMESTAMP);
INSERT INTO "HomeMembership" ("id","customerAccountId","homeId","role","status","updatedAt") VALUES
  ('${stage12MembershipId}','${stage12AccountId}','${stage8HomeId}','TENANT','ACTIVE',CURRENT_TIMESTAMP),
  ('${stage12RevokedMembershipId}','${stage12RevokedAccountId}','${stage8HomeId}','TENANT','ACTIVE',CURRENT_TIMESTAMP);
INSERT INTO "TenantAreaGrant" ("id","membershipId","areaId","homeId","grantedAt","updatedAt") VALUES
  ('00000000-0000-4000-8000-000000008024','${stage12MembershipId}','${usageAreaId}','${stage8HomeId}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000008025','${stage12RevokedMembershipId}','${usageAreaId}','${stage8HomeId}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "AlexaNativeLink" ("id","customerAccountId","providerSubjectHash","accessTokenCiphertext","refreshTokenCiphertext","encryptionKeyVersion","status","accessTokenExpiresAt","updatedAt") VALUES
  ('${stage12LinkId}','${stage12AccountId}','${'a'.repeat(64)}','disposable-ciphertext-a','disposable-refresh-ciphertext-a',1,'ACTIVE',CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP),
  ('${stage12RevokedLinkId}','${stage12RevokedAccountId}','${'b'.repeat(64)}','disposable-ciphertext-b','disposable-refresh-ciphertext-b',1,'ACTIVE',CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP);
INSERT INTO "AlexaNativeHomeScope" ("id","linkId","homeId","membershipId","areaIds","exposureGeneration","createdAt","updatedAt") VALUES
  ('${stage12ScopeId}','${stage12LinkId}','${stage8HomeId}','${stage12MembershipId}','["${usageAreaId}"]'::jsonb,7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('${stage12RevokedScopeId}','${stage12RevokedLinkId}','${stage8HomeId}','${stage12RevokedMembershipId}','["${usageAreaId}"]'::jsonb,4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
UPDATE "AlexaNativeHomeScope" SET "revokedAt"=CURRENT_TIMESTAMP WHERE "id"='${stage12RevokedScopeId}';
ALTER TABLE "AlexaNativeHomeScope" DISABLE TRIGGER "AlexaNativeHomeScope_tenant_guard";
UPDATE "AlexaNativeHomeScope" SET "areaIds"=jsonb_build_array('${usageAreaId}','not-a-uuid','00000000-0000-4000-8000-000000008026') WHERE "id"='${stage12ScopeId}';
ALTER TABLE "AlexaNativeHomeScope" ENABLE TRIGGER "AlexaNativeHomeScope_tenant_guard";
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-v', 'ON_ERROR_STOP=1'], stage12ValidScopeSql);
  fs.cpSync(path.join(tempRoot, 'prisma/migrations', stage12MigrationName), path.join(stage8PriorMigrationsDirectory, stage12MigrationName), { recursive: true });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  run(localPrisma, ['migrate', 'deploy', '--schema', stage8PriorSchema], { cwd: priorStage8MigrationRoot, env: stage8PriorEnv });
  const stage12AppliedCount = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-c', 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL']).trim();
  const stage12SelectionPreserved = capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_prior_stage8', '-At', '-F', '|', '-c', `SELECT count(*) FILTER (WHERE selection."homeScopeId"='${stage12ScopeId}' AND selection."areaId"='${usageAreaId}' AND selection."exposureGeneration"=7 AND selection."revokedAt" IS NULL), count(*) FILTER (WHERE selection."homeScopeId"='${stage12RevokedScopeId}'), count(*) FILTER (WHERE scope."id"='${stage12ScopeId}' AND scope."areaIds"=jsonb_build_array('${usageAreaId}','not-a-uuid','00000000-0000-4000-8000-000000008026') AND scope."exposureGeneration"=7), count(*) FILTER (WHERE link."id"='${stage12LinkId}' AND link."providerSubjectHash"='${'a'.repeat(64)}') FROM "AlexaNativeAreaSelection" selection RIGHT JOIN "AlexaNativeHomeScope" scope ON scope."id" IN ('${stage12ScopeId}','${stage12RevokedScopeId}') LEFT JOIN "AlexaNativeLink" link ON link."id"=scope."linkId" WHERE selection."homeScopeId"=scope."id" OR selection."id" IS NULL`]).trim();
  const stage12UpgradeSchema = JSON.parse(capture('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: stage8PriorEnv }));
  if (stage12AppliedCount !== '35' || stage12SelectionPreserved !== '1|0|1|1' || stage12UpgradeSchema.fingerprint !== firstEmptyFingerprint) throw new Error(`Stage 12 migration changed legacy scope, revived a revoked/invalid Area, failed idempotent deploy, or diverged from empty schema (migrations=${stage12AppliedCount}, scope=${stage12SelectionPreserved}, schemaMatchesEmpty=${stage12UpgradeSchema.fingerprint === firstEmptyFingerprint})`);
  console.log(`[clean-clone:check] PASS: exact 34-migration Stage 11 head upgraded to Stage 12 and deploy replay was idempotent; valid selected Area and exposure generation were preserved, malformed/ungranted IDs and revoked scope were not promoted, seeded scope/link rows survived, and schema matched empty head ${stage12UpgradeSchema.fingerprint}`);

  // Independently prove the additive Stage 1 upgrade from the exact committed
  // foundation schema as a second compatibility path. This database is
  // created inside the disposable local Docker cluster; parent DATABASE_URL,
  // DIRECT_URL, Vercel and Supabase credentials are never inherited.
  run('docker', ['exec', dockerName, 'createdb', '-U', 'postgres', 'dinodia_v2_foundation_upgrade']);
  const foundationSql = fs.readFileSync(path.join(tempRoot, 'prisma/migrations/00000000000000_native_v2_lean_foundation/migration.sql'), 'utf8');
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_foundation_upgrade', '-v', 'ON_ERROR_STOP=1'], foundationSql);
  const upgradeEnv = { ...localEnv, DATABASE_URL: upgradeDatabaseUrl, DIRECT_URL: upgradeDatabaseUrl };
  run('npx', ['prisma', 'migrate', 'resolve', '--applied', '00000000000000_native_v2_lean_foundation'], { cwd: tempRoot, env: upgradeEnv });
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: upgradeEnv });
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: tempRoot, env: upgradeEnv });
  console.log('[clean-clone:check] PASS: separate foundation-only PostgreSQL database upgraded through all Stage 1 migrations and reapplied idempotently');

  run('npm', ['run', 'check:stage1'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/stage3_domain_checks.mjs'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/foundation_invariants.mjs'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'test:stage1:db'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'lint'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'typecheck'], { cwd: tempRoot, env: localEnv });
  run('npm', ['test'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'build'], { cwd: tempRoot, env: localEnv });
  // A pre-Stage-3 binary expects the old migration head and cannot be a
  // rollback after this additive schema is installed. Rehearse the exact
  // Stage 11-based schema-compatible recovery source and the forward candidate against the
  // SAME migrated disposable database, with retained rows between them.
  const rollbackArchive = execFileSync('git', ['archive', '--format=tar', schemaCompatibleRollbackCommit], { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024 });
  runWithInput('tar', ['-xf', '-', '-C', rollbackRoot], rollbackArchive);
  // Rehearse the exact reviewed Stage 11 compatibility candidate, whose source
  // explicitly accepts the additive Stage 12 migration for readiness. Do not
  // synthesize a rollback by copying a readiness shim over an older artifact.
  // Next/Turbopack will not compile a node_modules symlink outside this
  // isolated source root. Install the immutable HEAD snapshot independently.
  run('npm', ['ci'], { cwd: rollbackRoot, env: { ...safeProcessEnvironment(), CI: '1', NODE_ENV: 'test' } });
  fs.mkdirSync(path.join(rollbackRoot, '.vercel'), { recursive: true });
  fs.copyFileSync(path.join(tempRoot, '.vercel/project.json'), path.join(rollbackRoot, '.vercel/project.json'));
  const migrationChecksum = crypto.createHash('sha256').update(fs.readFileSync(path.join(tempRoot, 'prisma/migrations/20261003000000_native_v2_stage3_domain_schema/migration.sql'))).digest('hex');
  const applicationEnv = { ...localEnv, NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://dinodia-platform-v2.vercel.app', FOUNDATION_MIGRATION_CHECKSUM: migrationChecksum };
  run('npm', ['run', 'build'], { cwd: rollbackRoot, env: applicationEnv });
  const markerId = crypto.randomUUID();
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_foundation', '-v', 'ON_ERROR_STOP=1'], `INSERT INTO "Home" ("id", "lifecycle", "installationStatus", "updatedAt") VALUES ('${markerId}', 'INSTALLING', 'DRAFT', CURRENT_TIMESTAMP);`);
  const markerCount = () => capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_foundation', '-At', '-c', `SELECT count(*) FROM "Home" WHERE "id" = '${markerId}'`]).trim();
  if (markerCount() !== '1') throw new Error('disposable rollback preservation marker could not be seeded');
  const rollbackFixture = {
    accountId: crypto.randomUUID(),
    allowedHomeId: crypto.randomUUID(),
    privateHomeId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    trustedDeviceId: crypto.randomUUID(),
    privateHomeMarker: `rollback-private-home-${crypto.randomBytes(16).toString('hex')}`,
  };
  const rollbackFixtureSql = `
INSERT INTO "CustomerAccount" ("id","displayName","username","usernameNormalized","email","emailNormalized","emailVerifiedAt","passwordHash","updatedAt") VALUES
  ('${rollbackFixture.accountId}','Rollback owner','rollback-owner-${rollbackFixture.accountId.slice(0, 8)}','rollback-owner-${rollbackFixture.accountId.slice(0, 8)}','rollback-${rollbackFixture.accountId}@example.invalid','rollback-${rollbackFixture.accountId}@example.invalid',CURRENT_TIMESTAMP,'disposable-not-authenticatable',CURRENT_TIMESTAMP);
INSERT INTO "Home" ("id","addressLine1","lifecycle","installationStatus","updatedAt") VALUES
  ('${rollbackFixture.allowedHomeId}','Allowed rollback home','INSTALLING','DRAFT',CURRENT_TIMESTAMP),
  ('${rollbackFixture.privateHomeId}','${rollbackFixture.privateHomeMarker}','INSTALLING','DRAFT',CURRENT_TIMESTAMP);
INSERT INTO "HomeMembership" ("id","customerAccountId","homeId","role","status","updatedAt") VALUES
  ('${rollbackFixture.membershipId}','${rollbackFixture.accountId}','${rollbackFixture.allowedHomeId}','OWNER','ACTIVE',CURRENT_TIMESTAMP);
INSERT INTO "TrustedDevice" ("id","customerAccountId","deviceInstallationId","publicKey","publicKeyThumbprint","deviceName","updatedAt") VALUES
  ('${rollbackFixture.trustedDeviceId}','${rollbackFixture.accountId}','rollback-device-${rollbackFixture.accountId.slice(0, 8)}','disposable-public-key','disposable-thumbprint','Rollback test device',CURRENT_TIMESTAMP);
`;
  runWithInput('docker', ['exec', '-i', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_foundation', '-v', 'ON_ERROR_STOP=1'], rollbackFixtureSql);
  const disposableRows = () => capture('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_foundation', '-At', '-c', `SELECT (SELECT count(*) FROM "Home" WHERE "id" IN ('${markerId}','${rollbackFixture.allowedHomeId}','${rollbackFixture.privateHomeId}')) || ':' || (SELECT count(*) FROM "CustomerAccount" WHERE "id"='${rollbackFixture.accountId}') || ':' || (SELECT count(*) FROM "CustomerSession" WHERE "customerAccountId"='${rollbackFixture.accountId}')`]).trim();
  if (disposableRows() !== '3:1:0') throw new Error('disposable rollback fixture rows could not be verified before rehearsal');
  await probeApplication(rollbackRoot, applicationEnv, rollbackFixture);
  if (markerCount() !== '1') throw new Error('schema-compatible rollback application changed the disposable preservation marker');
  if (disposableRows() !== '3:1:2') throw new Error('schema-compatible rollback application changed the authenticated disposable preservation fixture');
  await probeApplication(tempRoot, applicationEnv, rollbackFixture);
  if (markerCount() !== '1') throw new Error('forward-recovered application changed the disposable preservation marker');
  if (disposableRows() !== '3:1:4') throw new Error('forward-recovered application changed the authenticated disposable preservation fixture');
  console.log(`[clean-clone:check] PASS: exact Stage 11-based schema-compatible recovery source ${schemaCompatibleRollbackCommit.slice(0, 12)} and forward candidate both returned readiness 200, anonymous session 401, protected Stage 11 automation route 401, authenticated account-session 200 and wrong-home 403 without private disclosure on the same additive schema; all seeded rows survived`);
  run('npm', ['run', 'test:stage1'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: localEnv });
  console.log(`[clean-clone:check] OK: reconstructed ${files.length} intended files, installed, migrated, tested and built in ${tempRoot}`);
} finally {
  cleanup();
}
