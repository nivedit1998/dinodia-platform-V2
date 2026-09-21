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

function projectRefFromUrl(url) {
  const directRef = projectRefFromHost(url.hostname);
  if (directRef) return directRef;
  if (/\.pooler\.supabase\.com$/i.test(url.hostname)) {
    const username = decodeURIComponent(url.username || '');
    const match = username.match(/^(?:postgres\.)?([a-z0-9]{20})$/i);
    return match?.[1] || '';
  }
  return '';
}

function databaseNameFromUrl(url, name) {
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!databaseName) fail(`${name} does not include a database name`);
  return databaseName;
}

function isApprovedRemoteHost(url) {
  return target.supabaseDatabaseHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase());
}

function assertLocalTarget(url, name) {
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  const isApprovedV2 = projectRefFromUrl(url) === target.supabaseProjectRef;
  if (!isLoopback && !isApprovedV2) {
    fail(`${name} does not point to localhost or the approved V2 Supabase project`);
  }
}

function assertRemoteTarget(url, name) {
  if (!isApprovedRemoteHost(url)) {
    fail(`${name} does not use an approved V2 Supabase database host`);
  }
  if (projectRefFromUrl(url) !== target.supabaseProjectRef) {
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
if (mode === 'production') {
  fail('production mode is not allowed by the guarded RC command');
}
if (process.env.NODE_ENV === 'production') {
  fail('NODE_ENV=production is not allowed by the guarded RC command');
}

const remoteMigration = ['rc', 'production'].includes(mode) || process.argv.includes('--remote-migration');

const databaseUrl = parseDatabaseUrl('DATABASE_URL');
const directUrl = parseDatabaseUrl('DIRECT_URL');
if (mode === 'local' || mode === 'test') {
  const databaseName = databaseUrl.pathname.replace(/^\//, '');
  const directName = directUrl.pathname.replace(/^\//, '');
  if (databaseName !== directName) fail('DATABASE_URL and DIRECT_URL must use the same database name');
} else {
  if (projectRefFromUrl(databaseUrl) !== projectRefFromUrl(directUrl)) {
    fail('DATABASE_URL and DIRECT_URL must resolve to the same Supabase project');
  }
  if (databaseNameFromUrl(databaseUrl, 'DATABASE_URL') !== databaseNameFromUrl(directUrl, 'DIRECT_URL')) {
    fail('DATABASE_URL and DIRECT_URL must resolve to the same database');
  }
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
if (remoteMigration && explicitRef !== target.supabaseProjectRef) {
  fail('SUPABASE_PROJECT_REF must explicitly identify the approved V2 project for remote work');
}

if (value('VERCEL_PROJECT_ID') && value('VERCEL_PROJECT_ID') !== target.vercelProjectId) {
  fail('VERCEL_PROJECT_ID does not match the approved V2 project');
}
if (remoteMigration && value('VERCEL_PROJECT_ID') !== target.vercelProjectId) {
  fail('VERCEL_PROJECT_ID must explicitly identify the approved V2 project for remote work');
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
