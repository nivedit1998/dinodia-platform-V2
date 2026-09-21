import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetPath = path.join(repoRoot, 'scripts', 'v2-target.json');
const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : process.env.V2_ENVIRONMENT;
const runPrisma = process.argv.includes('--run-prisma');
const remoteConfirmation = 'I_UNDERSTAND_NEW_V2_DATABASE';

function fail(message) {
  console.error(`[v2-target] BLOCKED: ${message}`);
  process.exit(1);
}

function value(name) {
  return process.env[name]?.trim() || '';
}

function parseDatabaseUrl(name) {
  const raw = value(name);
  if (!raw) fail(`${name} is missing`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${name} is not a valid database URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail(`${name} must use PostgreSQL`);
  }
  return parsed;
}

function projectRefFromHost(hostname) {
  const direct = hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i);
  return direct?.[1] || '';
}

function isApprovedDatabaseHost(hostname) {
  return Array.isArray(target.supabaseDatabaseHosts)
    ? target.supabaseDatabaseHosts.includes(hostname)
    : projectRefFromHost(hostname) === target.supabaseProjectRef;
}

function assertLocalTarget(url, name) {
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  const isApprovedV2 = isApprovedDatabaseHost(url.hostname);
  if (!isLoopback && !isApprovedV2) {
    fail(`${name} does not point to localhost or the approved V2 Supabase project`);
  }
}

function assertRemoteTarget(url, name) {
  if (!isApprovedDatabaseHost(url.hostname)) {
    fail(`${name} does not point to the approved V2 Supabase project`);
  }
}

function assertVercelLink() {
  const projectPath = path.join(repoRoot, '.vercel', 'project.json');
  if (!fs.existsSync(projectPath)) fail('Vercel project link is missing');
  const linked = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  if (linked.projectId !== target.vercelProjectId || linked.orgId !== target.vercelOrgId) {
    fail('local Vercel link does not match the approved V2 project');
  }
}

if (!mode || !['local', 'test', 'rc', 'production'].includes(mode)) {
  fail('V2_ENVIRONMENT must be local, test, rc or production');
}

const remoteMigration = ['rc', 'production'].includes(mode) || process.argv.includes('--remote-migration');

const databaseUrl = parseDatabaseUrl('DATABASE_URL');
const directUrl = parseDatabaseUrl('DIRECT_URL');
if (databaseUrl.hostname !== directUrl.hostname) {
  fail('DATABASE_URL and DIRECT_URL must resolve to the same approved host');
}

if (mode === 'local' || mode === 'test') {
  assertLocalTarget(databaseUrl, 'DATABASE_URL');
  assertLocalTarget(directUrl, 'DIRECT_URL');
} else {
  assertRemoteTarget(databaseUrl, 'DATABASE_URL');
  assertRemoteTarget(directUrl, 'DIRECT_URL');
  if (process.env.V2_ALLOW_REMOTE_MIGRATION !== remoteConfirmation) {
    fail('remote migration requires V2_ALLOW_REMOTE_MIGRATION=I_UNDERSTAND_NEW_V2_DATABASE');
  }
}

const explicitRef = value('SUPABASE_PROJECT_REF');
if (explicitRef && explicitRef !== target.supabaseProjectRef) {
  fail('SUPABASE_PROJECT_REF does not match the approved V2 project');
}

if (value('VERCEL_PROJECT_ID') && value('VERCEL_PROJECT_ID') !== target.vercelProjectId) {
  fail('VERCEL_PROJECT_ID does not match the approved V2 project');
}

if (['rc', 'production'].includes(mode) || value('VERCEL_PROJECT_ID')) {
  assertVercelLink();
}

console.log(JSON.stringify({
  ok: true,
  environment: mode,
  supabaseProjectRef: target.supabaseProjectRef,
  vercelProjectName: target.vercelProjectName,
  remoteMigration,
}));

if (runPrisma) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}
