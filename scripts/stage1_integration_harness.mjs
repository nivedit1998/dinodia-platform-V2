import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const osRoot = process.env.DINODIA_OS_ROOT || path.resolve(root, '../Dinodia OS');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-stage1-integration-'));
const dockerName = `dinodia-stage1-${process.pid}`;
const dbPort = String(55520 + (process.pid % 100));
const appPort = String(55620 + (process.pid % 100));
const databasePassword = 'stage1-integration-only';
const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dbPort}/dinodia_stage1`;
const migration = fs.readdirSync(path.join(root, 'prisma/migrations')).sort().at(-1);
const migrationChecksum = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'prisma/migrations', migration, 'migration.sql'))).digest('hex');
let databaseStarted = false;
let platformProcess;
let hub;

function fail(message) { throw new Error(`[stage1:integration] ${message}`); }
function run(command, args, envOrOptions = process.env) {
  const options = envOrOptions && (envOrOptions.env || envOrOptions.cwd) ? envOrOptions : { env: envOrOptions };
  const result = spawnSync(command, args, { cwd: options.cwd || root, env: options.env || process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-4000);
    fail(`${command} ${args.join(' ')} failed with exit ${result.status ?? 1}${detail ? `: ${detail}` : ''}`);
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await sleep(250);
  }
  fail(`${label} did not become ready`);
}
function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
function baseEnv() {
  const company = keyPair();
  const app = keyPair();
  const operator = keyPair();
  const manufacturing = keyPair();
  return {
    ...process.env,
    CI: '1', NODE_ENV: 'production', V2_ENVIRONMENT: 'test',
    DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl,
    SUPABASE_PROJECT_REF: 'fppzzesvukjbsfmxmfxe', VERCEL_PROJECT_ID: 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y',
    NEXT_PUBLIC_APP_URL: 'https://dinodia-platform-v2.vercel.app', NEXT_PUBLIC_SUPABASE_URL: 'https://fppzzesvukjbsfmxmfxe.supabase.co',
    FOUNDATION_MIGRATION_CHECKSUM: migrationChecksum, FOUNDATION_SOURCE_FINGERPRINT: 'stage1-integration-harness',
    JWT_SECRET: crypto.randomBytes(32).toString('base64url'), PLATFORM_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    CLAIM_REFERENCE_PEPPER: crypto.randomBytes(32).toString('base64url'), AUDIT_LOG_HASH_SALT: crypto.randomBytes(32).toString('base64url'),
    CRON_SECRET: crypto.randomBytes(32).toString('base64url'), STAGE1_CONTRACT_SECRET: crypto.randomBytes(32).toString('base64url'),
    COMPANY_PORTAL_SESSION_PRIVATE_KEY: company.privateKey, COMPANY_PORTAL_SESSION_PUBLIC_KEYS: company.publicKey,
    DINODIA_APP_SESSION_PRIVATE_KEY: app.privateKey, DINODIA_APP_PUBLIC_KEYS: app.publicKey,
    OPERATOR_SESSION_PRIVATE_KEY: operator.privateKey, MANUFACTURING_ROOT_PUBLIC_KEYS: manufacturing.publicKey,
    MANUFACTURING_ENROLLMENT_OPERATOR_PUBLIC_KEYS: company.publicKey, COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET: crypto.randomBytes(32).toString('base64url'),
  };
}
async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  return { response, body: await response.json().catch(() => ({})) };
}
async function platformChecks() {
  const base = `http://127.0.0.1:${appPort}`;
  const health = await fetchJson(`${base}/api/health`);
  if (health.response.status !== 200 || health.body.ok !== true) fail(`Platform health returned ${health.response.status}`);
  const readiness = await fetchJson(`${base}/api/readiness`);
  if (readiness.response.status !== 200 || readiness.body.ready !== true) fail(`Platform readiness returned ${readiness.response.status} (${JSON.stringify(readiness.body)})`);
  if ((await fetch(`${base}/`)).status !== 200) fail('Platform root did not return 200');
  if ((await fetch(`${base}/definitely-not-a-route`)).status !== 404) fail('Platform unknown route did not return 404');
  if ((await fetch(`${base}/api/cron/native-operations`, { method: 'POST' })).status !== 401) fail('Unauthenticated cron route was not denied');
  if ((await fetch(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationKind: 'support_ticket_close', targetIds: ['ticket'] }) })).status !== 401) fail('Unauthenticated app route was not denied');
  if ((await fetch(`${base}/api/hub-agent/v2/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serial: 'unauthenticated', identityGeneration: 1 }) })).status !== 401) fail('Unauthenticated hub route was not denied');
}
async function osChecks() {
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const setup = await fetch(`${base}/setup`, { headers: { host: '127.0.0.1' } });
  if (setup.status !== 200) fail(`OS locked setup returned ${setup.status}`);
  const setupPage = await setup.text();
  if (!setupPage.includes('Dinodia OS') && !setupPage.includes('data-empty')) fail('OS setup did not serve the locked setup surface');
  if ((await fetch(`${base}/api/status`, { headers: { host: '127.0.0.1' } })).status !== 401) fail('OS unauthenticated API was not denied');
  if ((await fetch(`${base}/_dinodia/setup/status`, { headers: { host: '127.0.0.1' } })).status !== 403) fail('OS second browser was not locked');
  const WebSocket = createRequire(import.meta.url)(path.join(osRoot, 'node_modules/ws'));
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/websocket`, { headers: { host: '127.0.0.1' } });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('unauthenticated OS WebSocket did not close')); }, 5000);
    socket.on('message', (value) => { try { if (JSON.parse(String(value)).type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: 'DINODIA_ADMIN_TOKEN' })); } catch {} });
    socket.on('close', () => { clearTimeout(timer); resolve(); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
async function cleanup() {
  if (hub) await hub.stop().catch(() => {});
  if (platformProcess) { platformProcess.kill('SIGTERM'); await sleep(500); if (!platformProcess.killed) platformProcess.kill('SIGKILL'); }
  if (databaseStarted) spawnSync('docker', ['rm', '-f', dockerName], { stdio: 'ignore' });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const env = baseEnv();
try {
  run('docker', ['run', '-d', '--name', dockerName, '-e', `POSTGRES_PASSWORD=${databasePassword}`, '-e', 'POSTGRES_DB=dinodia_stage1', '-p', `127.0.0.1:${dbPort}:5432`, 'postgres:16-alpine']);
  databaseStarted = true;
  await waitFor(() => spawnSync('docker', ['exec', dockerName, 'pg_isready', '-U', 'postgres', '-d', 'dinodia_stage1'], { stdio: 'ignore' }).status === 0, 'PostgreSQL');
  run('npx', ['prisma', 'migrate', 'deploy'], env);
  // Always build the current source before starting the real server. A stale
  // .next directory must never turn this behavioural gate into a test of an
  // older candidate.
  run('npm', ['run', 'build'], env);
  platformProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', appPort], { cwd: root, env, stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${appPort}/api/health`)).status === 200; } catch { return false; } }, 'Platform server');
  const dataDir = path.join(tempRoot, 'os-data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(osRoot, 'node_modules', 'ws'))) {
    run('npm', ['ci', '--ignore-scripts'], { cwd: osRoot, env: { ...process.env, CI: '1', NODE_ENV: 'test' } });
  }
  const operator = keyPair();
  const { createHub } = await import(pathToFileURL(path.join(osRoot, 'src/server.js')).href);
  hub = createHub({
    config: { nodeEnv: 'production', hubId: 'dinodia-stage1-harness', haPort: 0, hubAgentPort: 0, dataDir, dataFile: path.join(dataDir, 'dinodia.json'), backupDir: path.join(dataDir, 'backups'), staticDir: path.join(osRoot, 'public'), operatorPublicKey: operator.publicKey, appPublicKeys: env.DINODIA_APP_PUBLIC_KEYS, platformApiUrl: 'https://dinodia-platform-v2.vercel.app', nativeAutomationsMode: 'off', hiveEnabled: false, googleNestEnabled: false, cloudflarePublicHostname: '' },
    logger: { error() {}, warn() {}, log() {} },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, hostname: '' }; } },
  });
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  await platformChecks();
  await osChecks();
  console.log('[stage1:integration] PASS: live Platform routes, locked Dinodia OS HTTP, browser isolation and native WebSocket denial exercised against disposable PostgreSQL');
} finally {
  await cleanup();
}

function pathToFileURL(file) { return new URL(`file://${file.split(path.sep).map(encodeURIComponent).join('/')}`); }
