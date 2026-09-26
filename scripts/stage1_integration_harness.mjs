import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { Prisma, PrismaClient } from '@prisma/client';
import { stage1RouteInventory } from '../test/stage1_route_inventory.mjs';

const root = process.cwd();
const osRoot = process.env.DINODIA_OS_ROOT || path.resolve(root, '../Dinodia OS');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-stage1-integration-'));
const outboundTargetFile = path.join(tempRoot, 'outbound-targets.log');
fs.writeFileSync(outboundTargetFile, '', { mode: 0o600 });
const dockerName = `dinodia-stage1-${process.pid}`;
async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
  if (!port) throw new Error('Could not allocate a disposable loopback port');
  return String(port);
}
const dbPort = await findFreePort();
const appPort = await findFreePort();
const sesPort = await findFreePort();
const databasePassword = 'stage1-integration-only';
const harnessHubInstallationId = '00000000-0000-4000-8000-000000000001';
const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dbPort}/dinodia_stage1`;
const migration = fs.readdirSync(path.join(root, 'prisma/migrations')).sort().at(-1);
const migrationChecksum = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'prisma/migrations', migration, 'migration.sql'))).digest('hex');
let databaseStarted = false;
let platformProcess;
let hub;
let prisma;
let seededWork;
let sesServer;
let sesShouldFail = false;
let capturedInvitation;
let customerFixture;
let fakePhysicalCommandCount = 0;
const outboundTargets = new Set();

function fail(message) { throw new Error(`[stage1:integration] ${message}`); }
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const parsed = new URL(typeof input === 'string' ? input : input.url);
  outboundTargets.add(`${parsed.protocol}//${parsed.host}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) fail(`Harness attempted an outbound request to ${parsed.hostname}`);
  return nativeFetch(input, init);
};
function safeProcessEnvironment(source = process.env) {
  // The integration harness is routinely run from a developer shell that may
  // contain Production/Vercel/Supabase/SES credentials.  Never inherit that
  // shell wholesale into a child server or test process.  Keep only values
  // required to start Node/npm and deliberately set all test configuration in
  // baseEnv()/deliveryEnv below.
  const safe = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']) {
    if (source[name]) safe[name] = source[name];
  }
  return safe;
}
function loadOperatorLifecycleService() {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(root, 'src/lib/hubOperatorCredentials.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === './prisma') return { prisma };
    if (specifier === './stage1Crypto') return { randomSecret: (bytes = 32) => crypto.randomBytes(bytes).toString('base64url'), sha256 };
    if (specifier === '@prisma/client') return { Prisma };
    return require(specifier);
  };
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
function assertParentCredentialsAreNotForwarded() {
  const fakeParent = {
    ...process.env,
    AWS_ACCESS_KEY_ID: 'AKIAFAKEPRODUCTIONKEY',
    AWS_SECRET_ACCESS_KEY: 'fake-production-secret',
    DATABASE_URL: 'postgresql://production.example.invalid/should-not-forward',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'fake-vercel-secret',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-supabase-service-role',
  };
  const isolated = safeProcessEnvironment(fakeParent);
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'VERCEL_AUTOMATION_BYPASS_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (Object.prototype.hasOwnProperty.call(isolated, name)) fail(`Sensitive parent environment variable was forwarded: ${name}`);
  }
  const guard = path.join(root, 'scripts/stage1_loopback_guard.mjs');
  const probeLog = path.join(tempRoot, 'egress-probe.log');
  const blockedProbe = spawnSync(process.execPath, ['-e', "fetch('https://not-allowed.example.invalid').then(() => process.exit(2), (error) => { if (!String(error.message).includes('restricted to loopback')) process.exit(3); })"], {
    encoding: 'utf8',
    env: { ...isolated, NODE_OPTIONS: `--import=${JSON.stringify(guard)}`, STAGE1_OUTBOUND_TARGET_LOG: probeLog },
  });
  if (blockedProbe.status !== 0) fail('The child-process egress guard did not block a real-looking external destination before network access');
}
function run(command, args, envOrOptions = null) {
  const options = envOrOptions && (envOrOptions.env || envOrOptions.cwd) ? envOrOptions : { env: envOrOptions };
  const result = spawnSync(command, args, { cwd: options.cwd || root, env: options.env || safeProcessEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
const harnessManufacturingRoot = keyPair();
function x25519KeyPair() {
  const pair = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
function publicKeyFingerprint(pem) {
  return crypto.createHash('sha256').update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex');
}
const harnessProvisioningSigning = keyPair();
const harnessProvisioningEncryption = x25519KeyPair();
const harnessProvisioningSerial = 'din-home-harness-001';
const harnessProvisioningIdentity = {
  serial: harnessProvisioningSerial,
  generation: 1,
  signingPublicKeyPem: harnessProvisioningSigning.publicKey,
  encryptionPublicKeyPem: harnessProvisioningEncryption.publicKey,
  publicKeyFingerprint: publicKeyFingerprint(harnessProvisioningSigning.publicKey),
  encryptionKeyFingerprint: publicKeyFingerprint(harnessProvisioningEncryption.publicKey),
};
const harnessManufacturingCertificate = JSON.stringify({
  serial: harnessProvisioningIdentity.serial,
  identityGeneration: harnessProvisioningIdentity.generation,
  publicKeyPem: harnessProvisioningIdentity.signingPublicKeyPem,
  encryptionPublicKeyPem: harnessProvisioningIdentity.encryptionPublicKeyPem,
  publicKeyFingerprint: harnessProvisioningIdentity.publicKeyFingerprint,
  encryptionKeyFingerprint: harnessProvisioningIdentity.encryptionKeyFingerprint,
});
const harnessManufacturingSignature = crypto.sign(null, Buffer.from(harnessManufacturingCertificate, 'utf8'), crypto.createPrivateKey(harnessManufacturingRoot.privateKey)).toString('base64url');
function decryptHubEnvelope(envelope, privateKeyPem, purpose, version) {
  if (!envelope || envelope.algorithm !== 'x25519-hkdf-sha256/aes-256-gcm' || envelope.purpose !== purpose || Number(envelope.version) !== Number(version)) throw new Error('test identity broker rejected an envelope outside its fixed purpose');
  const ephemeralPublicKey = crypto.createPublicKey(String(envelope.ephemeralPublicKeyPem || ''));
  if (ephemeralPublicKey.asymmetricKeyType !== 'x25519') throw new Error('test identity broker rejected a non-X25519 envelope');
  const shared = crypto.diffieHellman({ privateKey: crypto.createPrivateKey(privateKeyPem), publicKey: ephemeralPublicKey });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(`dinodia-os-${purpose}`), Buffer.from(String(version)), 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv), 'base64'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext), 'base64')), decipher.final()]).toString('utf8');
}
function updateCookieJar(jar, response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const first = String(value).split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator > 0) jar[first.slice(0, separator)] = first.slice(separator + 1);
  }
  return jar;
}
function cookieHeader(jar) {
  return Object.entries(jar).filter(([, value]) => value !== '').map(([name, value]) => `${name}=${value}`).join('; ');
}
function cookieValue(jar, name) {
  return String(jar[name] || '');
}
function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
function claimReferenceHash(value, pepper) { return crypto.createHmac('sha256', String(pepper)).update(String(value), 'utf8').digest('hex'); }
function canonicalHubRequest({ method, path: requestPath, timestamp, nonce, bodyHash }) {
  return [String(method).toUpperCase(), String(requestPath), String(timestamp), String(nonce), String(bodyHash).toLowerCase()].join('\n');
}
function supportProofOfPossessionDigest({ employeeProofHash, serial, ticketId, requestId, codeHash, identityGeneration }) {
  return sha256(JSON.stringify({ version: 1, employeeProofHash: String(employeeProofHash), serial: String(serial), ticketId: String(ticketId), requestId: String(requestId), codeHash: String(codeHash), identityGeneration: Number(identityGeneration) }));
}
function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function descriptorBoundValue(value, descriptorDigests = {}) {
  const ordered = Object.fromEntries(Object.entries(descriptorDigests).sort(([left], [right]) => left.localeCompare(right)).map(([id, digest]) => [String(id), digest == null ? null : String(digest)]));
  return { requestedValue: value ?? null, descriptorDigests: ordered };
}
function operationDigest({ actorId, trustedDeviceId, customerSessionId, homeId, membershipId, hubInstallationId, operationKind, targetIds, value }) {
  return sha256(canonicalValue({ actorId: String(actorId), trustedDeviceId: String(trustedDeviceId), customerSessionId: String(customerSessionId), homeId: String(homeId), membershipId: String(membershipId), hubInstallId: String(hubInstallationId), operationKind: String(operationKind), targetIds: targetIds.map(String).sort(), value }));
}
function stepUpChallengeMessage({ challengeId, nonce, operationDigest }) {
  return Buffer.from(`DINODIA_STEP_UP_CHALLENGE_V1\n${challengeId}\n${nonce}\n${operationDigest}`, 'utf8');
}
function machineRequest({ base, path: requestPath, body, machineSecret, machineVersion = 1 }) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = `harness-machine-${crypto.randomUUID()}`;
  const bodyHash = sha256(raw);
  const machineSignature = crypto.createHmac('sha256', sha256(machineSecret)).update(canonicalHubRequest({ method: 'POST', path: requestPath, timestamp, nonce, bodyHash }), 'utf8').digest('base64url');
  return fetchJson(`${base}${requestPath}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-machine-version': String(machineVersion), 'x-dinodia-machine-signature': machineSignature, 'x-dinodia-hub-timestamp': timestamp, 'x-dinodia-hub-nonce': nonce, 'x-dinodia-body-sha256': bodyHash }, body: raw });
}
function baseEnv() {
  const company = keyPair();
  const app = keyPair();
  const operator = keyPair();
  return {
    ...safeProcessEnvironment(),
    CI: '1', NODE_ENV: 'production', V2_ENVIRONMENT: 'test',
    NEXT_TELEMETRY_DISABLED: '1', PRISMA_TELEMETRY_DISABLED: '1', CHECKPOINT_DISABLE: '1',
    NODE_OPTIONS: `--import=${JSON.stringify(path.join(root, 'scripts/stage1_loopback_guard.mjs'))}`,
    STAGE1_OUTBOUND_TARGET_LOG: outboundTargetFile,
    // Empty values must be explicit: Next loads .env.local in the child
    // process, and an omitted variable would allow the developer's real SES
    // configuration to leak back into this disposable server.
    AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_REGION: '',
    SES_FROM_EMAIL: '', COMPANY_PORTAL_INITIAL_CXO_EMAIL: '', SES_TEST_ENDPOINT: '',
    DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl,
    SUPABASE_PROJECT_REF: 'fppzzesvukjbsfmxmfxe', VERCEL_PROJECT_ID: 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y',
    NEXT_PUBLIC_APP_URL: 'https://dinodia-platform-v2.vercel.app', NEXT_PUBLIC_SUPABASE_URL: 'https://fppzzesvukjbsfmxmfxe.supabase.co',
    FOUNDATION_MIGRATION_CHECKSUM: migrationChecksum, FOUNDATION_SOURCE_FINGERPRINT: 'stage1-integration-harness',
    JWT_SECRET: crypto.randomBytes(32).toString('base64url'), PLATFORM_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    CLAIM_REFERENCE_PEPPER: crypto.randomBytes(32).toString('base64url'), AUDIT_LOG_HASH_SALT: crypto.randomBytes(32).toString('base64url'),
    CRON_SECRET: crypto.randomBytes(32).toString('base64url'), STAGE1_CONTRACT_SECRET: crypto.randomBytes(32).toString('base64url'),
    COMPANY_PORTAL_SESSION_PRIVATE_KEY: company.privateKey, COMPANY_PORTAL_SESSION_PUBLIC_KEYS: company.publicKey,
    DINODIA_APP_SESSION_PRIVATE_KEY: app.privateKey, DINODIA_APP_PUBLIC_KEYS: app.publicKey,
    OPERATOR_SESSION_PRIVATE_KEY: operator.privateKey, MANUFACTURING_ROOT_PUBLIC_KEYS: harnessManufacturingRoot.publicKey,
    MANUFACTURING_ENROLLMENT_OPERATOR_PUBLIC_KEYS: company.publicKey, COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET: crypto.randomBytes(32).toString('base64url'),
  };
}
function verifyChildOutboundTargets() {
  const lines = fs.readFileSync(outboundTargetFile, 'utf8').split('\n').filter(Boolean);
  const denied = lines.filter((line) => line.startsWith('DENIED\t'));
  if (denied.length) fail(`An integration child attempted non-loopback egress (${denied.map((line) => line.split('\t')[1]).join(',')})`);
  const allowed = new Set();
  for (const line of lines) {
    const [disposition, host, port] = line.split('\t');
    if (disposition !== 'ALLOWED' || !['127.0.0.1', 'localhost', '::1'].includes(host.replace(/^\[|\]$/g, '').toLowerCase())) fail(`Integration child target escaped the loopback allow-list (${host})`);
    allowed.add(`${host}:${port}`);
  }
  return [...allowed].sort();
}
async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  return { response, body: await response.json().catch(() => ({})) };
}
async function loginEmployee(base, employee, password) {
  const jar = {};
  const login = await fetchJson(`${base}/api/company/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: employee.email, password }) });
  updateCookieJar(jar, login.response);
  const token = cookieValue(jar, 'dinodia_employee_session');
  if (login.response.status !== 200 || !token) fail(`Real employee login failed (${login.response.status}/${login.body.errorCode || 'missing-cookie'})`);
  const session = await prisma.employeeSession.findFirst({ where: { employeeId: employee.id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!session) fail('Real employee login did not create a durable session');
  return { token, jar, session };
}

async function startFakeSes() {
  sesServer = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!sesShouldFail) capturedInvitation = body.match(/#invitation=([A-Za-z0-9_-]+)/)?.[1] || capturedInvitation;
      response.statusCode = sesShouldFail ? 500 : 200;
      response.setHeader('content-type', 'application/json');
      response.end(sesShouldFail ? '{}' : JSON.stringify({ MessageId: 'stage1-test-message' }));
    });
  });
  await new Promise((resolve, reject) => {
    sesServer.once('error', reject);
    sesServer.listen(Number(sesPort), '127.0.0.1', resolve);
  });
}

function assertLoopbackTestEndpoint(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('test mail endpoint is not a valid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    fail(`test mail endpoint is not loopback: ${parsed.hostname}`);
  }
}

async function stopPlatform() {
  if (!platformProcess) return;
  platformProcess.kill('SIGTERM');
  await sleep(500);
  if (!platformProcess.killed) platformProcess.kill('SIGKILL');
  platformProcess = undefined;
}

async function startPlatform(runEnv) {
  platformProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', appPort], { cwd: root, env: runEnv, stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${appPort}/api/health`)).status === 200; } catch { return false; } }, 'Platform server');
}

async function bootstrapDeliveryChecks(runEnv) {
  const base = `http://127.0.0.1:${appPort}`;
  const headers = { 'content-type': 'application/json', 'x-dinodia-initial-cxo-secret': runEnv.COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET };
  const wrongRecipient = await fetchJson(`${base}/api/company/auth/bootstrap`, { method: 'POST', headers, body: JSON.stringify({ displayName: 'Wrong recipient', email: 'wrong@example.test' }) });
  if (wrongRecipient.response.status !== 400) fail(`Bootstrap accepted a wrong recipient (${wrongRecipient.response.status})`);
  sesShouldFail = true;
  const failed = await fetchJson(`${base}/api/company/auth/bootstrap`, { method: 'POST', headers, body: JSON.stringify({ displayName: 'Harness CXO', email: runEnv.COMPANY_PORTAL_INITIAL_CXO_EMAIL }) });
  if (failed.response.status !== 503 || failed.body.errorCode !== 'bootstrap_delivery_failed') fail(`Bootstrap delivery failure was not recoverable (${failed.response.status}/${failed.body.errorCode})`);
  const failedState = await prisma.initialCxoBootstrap.findUnique({ where: { ceremonyKey: 'initial-cxo-v1' }, select: { deliveryStatus: true, deliveryAttempts: true } });
  if (failedState?.deliveryStatus !== 'FAILED' || Number(failedState.deliveryAttempts) !== 1) fail('Failed bootstrap delivery did not persist its bounded retry state');
  sesShouldFail = false;
  const retried = await fetchJson(`${base}/api/company/auth/bootstrap/retry`, { method: 'POST', headers: { 'x-dinodia-initial-cxo-secret': runEnv.COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET } });
  if (retried.response.status !== 200 || retried.body.delivery !== 'sent' || !capturedInvitation) fail(`Bootstrap retry did not deliver through the server mailer (${retried.response.status})`);
  if (JSON.stringify(retried.body).includes(capturedInvitation)) fail('Bootstrap response revealed the invitation token');
  const sentState = await prisma.initialCxoBootstrap.findUnique({ where: { ceremonyKey: 'initial-cxo-v1' }, select: { deliveryStatus: true, deliveryAttempts: true } });
  if (sentState?.deliveryStatus !== 'SENT' || Number(sentState.deliveryAttempts) !== 2) fail('Bootstrap retry did not converge to SENT');
  const expiredAt = new Date(Date.now() - 1000);
  const pendingEmployee = await prisma.companyEmployeeAccount.findFirst({ where: { status: 'PENDING', emailNormalized: runEnv.COMPANY_PORTAL_INITIAL_CXO_EMAIL }, select: { id: true } });
  if (!pendingEmployee) fail('Bootstrap delivery test did not leave the disposable employee pending before completion');
  await prisma.initialCxoBootstrap.update({ where: { ceremonyKey: 'initial-cxo-v1' }, data: { invitationExpiresAt: expiredAt } });
  await prisma.companyEmployeeAccount.update({ where: { id: pendingEmployee.id }, data: { bootstrapInvitationExpiresAt: expiredAt } });
  const expiredCompletion = await fetchJson(`${base}/api/company/auth/bootstrap/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invitation: capturedInvitation, username: 'harness-cxo-expired', password: 'stage1-test-password-that-is-long' }) });
  if (expiredCompletion.response.status !== 401) fail(`Expired bootstrap invitation was accepted (${expiredCompletion.response.status})`);
  const concurrentRetries = await Promise.all([
    fetchJson(`${base}/api/company/auth/bootstrap/retry`, { method: 'POST', headers: { 'x-dinodia-initial-cxo-secret': runEnv.COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET } }),
    fetchJson(`${base}/api/company/auth/bootstrap/retry`, { method: 'POST', headers: { 'x-dinodia-initial-cxo-secret': runEnv.COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET } }),
  ]);
  const successfulRetries = concurrentRetries.filter((entry) => entry.response.status === 200);
  if (successfulRetries.length !== 1 || concurrentRetries.some((entry) => ![200, 409, 503].includes(entry.response.status))) fail(`Concurrent bootstrap retries did not have one durable winner (${concurrentRetries.map((entry) => entry.response.status).join('/')})`);
  if (!capturedInvitation) fail('Concurrent bootstrap retry did not capture a replacement invitation');
  const complete = await fetchJson(`${base}/api/company/auth/bootstrap/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invitation: capturedInvitation, username: 'harness-cxo', password: 'stage1-test-password-that-is-long' }) });
  if (complete.response.status !== 201 || complete.body.employee?.role !== 'CXO') fail(`Bootstrap completion failed (${complete.response.status}/${complete.body.errorCode})`);
  const replay = await fetchJson(`${base}/api/company/auth/bootstrap/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invitation: capturedInvitation, username: 'harness-cxo-replay', password: 'stage1-test-password-that-is-long' }) });
  if (![401, 409].includes(replay.response.status)) fail(`Bootstrap invitation replay was accepted (${replay.response.status})`);
  const consumed = await prisma.initialCxoBootstrap.findUnique({ where: { ceremonyKey: 'initial-cxo-v1' }, select: { deliveryStatus: true, consumedAt: true } });
  if (consumed?.deliveryStatus !== 'CONSUMED' || !consumed.consumedAt) fail('Bootstrap completion did not consume the durable ceremony');
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
  if ((await fetch(`${base}/api/installer/workflows`)).status !== 401) fail('Unauthenticated work-list route was not denied');
  if ((await fetch(`${base}/api/installer/workflows`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ attemptId: 'unauthenticated', assignedEmployeeId: crypto.randomUUID(), kind: 'INITIAL_HUB_INSTALLATION', reason: 'denial test' }) })).status !== 401) fail('Unauthenticated work-assignment route was not denied');
  await protectedRouteDenialChecks(base);
  // The local harness deliberately omits mail-provider configuration. The
  // bootstrap capability must fail closed before creating an employee or
  // invitation, and must not require a live mailbox during engineering tests.
  const bootstrap = await fetchJson(`${base}/api/company/auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-initial-cxo-secret': env.COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET }, body: JSON.stringify({ displayName: 'Harness CXO', email: 'niveditgupta@dinodiasmartliving.com' }) });
  if (bootstrap.response.status !== 503 || bootstrap.body.errorCode !== 'bootstrap_unavailable') fail(`Bootstrap did not fail closed without delivery configuration (${bootstrap.response.status}/${bootstrap.body.errorCode})`);
  const pendingCountSql = `SELECT (SELECT COUNT(*) FROM "CompanyEmployeeAccount")::text || '/' || (SELECT COUNT(*) FROM "InitialCxoBootstrap")::text`;
  const pendingCount = spawnSync('docker', ['exec', dockerName, 'psql', '-U', 'postgres', '-d', 'dinodia_stage1', '-At', '-c', pendingCountSql], { encoding: 'utf8' }).stdout.trim();
  if (pendingCount !== '0/0') fail(`Bootstrap created durable rows before delivery configuration (${pendingCount})`);

  // Generate the pairing code through the actual locked Dinodia OS setup page.
  // The successful path must not manufacture HubProvisioningAttempt or use its
  // internal attemptId as browser authority.
  const hubPort = hub.server.address().port;
  const hubBase = `http://127.0.0.1:${hubPort}`;
  const setupJar = {};
  const setupPage = await fetch(`${hubBase}/setup`);
  updateCookieJar(setupJar, setupPage);
  const setupPairing = await fetchJson(`${hubBase}/_dinodia/setup/pairing`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hubBase, host: `127.0.0.1:${hubPort}`, cookie: cookieHeader(setupJar), 'x-dinodia-setup-csrf': cookieValue(setupJar, 'dinodia_setup_csrf') }, body: '{}' });
  if (setupPairing.response.status !== 201 || typeof setupPairing.body.code !== 'string' || !setupPairing.body.code.startsWith('DNO-')) fail(`Real locked setup did not produce a pairing code (${setupPairing.response.status}/${setupPairing.body.errorCode || 'missing-code'})`);
  if (setupPairing.body.id !== undefined || setupPairing.body.attemptId !== undefined) fail('Locked setup returned the internal provisioning attempt identifier');
  if (setupPairing.body.qrPayload !== `dinodia-pairing-v1:${setupPairing.body.code}`) fail('Locked setup QR payload contains authority beyond the pairing code');
  const pairingCode = setupPairing.body.code;
  // Prove the assignment route through the actual Company Portal login route
  // and its real HttpOnly cookie. The harness must never manufacture a signed
  // employee token and then rewrite a database hash to make it pass.
  const employeePassword = `harness-cxo-password-${crypto.randomUUID()}`;
  const employeeEmail = `harness-${crypto.randomUUID()}@invalid.test`;
  const employee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Harness CXO', email: employeeEmail, emailNormalized: employeeEmail, role: 'CXO', status: 'ACTIVE', passwordHash: hashPassword(employeePassword) } });
  const wrongPassword = await fetchJson(`${base}/api/company/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: employee.email, password: 'definitely-the-wrong-password' }) });
  if (wrongPassword.response.status !== 401) fail(`Wrong employee password was accepted (${wrongPassword.response.status})`);
  const employeeLogin = await loginEmployee(base, employee, employeePassword);
  const session = employeeLogin.session;
  const token = employeeLogin.token;
  const wrongCode = await fetchJson(`${base}/api/installer/workflows`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(employeeLogin.jar), 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ pairingCode: 'DNO-invalid-pairing-code', assignedEmployeeId: employee.id, reason: 'wrong-code denial' }) });
  if (wrongCode.response.status !== 409) fail(`Wrong pairing code did not fail closed (${wrongCode.response.status})`);
  const malformedEmployeeToken = await fetchJson(`${base}/api/installer/workflows`, { headers: { 'x-dinodia-employee-session': 'not-a-session-token' } });
  if (malformedEmployeeToken.response.status !== 401) fail(`Malformed employee session was not denied (${malformedEmployeeToken.response.status})`);
  const signatureOffset = token.lastIndexOf('.') + 1;
  const signatureByte = token[signatureOffset];
  const tamperedEmployeeToken = `${token.slice(0, signatureOffset)}${signatureByte === 'a' ? 'b' : 'a'}${token.slice(signatureOffset + 1)}`;
  const wrongSignature = await fetchJson(`${base}/api/installer/workflows`, { headers: { 'x-dinodia-employee-session': tamperedEmployeeToken } });
  if (wrongSignature.response.status !== 401) fail(`Wrong-signature employee session was not denied (${wrongSignature.response.status})`);
  const identity = await prisma.hubManufacturingIdentity.findFirstOrThrow({ where: { serialNumber: harnessProvisioningIdentity.serial }, select: { id: true, serialNumber: true } });
  const tokenJar = employeeLogin.jar;
  const internalIdSubmission = await fetchJson(`${base}/api/installer/workflows`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(tokenJar), 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ attemptId: 'internal-attempt-id-is-not-a-pairing-code', assignedEmployeeId: employee.id, reason: 'internal id denial' }) });
  if (internalIdSubmission.response.status !== 400 || internalIdSubmission.body.errorCode !== 'pairing_code_required') fail(`Internal attempt ID was accepted as browser authority (${internalIdSubmission.response.status}/${internalIdSubmission.body.errorCode})`);
  const assignmentKey = `harness-assignment-${crypto.randomUUID()}`;
  const assignment = await fetchJson(`${base}/api/installer/workflows`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(tokenJar), 'idempotency-key': assignmentKey }, body: JSON.stringify({ pairingCode, assignedEmployeeId: employee.id, reason: 'Disposable Stage 1 authenticated route test' }) });
  if (assignment.response.status !== 201 || assignment.body.work?.certifiedSerialNumber !== identity.serialNumber) fail(`Authenticated work assignment failed (${assignment.response.status}/${assignment.body.errorCode})`);
  const provision = await fetchJson(`${base}/api/installer/hubs/provision`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(tokenJar), 'idempotency-key': `harness-provision-${crypto.randomUUID()}` }, body: JSON.stringify({ workflowId: assignment.body.work.id, pairingCode }) });
  if (provision.response.status !== 200 || !provision.body.homeId || !provision.body.hubInstallationId || provision.body.homeClaimPresentation == null) fail(`Assigned provisioning did not bind a Home and HubInstallation (${provision.response.status}/${provision.body.errorCode || 'unknown'})`);
  if (provision.body.attemptId !== undefined) fail('Provisioning response returned the internal provisioning attempt identifier');
  const boundWork = await prisma.companyOperationalWorkItem.findUnique({ where: { id: assignment.body.work.id }, select: { homeId: true, hubInstallationId: true, state: true } });
  if (boundWork?.homeId !== provision.body.homeId || boundWork?.hubInstallationId !== provision.body.hubInstallationId || boundWork.state !== 'IN_PROGRESS') fail('Provisioning did not durably bind the assigned work to the created Home and HubInstallation');
  const boundAttempt = await prisma.hubProvisioningAttempt.findFirst({ where: { codeHash: sha256(pairingCode) }, select: { id: true, hubInstallationId: true, state: true } });
  if (boundAttempt?.hubInstallationId !== provision.body.hubInstallationId) fail('Provisioning attempt and HubInstallation binding is inconsistent');
  if (boundAttempt?.state !== 'CHALLENGE_PENDING') fail(`Provisioning did not advance the durable attempt to challenge-pending (${boundAttempt?.state || 'missing'})`);
  const replay = await fetchJson(`${base}/api/installer/workflows`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(tokenJar), 'idempotency-key': assignmentKey }, body: JSON.stringify({ pairingCode, assignedEmployeeId: employee.id, reason: 'Disposable Stage 1 authenticated route test' }) });
  if (replay.response.status !== 200 || replay.body.work?.id !== assignment.body.work?.id || replay.body.work?.idempotentReplay !== true) fail(`Authenticated work assignment replay was not idempotent (${replay.response.status})`);
  const assigned = await fetchJson(`${base}/api/installer/workflows`, { headers: { cookie: cookieHeader(employeeLogin.jar) } });
  if (assigned.response.status !== 200 || !assigned.body.workflows?.some((work) => work.id === assignment.body.work.id)) fail(`Assigned work was not returned to the authenticated employee (${assigned.response.status})`);
  const logout = await fetchJson(`${base}/api/company/auth/session`, { method: 'DELETE', headers: { cookie: cookieHeader(employeeLogin.jar) } });
  if (logout.response.status !== 204) fail(`Real employee logout failed (${logout.response.status})`);
  const afterLogout = await fetchJson(`${base}/api/installer/workflows`, { headers: { cookie: cookieHeader(employeeLogin.jar) } });
  if (afterLogout.response.status !== 401) fail(`Revoked real employee cookie remained usable (${afterLogout.response.status})`);
  seededWork = { employeeId: employee.id, employeeSessionId: session.id, workId: assignment.body.work.id, attemptId: boundAttempt.id, identityId: identity.id, homeId: provision.body.homeId, hubInstallationId: provision.body.hubInstallationId };
  await prisma.homeClaimChallenge.deleteMany({ where: { hubInstallationId: seededWork.hubInstallationId } });
  await prisma.homeClaimReference.deleteMany({ where: { hubInstallationId: seededWork.hubInstallationId } });
  await prisma.hubInstallation.delete({ where: { id: seededWork.hubInstallationId } });
  await prisma.home.delete({ where: { id: seededWork.homeId } });
  await prisma.hubProvisioningAttempt.delete({ where: { id: seededWork.attemptId } });
  await prisma.companyOperationalWorkItem.delete({ where: { id: seededWork.workId } });
  await prisma.employeeSession.delete({ where: { id: seededWork.employeeSessionId } });
  await prisma.companyEmployeeAccount.delete({ where: { id: seededWork.employeeId } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: seededWork.identityId } });
  seededWork = undefined;
}

async function tableRowSnapshot() {
  const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const snapshot = {};
  for (const { tablename } of tables) {
    const safeTable = String(tablename).replaceAll('"', '""');
    const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::text AS count FROM public."${safeTable}"`);
    snapshot[tablename] = String(rows[0]?.count ?? '0');
  }
  return snapshot;
}

async function protectedRouteDenialChecks(base) {
  const before = await tableRowSnapshot();
  const results = [];
  for (const [method, template, auth] of stage1RouteInventory.filter(([, , kind]) => !['public', 'public-login', 'capability'].includes(kind))) {
    const route = template.replaceAll(':homeId', '00000000-0000-4000-8000-000000000001')
      .replaceAll(':hubInstallationId', '00000000-0000-4000-8000-000000000001')
      .replaceAll(':ticketId', '00000000-0000-4000-8000-000000000001')
      .replaceAll(':requestId', '00000000-0000-4000-8000-000000000002')
      .replaceAll(':trustedDeviceId', '00000000-0000-4000-8000-000000000001');
    const response = await fetch(`${base}${route}`, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    results.push({ method, route, status: response.status });
    const expected = auth === 'public-idempotent-logout' ? 204 : auth === 'signed-manufacturing-bootstrap' ? 400 : 401;
    if (response.status !== expected) fail(`Route auth contract mismatch: ${method} ${route} expected ${expected}, got ${response.status} (${auth})`);
  }
  const invalidManufacturing = keyPair();
  const invalidEncryption = x25519KeyPair();
  const signatureDenial = await fetch(`${base}/api/hub-agent/v2/pairing/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: `DNO-${crypto.randomBytes(10).toString('hex')}`, envelope: {
      serial: `untrusted-${crypto.randomUUID()}`, publicKeyPem: invalidManufacturing.publicKey,
      encryptionPublicKeyPem: invalidEncryption.publicKey, identityGeneration: 1,
      attemptId: crypto.randomUUID(),
      baseUrl: 'http://dinodia-harness.local', expiresAt: Date.now() + 60_000,
      publicKeyFingerprint: publicKeyFingerprint(invalidManufacturing.publicKey),
      encryptionKeyFingerprint: publicKeyFingerprint(invalidEncryption.publicKey),
      manufacturingRootSignature: 'invalid-test-root-signature', hubSignature: 'invalid-test-hub-signature',
    } }),
  });
  if (signatureDenial.status !== 401) fail(`Well-formed but untrusted manufacturing registration did not return 401 (${signatureDenial.status})`);
  const after = await tableRowSnapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const changed = Object.keys(after).filter((table) => before[table] !== after[table]).map((table) => `${table}:${before[table]}->${after[table]}`);
    fail(`Unauthenticated/invalid-signature route matrix changed durable row counts: ${changed.join(', ')}`);
  }
  console.log(`[stage1:integration] PASS: ${results.length} inventoried protected Platform route/methods enforced unauthenticated 401 (idempotent logout 204, signed enrollment malformed-input 400) with no durable row-count changes; invalid root signature returned 401`);
}
async function customerAuthorizationChecks() {
  const base = `http://127.0.0.1:${appPort}`;
  const now = new Date();
  const homeData = { lifecycle: 'INSTALLING', installationStatus: 'DRAFT', addressStatus: 'VERIFIED', addressLine1: '1 Harness Street', city: 'London', postcode: 'N1 1AA', country: 'GB', timezone: 'Europe/London' };
  const homeOne = await prisma.home.create({ data: homeData });
  const homeTwo = await prisma.home.create({ data: homeData });
  const areaOne = await prisma.area.create({ data: { homeId: homeOne.id, osAreaId: `area-one-${crypto.randomUUID()}`, originalName: 'Tenant area' } });
  const areaTwo = await prisma.area.create({ data: { homeId: homeTwo.id, osAreaId: `area-two-${crypto.randomUUID()}`, originalName: 'Owner area' } });
  const identityOneSigning = keyPair();
  const identityTwoSigning = keyPair();
  const identityOneEncryption = x25519KeyPair();
  const identityTwoEncryption = x25519KeyPair();
  const identityOne = await prisma.hubManufacturingIdentity.create({ data: { serialNumber: harnessHubInstallationId, signingPublicKey: identityOneSigning.publicKey, encryptionPublicKey: identityOneEncryption.publicKey, signingKeyFingerprint: publicKeyFingerprint(identityOneSigning.publicKey), encryptionKeyFingerprint: publicKeyFingerprint(identityOneEncryption.publicKey) } });
  const identityTwo = await prisma.hubManufacturingIdentity.create({ data: { serialNumber: `harness-home-two-${crypto.randomUUID()}`, signingPublicKey: identityTwoSigning.publicKey, encryptionPublicKey: identityTwoEncryption.publicKey, signingKeyFingerprint: publicKeyFingerprint(identityTwoSigning.publicKey), encryptionKeyFingerprint: publicKeyFingerprint(identityTwoEncryption.publicKey) } });
  // An ACTIVE home is allowed only after an independently verified CloudURL
  // exists. The fixture represents that already-completed prerequisite; the
  // CloudURL protocol itself is tested by the dedicated pairing tests.
  const verifiedAt = new Date(now.getTime() - 1000);
  const hubOne = await prisma.hubInstallation.create({ data: { id: harnessHubInstallationId, homeId: homeOne.id, manufacturingIdentityId: identityOne.id, serialNumberSnapshot: identityOne.serialNumber, state: 'ACTIVE', cloudUrl: 'https://harness-one.example.invalid', cloudUrlVerifiedAt: verifiedAt, remoteChallengeAt: verifiedAt, remoteVerificationAt: verifiedAt } });
  const hubTwo = await prisma.hubInstallation.create({ data: { homeId: homeTwo.id, manufacturingIdentityId: identityTwo.id, serialNumberSnapshot: identityTwo.serialNumber, state: 'ACTIVE', cloudUrl: 'https://harness-two.example.invalid', cloudUrlVerifiedAt: verifiedAt, remoteChallengeAt: verifiedAt, remoteVerificationAt: verifiedAt } });
  const claimReferenceValue = `harness-permanent-label-${crypto.randomUUID()}`;
  const claimReferenceHashValue = claimReferenceHash(claimReferenceValue, env.CLAIM_REFERENCE_PEPPER);
  const claimIdentitySigning = keyPair();
  const claimIdentityEncryption = x25519KeyPair();
  const claimIdentity = await prisma.hubManufacturingIdentity.create({ data: { serialNumber: `harness-claim-${crypto.randomUUID()}`, signingPublicKey: claimIdentitySigning.publicKey, encryptionPublicKey: claimIdentityEncryption.publicKey, signingKeyFingerprint: publicKeyFingerprint(claimIdentitySigning.publicKey), encryptionKeyFingerprint: publicKeyFingerprint(claimIdentityEncryption.publicKey) } });
  const claimHome = await prisma.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
  const claimHub = await prisma.hubInstallation.create({ data: { homeId: claimHome.id, manufacturingIdentityId: claimIdentity.id, serialNumberSnapshot: claimIdentity.serialNumber, state: 'PAIRING', permanentResolverHash: claimReferenceHashValue, permanentResolverGeneration: 1, permanentResolverStatus: 'ACTIVE' } });
  const claimReference = await prisma.homeClaimReference.create({ data: { homeId: claimHome.id, hubInstallationId: claimHub.id, purpose: 'INITIAL_OWNER', companyQrReferenceHash: claimReferenceHashValue, resolverGeneration: 1 } });
  const claimMachineSecret = `harness-claim-machine-${crypto.randomUUID()}`;
  await prisma.hubCredentialVersion.create({ data: { hubInstallationId: claimHub.id, version: 1, purpose: 'machine-credential', state: 'ACTIVE', tokenHash: sha256(claimMachineSecret), encryptedDeliveryEnvelope: { harness: true }, ciphertextKeyVersion: 1, deliveredAt: verifiedAt, acknowledgedAt: verifiedAt, activatedAt: verifiedAt } });
  await prisma.home.updateMany({ where: { id: { in: [homeOne.id, homeTwo.id] } }, data: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } });
  const machineSecret = `harness-machine-${crypto.randomUUID()}`;
  await prisma.hubCredentialVersion.create({ data: { hubInstallationId: hubOne.id, version: 1, purpose: 'machine-credential', state: 'ACTIVE', tokenHash: sha256(machineSecret), encryptedDeliveryEnvelope: { harness: true }, ciphertextKeyVersion: 1, deliveredAt: verifiedAt, acknowledgedAt: verifiedAt, activatedAt: verifiedAt } });
  await prisma.hubCredentialVersion.create({ data: { hubInstallationId: hubOne.id, version: 1, purpose: 'operator-credential', state: 'ACTIVE', tokenHash: sha256(`harness-operator-v1-${crypto.randomUUID()}`), encryptedDeliveryEnvelope: { harness: true }, ciphertextKeyVersion: 1, issuedAt: new Date(Date.now() - 61 * 60 * 1000), deliveredAt: verifiedAt, acknowledgedAt: verifiedAt, activatedAt: new Date(Date.now() - 61 * 60 * 1000) } });
  const { reconcileCredentialLifecycle, OPERATOR_ROTATION_MS } = loadOperatorLifecycleService();
  const operatorV1BeforeBoundary = await prisma.hubCredentialVersion.findUniqueOrThrow({ where: { HubCredentialVersion_hub_purpose_version_key: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 1 } }, select: { issuedAt: true } });
  const operatorRotationBoundary = new Date(operatorV1BeforeBoundary.issuedAt.getTime() + OPERATOR_ROTATION_MS);
  const rotationBefore = await reconcileCredentialLifecycle(new Date(operatorRotationBoundary.getTime() - 1));
  if (rotationBefore.rotated !== 0 || await prisma.hubCredentialVersion.count({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 } })) fail('Automatic operator rotation occurred before the exact 60-minute boundary');
  const rotationAt = await reconcileCredentialLifecycle(operatorRotationBoundary);
  const boundaryPending = await prisma.hubCredentialVersion.findUnique({ where: { HubCredentialVersion_hub_purpose_version_key: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 } }, select: { state: true } });
  if (rotationAt.rotated !== 1 || boundaryPending?.state !== 'PENDING') fail('Automatic operator rotation did not create one pending version exactly at 60 minutes');
  const rotationAfter = await reconcileCredentialLifecycle(new Date(operatorRotationBoundary.getTime() + 1));
  if (rotationAfter.rotated !== 0 || await prisma.hubCredentialVersion.count({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 } }) !== 1) fail('Automatic operator rotation did not converge after the exact 60-minute boundary');
  await prisma.hubCredentialVersion.deleteMany({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 } });
  console.log('[stage1:integration] PASS: durable operator rotation remains idle at 59:59.999, creates one PENDING version at 60:00.000, and converges after the boundary');
  const email = `stage1-${crypto.randomUUID()}@invalid.test`;
  const username = `stage1-${crypto.randomUUID().slice(0, 8)}`;
  const account = await prisma.customerAccount.create({ data: { displayName: 'Stage 1 customer', username, usernameNormalized: username, email, emailNormalized: email, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const tenantMembership = await prisma.homeMembership.create({ data: { customerAccountId: account.id, homeId: homeOne.id, role: 'TENANT' } });
  const ownerMembership = await prisma.homeMembership.create({ data: { customerAccountId: account.id, homeId: homeTwo.id, role: 'OWNER' } });
  await prisma.tenantAreaGrant.create({ data: { membershipId: tenantMembership.id, areaId: areaOne.id, homeId: homeOne.id } });
  const propertyEmail = `stage1-owner-${crypto.randomUUID()}@invalid.test`;
  const propertyUsername = `stage1-owner-${crypto.randomUUID().slice(0, 8)}`;
  const propertyAccount = await prisma.customerAccount.create({ data: { displayName: 'Stage 1 homeowner', username: propertyUsername, usernameNormalized: propertyUsername, email: propertyEmail, emailNormalized: propertyEmail, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const propertyMembership = await prisma.homeMembership.create({ data: { customerAccountId: propertyAccount.id, homeId: homeOne.id, role: 'OWNER' } });
  const managerEmail = `stage1-manager-${crypto.randomUUID()}@invalid.test`;
  const managerUsername = `stage1-manager-${crypto.randomUUID().slice(0, 8)}`;
  const managerAccount = await prisma.customerAccount.create({ data: { displayName: 'Stage 1 property manager', username: managerUsername, usernameNormalized: managerUsername, email: managerEmail, emailNormalized: managerEmail, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const managerMembership = await prisma.homeMembership.create({ data: { customerAccountId: managerAccount.id, homeId: homeOne.id, role: 'PROPERTY_MANAGER' } });
  const phone = keyPair();
  const phoneThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(phone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const trusted = await prisma.trustedDevice.create({ data: { customerAccountId: account.id, deviceInstallationId: `harness-phone-${crypto.randomUUID()}`, publicKey: phone.publicKey, publicKeyThumbprint: phoneThumbprint, deviceName: 'Harness phone' } });
  const rawSession = `harness-customer-session-${crypto.randomUUID()}`;
  const session = await prisma.customerSession.create({ data: { customerAccountId: account.id, trustedDeviceId: trusted.id, refreshTokenHash: sha256(rawSession), securityVersion: account.securityVersion, trustedDeviceSessionVersion: trusted.sessionVersion, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const propertyPhone = keyPair();
  const propertyPhoneThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(propertyPhone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const propertyTrusted = await prisma.trustedDevice.create({ data: { customerAccountId: propertyAccount.id, deviceInstallationId: `harness-owner-phone-${crypto.randomUUID()}`, publicKey: propertyPhone.publicKey, publicKeyThumbprint: propertyPhoneThumbprint, deviceName: 'Harness homeowner phone' } });
  const propertyRawSession = `harness-owner-session-${crypto.randomUUID()}`;
  const propertySession = await prisma.customerSession.create({ data: { customerAccountId: propertyAccount.id, trustedDeviceId: propertyTrusted.id, refreshTokenHash: sha256(propertyRawSession), securityVersion: propertyAccount.securityVersion, trustedDeviceSessionVersion: propertyTrusted.sessionVersion, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const managerPhone = keyPair();
  const managerPhoneThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(managerPhone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const managerTrusted = await prisma.trustedDevice.create({ data: { customerAccountId: managerAccount.id, deviceInstallationId: `harness-manager-phone-${crypto.randomUUID()}`, publicKey: managerPhone.publicKey, publicKeyThumbprint: managerPhoneThumbprint, deviceName: 'Harness property-manager phone' } });
  const managerRawSession = `harness-manager-session-${crypto.randomUUID()}`;
  const managerSession = await prisma.customerSession.create({ data: { customerAccountId: managerAccount.id, trustedDeviceId: managerTrusted.id, refreshTokenHash: sha256(managerRawSession), securityVersion: managerAccount.securityVersion, trustedDeviceSessionVersion: managerTrusted.sessionVersion, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const issue = async (homeId) => fetchJson(`${base}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': rawSession }, body: JSON.stringify({ homeId }) });
  const issueProperty = async () => fetchJson(`${base}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': propertyRawSession }, body: JSON.stringify({ homeId: homeOne.id }) });
  const issueManager = async () => fetchJson(`${base}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': managerRawSession }, body: JSON.stringify({ homeId: homeOne.id }) });
  const tenantToken = await issue(homeOne.id);
  if (tenantToken.response.status !== 200 || !tenantToken.body.token) fail(`Tenant hub session was not issued (${tenantToken.response.status})`);
  const ownerToken = await issue(homeTwo.id);
  if (ownerToken.response.status !== 200 || !ownerToken.body.token) fail(`Second-home owner session was not issued (${ownerToken.response.status})`);
  const propertyToken = await issueProperty();
  if (propertyToken.response.status !== 200 || !propertyToken.body.token) fail(`Homeowner session was not issued (${propertyToken.response.status})`);
  const managerToken = await issueManager();
  if (managerToken.response.status !== 200 || !managerToken.body.token) fail(`Property-manager session was not issued (${managerToken.response.status})`);
  const tenantOffline = await fetchJson(`${base}/api/v2/offline-authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ trustedDeviceId: trusted.id, publicKey: phone.publicKey }) });
  if (tenantOffline.response.status !== 200 || tenantOffline.body.authorisation?.homeId !== homeOne.id) fail(`Tenant offline authority was not scoped to the selected home (${tenantOffline.response.status})`);
  const ownerOffline = await fetchJson(`${base}/api/v2/offline-authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': ownerToken.body.token }, body: JSON.stringify({ trustedDeviceId: trusted.id, publicKey: phone.publicKey }) });
  if (ownerOffline.response.status !== 403) fail(`Owner received offline household command authority (${ownerOffline.response.status})`);
  const wrongPhone = await fetchJson(`${base}/api/v2/offline-authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ trustedDeviceId: crypto.randomUUID(), publicKey: phone.publicKey }) });
  if (wrongPhone.response.status !== 403) fail(`Wrong trusted device was accepted for offline authority (${wrongPhone.response.status})`);

  // Drive the real operator credential state machine through the running
  // Next routes. Delivery is observed by token-state, acknowledgement is a
  // separate durable write, and activation is a third exact-version write.
  const machineBase = `http://127.0.0.1:${appPort}`;
  const resolverChallenge = await machineRequest({ base: machineBase, path: '/api/hub-agent/v2/claim/resolver/challenge', machineSecret: claimMachineSecret, body: { serial: claimIdentity.serialNumber, identityGeneration: claimIdentity.identityGeneration, reference: claimReferenceValue } });
  if (resolverChallenge.response.status !== 200 || !resolverChallenge.body.challengeId || !resolverChallenge.body.challenge) fail(`Permanent-label resolver did not issue a live challenge (${resolverChallenge.response.status})`);
  const resolverProof = { version: 1, serial: claimIdentity.serialNumber, identityGeneration: claimIdentity.identityGeneration, challengeId: resolverChallenge.body.challengeId, challenge: resolverChallenge.body.challenge, resolverGeneration: resolverChallenge.body.resolverGeneration, expiresAt: resolverChallenge.body.expiresAt };
  const resolverTimestamp = String(Date.now());
  const resolverNonce = `harness-resolver-${crypto.randomUUID()}`;
  const resolverBodyHash = sha256(JSON.stringify(resolverProof));
  const resolverSignature = crypto.sign(null, Buffer.from(canonicalHubRequest({ method: 'POST', path: '/api/hub-agent/v2/claim/resolver/challenge', timestamp: resolverTimestamp, nonce: resolverNonce, bodyHash: resolverBodyHash }), 'utf8'), crypto.createPrivateKey(claimIdentitySigning.privateKey)).toString('base64url');
  const resolved = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'resolve', ...resolverProof, timestamp: resolverTimestamp, nonce: resolverNonce, bodyHash: resolverBodyHash, hubSignature: resolverSignature }) });
  if (resolved.response.status !== 200 || resolved.body.homeId !== claimHome.id) fail(`Permanent-label signed resolver proof was not accepted (${resolved.response.status})`);
  const resolverReplay = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'resolve', ...resolverProof, timestamp: resolverTimestamp, nonce: resolverNonce, bodyHash: resolverBodyHash, hubSignature: resolverSignature }) });
  if (![401, 409].includes(resolverReplay.response.status)) fail(`Permanent-label resolver replay was accepted (${resolverReplay.response.status})`);
  const winnerAccount = await prisma.customerAccount.create({ data: { displayName: 'Claim winner', username: `claim-winner-${crypto.randomUUID()}`, usernameNormalized: `claim-winner-${crypto.randomUUID()}`, email: `claim-winner-${crypto.randomUUID()}@invalid.test`, emailNormalized: `claim-winner-${crypto.randomUUID()}@invalid.test`, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const loserAccount = await prisma.customerAccount.create({ data: { displayName: 'Claim loser', username: `claim-loser-${crypto.randomUUID()}`, usernameNormalized: `claim-loser-${crypto.randomUUID()}`, email: `claim-loser-${crypto.randomUUID()}@invalid.test`, emailNormalized: `claim-loser-${crypto.randomUUID()}@invalid.test`, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const concurrentClaims = await Promise.all([winnerAccount, loserAccount].map((candidate) => fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: candidate.id }) })));
  const claimSuccesses = concurrentClaims.filter((entry) => entry.response.status === 200);
  const claimLosers = concurrentClaims.filter((entry) => entry.response.status === 409);
  if (claimSuccesses.length !== 1 || claimLosers.length !== 1 || JSON.stringify(claimLosers[0].body).includes(claimHome.id)) fail(`Claim reservation was not first-wins and private (${concurrentClaims.map((entry) => entry.response.status).join('/')})`);
  const winningAccountId = concurrentClaims[0].response.status === 200 ? winnerAccount.id : loserAccount.id;
  const reservationId = claimSuccesses[0].body.reservationId;
  const repeatedClaim = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: winningAccountId }) });
  if (repeatedClaim.response.status !== 200 || repeatedClaim.body.reservationId !== reservationId || repeatedClaim.body.expiresAt !== claimSuccesses[0].body.expiresAt) fail('Claim polling/idempotent replay changed the reservation deadline');
  const mutation = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'mutate', reservationId, customerAccountId: winningAccountId, step: 'PROFILE', mutation: { displayName: 'Claim winner updated', username: `claim-updated-${crypto.randomUUID()}` } }) });
  if (mutation.response.status !== 200 || new Date(mutation.body.expiresAt).getTime() <= new Date(claimSuccesses[0].body.expiresAt).getTime()) fail('A persisted qualifying claim mutation did not extend the reservation');
  // The production check constraint requires an ACTIVE reservation's expiry
  // to remain after its creation time. Move both timestamps together so the
  // fixture is already expired without bypassing that invariant.
  const expiredCreatedAt = new Date(Date.now() - 2000);
  const expiredAt = new Date(Date.now() - 1000);
  await prisma.homeClaimReservation.update({ where: { id: reservationId }, data: { createdAt: expiredCreatedAt, expiresAt: expiredAt } });
  const expiredClaim = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: winningAccountId }) });
  if (expiredClaim.response.status !== 409) fail(`Expired claim did not return the bounded restart error (${expiredClaim.response.status})`);
  const deletedWinner = await prisma.customerAccount.findUnique({ where: { id: winningAccountId }, select: { id: true } });
  const resetClaim = await prisma.homeClaimReference.findUnique({ where: { id: claimReference.id }, select: { state: true } });
  const resetHome = await prisma.home.findUnique({ where: { id: claimHome.id }, select: { lifecycle: true } });
  if (deletedWinner || resetClaim?.state !== 'AVAILABLE' || resetHome?.lifecycle !== 'CLAIMABLE') fail('Expired claim cleanup did not commit before returning its error');
  // A verified account with another active property relationship survives the
  // same expiry transaction. This is the settled account-preservation rule.
  const preservedReservation = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: propertyAccount.id }) });
  if (preservedReservation.response.status !== 200) fail(`Account-preserving claim reservation could not be created (${preservedReservation.response.status})`);
  const preservedCreatedAt = new Date(Date.now() - 2000);
  const preservedExpiresAt = new Date(Date.now() - 1000);
  await prisma.homeClaimReservation.update({ where: { id: preservedReservation.body.reservationId }, data: { createdAt: preservedCreatedAt, expiresAt: preservedExpiresAt } });
  const preservedExpired = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: propertyAccount.id }) });
  if (preservedExpired.response.status !== 409) fail(`Account-preserving claim expiry returned the wrong status (${preservedExpired.response.status})`);
  if (!(await prisma.customerAccount.findUnique({ where: { id: propertyAccount.id }, select: { id: true } }))) fail('Claim expiry deleted an account with another active property relationship');
  // The shared native-operations dispatcher must perform the same cleanup,
  // not a feature-specific schedule. This uses the real authenticated cron
  // route with an already-expired durable reservation.
  const scheduledAccount = await prisma.customerAccount.create({ data: { displayName: 'Scheduled claim expiry', username: `claim-scheduled-${crypto.randomUUID()}`, usernameNormalized: `claim-scheduled-${crypto.randomUUID()}`, email: `claim-scheduled-${crypto.randomUUID()}@invalid.test`, emailNormalized: `claim-scheduled-${crypto.randomUUID()}@invalid.test`, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const scheduledReservation = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: scheduledAccount.id }) });
  if (scheduledReservation.response.status !== 200) fail(`Scheduled claim reservation could not be created (${scheduledReservation.response.status})`);
  await prisma.homeClaimReservation.update({ where: { id: scheduledReservation.body.reservationId }, data: { createdAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000) } });
  const scheduledRun = await fetchJson(`${machineBase}/api/cron/native-operations`, { method: 'POST', headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
  if (scheduledRun.response.status !== 200 || Number(scheduledRun.body.releasedClaims) < 1) fail(`Shared native-operations dispatcher did not release the expired claim (${scheduledRun.response.status}/${JSON.stringify(scheduledRun.body)})`);
  if (Number(scheduledRun.body.credentials?.rotated) < 1) fail(`The shared native-operations dispatcher did not rotate an operator credential past its 60-minute issue deadline (${JSON.stringify(scheduledRun.body.credentials)})`);
  const automaticallyRotated = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 }, select: { state: true, issuedAt: true } });
  if (automaticallyRotated?.state !== 'PENDING' || automaticallyRotated.issuedAt.getTime() > Date.now()) fail('The due operator rotation did not persist exactly one pending version before hub delivery');
  if (await prisma.customerAccount.findUnique({ where: { id: scheduledAccount.id }, select: { id: true } })) fail('Scheduled claim expiry did not delete an otherwise-unrelated verified account');
  await prisma.homeClaimChallenge.deleteMany({ where: { hubInstallationId: claimHub.id } });
  await prisma.homeClaimReference.deleteMany({ where: { id: claimReference.id } });
  await prisma.hubInstallation.delete({ where: { id: claimHub.id } });
  await prisma.home.delete({ where: { id: claimHome.id } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: claimIdentity.id } });
  await prisma.customerAccount.deleteMany({ where: { id: { in: [winnerAccount.id, loserAccount.id] } } });
  const tokenState = await machineRequest({ base: machineBase, path: '/api/hub-agent/token-state', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, operatorCredentialVersion: 1 } });
  if (tokenState.response.status !== 200 || tokenState.body.operatorCredentialDelivery?.version !== 2) fail(`Operator credential delivery did not expose the next version (${tokenState.response.status})`);
  const operatorV2 = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 }, select: { tokenHash: true, state: true } });
  if (operatorV2?.state !== 'DELIVERED') fail(`Operator credential was not durably marked DELIVERED (${operatorV2?.state})`);
  const acknowledged = await machineRequest({ base: machineBase, path: '/api/hub-agent/v2/credentials/acknowledge', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, version: 2, credentialFingerprint: operatorV2.tokenHash } });
  if (acknowledged.response.status !== 200 || acknowledged.body.state !== 'ACKNOWLEDGED') fail(`Operator acknowledgement failed (${acknowledged.response.status})`);
  const acknowledgedRow = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 }, select: { state: true, acknowledgedAt: true, activatedAt: true } });
  if (acknowledgedRow?.state !== 'ACKNOWLEDGED' || !acknowledgedRow.acknowledgedAt || acknowledgedRow.activatedAt) fail('Acknowledgement incorrectly activated the operator credential');
  const activated = await machineRequest({ base: machineBase, path: '/api/hub-agent/v2/credentials/activate', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, version: 2, credentialFingerprint: operatorV2.tokenHash } });
  if (activated.response.status !== 200 || activated.body.state !== 'ACTIVE') fail(`Operator activation failed (${activated.response.status})`);
  const lifecycleRows = await prisma.hubCredentialVersion.findMany({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential' }, orderBy: { version: 'asc' }, select: { version: true, state: true, graceUntil: true, activatedAt: true } });
  const oldOperator = lifecycleRows.find((row) => row.version === 1);
  const newOperator = lifecycleRows.find((row) => row.version === 2);
  if (oldOperator?.state !== 'GRACE' || !oldOperator.graceUntil || newOperator?.state !== 'ACTIVE') fail(`Operator lifecycle did not separate grace and active states (${JSON.stringify(lifecycleRows)})`);
  const graceDuration = oldOperator.graceUntil.getTime() - newOperator.activatedAt.getTime();
  if (!newOperator.activatedAt || graceDuration !== 20 * 60 * 1000) fail(`Operator grace was not exactly 20 minutes from the new version's activation transition (${graceDuration})`);
  await reconcileCredentialLifecycle(new Date(oldOperator.graceUntil.getTime() - 1));
  const graceImmediatelyBefore = await prisma.hubCredentialVersion.findUniqueOrThrow({ where: { HubCredentialVersion_hub_purpose_version_key: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: oldOperator.version } }, select: { state: true } });
  if (graceImmediatelyBefore.state !== 'GRACE') fail('Previous operator credential was revoked before its exact 20-minute grace deadline');
  await reconcileCredentialLifecycle(oldOperator.graceUntil);
  const graceAtBoundary = await prisma.hubCredentialVersion.findUniqueOrThrow({ where: { HubCredentialVersion_hub_purpose_version_key: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: oldOperator.version } }, select: { state: true } });
  if (graceAtBoundary.state !== 'REVOKED') fail('Previous operator credential remained valid at its exact 20-minute grace deadline');
  await reconcileCredentialLifecycle(new Date(oldOperator.graceUntil.getTime() + 1));
  const graceImmediatelyAfter = await prisma.hubCredentialVersion.findUniqueOrThrow({ where: { HubCredentialVersion_hub_purpose_version_key: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: oldOperator.version } }, select: { state: true } });
  if (graceImmediatelyAfter.state !== 'REVOKED') fail('Previous operator credential did not remain revoked after the exact grace deadline');
  console.log('[stage1:integration] PASS: previous operator credential remains GRACE at 19:59.999 and is durably REVOKED at 20:00.000 and after');

  // Support is exercised through the real customer, employee and
  // machine-authenticated routes. The employee never receives the customer
  // code or plaintext proof; the hub presents only proof-of-possession.
  const supportPassword = `harness-support-password-${crypto.randomUUID()}`;
  const supportEmail = `support-${crypto.randomUUID()}@invalid.test`;
  const supportEmployee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Harness Support', email: supportEmail, emailNormalized: supportEmail, role: 'SENIOR_CUSTOMER_SUPPORT', status: 'ACTIVE', passwordHash: hashPassword(supportPassword) } });
  const supportLogin = await loginEmployee(base, supportEmployee, supportPassword);
  const supportSession = supportLogin.session;
  const supportToken = supportLogin.token;
  const ticketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'HARNESS', description: 'Disposable tenant-private support test' }) });
  if (ticketResponse.response.status !== 201) fail(`Customer support ticket creation failed (${ticketResponse.response.status})`);
  const ticketId = ticketResponse.body.ticket?.id;
  await prisma.supportTicket.update({ where: { id: ticketId }, data: { assignedEmployeeId: supportEmployee.id } });
  const accessResponse = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': supportToken }, body: JSON.stringify({ requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantMembership.id, areaIds: [areaOne.id], targetIds: [] }) });
  if (accessResponse.response.status !== 201 || accessResponse.body.accessRequest?.touchesPropertyInfrastructure !== false) fail(`Tenant-private support request was not scoped privately (${accessResponse.response.status})`);
  const requestId = accessResponse.body.accessRequest.id;
  const approval = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests/${requestId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ approve: true }) });
  if (approval.response.status !== 200 || !approval.body.oneUseCode) fail(`Tenant support approval did not issue a one-use customer code (${approval.response.status})`);
  const supportCode = approval.body.oneUseCode;
  const approvedSupportRow = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { codeExpiresAt: true, sessionHardStopAt: true } });
  if (!approvedSupportRow?.codeExpiresAt || approvedSupportRow.codeExpiresAt.getTime() < Date.now() + 9 * 60 * 1000 || !approvedSupportRow.sessionHardStopAt || approvedSupportRow.sessionHardStopAt.getTime() < Date.now() + 29 * 60 * 1000) fail('Support approval did not persist the ten-minute code and thirty-minute hard stop');
  const tenantNotificationsBefore = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': tenantToken.body.token } });
  if (tenantNotificationsBefore.response.status !== 200 || tenantNotificationsBefore.body.notifications?.length !== 0) fail('Tenant-private support leaked a homeowner notification side channel');
  const issueResponse = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests/${requestId}/issue`, { method: 'POST', headers: { 'x-dinodia-employee-session': supportToken } });
  if (issueResponse.response.status !== 200 || issueResponse.body.code || issueResponse.body.employeeProofEnvelope || !issueResponse.body.supportUrl) fail(`Employee support issue response exposed or omitted bounded handoff (${issueResponse.response.status})`);
  const supportRow = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { employeeHandoffHash: true, codeHash: true } });
  const proofOfPossession = supportProofOfPossessionDigest({ employeeProofHash: supportRow.employeeHandoffHash, serial: identityOne.serialNumber, ticketId, requestId, codeHash: supportRow.codeHash, identityGeneration: identityOne.identityGeneration });
  const redeemBody = { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, ticketId, requestId, code: supportCode, employeeProofOfPossession: proofOfPossession };
  const redeemed = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: redeemBody });
  if (redeemed.response.status !== 200 || redeemed.body.scope !== 'TENANT_SCOPE' || redeemed.body.targetUserId !== account.id || !redeemed.body.areaIds.includes(areaOne.id)) fail(`Machine-authenticated support redemption failed (${redeemed.response.status})`);
  const replayRedeem = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: redeemBody });
  if (replayRedeem.response.status !== 401) fail(`Support redemption replay was accepted (${replayRedeem.response.status})`);
  const supportSessionRow = await prisma.supportSession.findFirst({ where: { accessRequestId: requestId }, select: { id: true, leaseHash: true, status: true } });
  const supportStatus = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/status', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, sessionId: supportSessionRow.id, lease: 'not-returned-to-employee' } });
  if (supportStatus.response.status !== 200 || supportStatus.body.active !== false) fail('Support status accepted a lease that was not returned to the employee');
  await prisma.supportSession.update({ where: { id: supportSessionRow.id }, data: { desiredRevokedAt: new Date(), status: 'PENDING_HUB_REVOKE' } });
  const supportRevocation = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/revocation', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, sessionId: supportSessionRow.id, lease: supportCode } });
  if (supportRevocation.response.status !== 403) fail('Support revocation accepted an incorrect lease');
  await prisma.$transaction(async (tx) => {
    await tx.supportSession.update({ where: { id: supportSessionRow.id }, data: { status: 'PENDING_HUB_REVOKE' } });
    await tx.supportAccessRequest.update({ where: { id: requestId }, data: { status: 'REVOKED', desiredRevokedAt: new Date() } });
    await tx.supportTicket.update({ where: { id: ticketId }, data: { status: 'CLOSED', closedAt: new Date() } });
  });
  // Remove disposable support records before their employee foreign key is
  // removed. The production close/revoke state remains asserted above; this
  // is only harness cleanup.
  await prisma.supportSession.deleteMany({ where: { accessRequestId: requestId } });
  await prisma.supportAccessRequest.delete({ where: { id: requestId } });
  await prisma.supportTicket.delete({ where: { id: ticketId } });
  await prisma.employeeSession.delete({ where: { id: supportSession.id } });
  await prisma.companyEmployeeAccount.delete({ where: { id: supportEmployee.id } });

  // Broaden the same tenant ticket only after a tenant approval, then require
  // the separate homeowner approval and the homeowner's trusted-phone
  // confirmation. Property access creates a durable owner notification;
  // tenant-private access above created none.
  const propertyDevice = await prisma.nativeDevice.create({ data: { homeId: homeOne.id, hubInstallationId: hubOne.id, osDeviceId: `harness-property-device-${crypto.randomUUID()}`, originalName: 'Harness property light', technicalLabel: 'property_device', managementClass: 'PROPERTY_DEVICE', deviceType: 'light', lifecycle: 'INSTALLED' } });
  const tenantDevice = await prisma.nativeDevice.create({ data: { homeId: homeOne.id, hubInstallationId: hubOne.id, osDeviceId: 'harness-tenant-device', originalName: 'Harness tenant light', technicalLabel: 'tenant_device', managementClass: 'TENANT_DEVICE', deviceType: 'light', ownerMembershipId: tenantMembership.id, descriptorRevision: 1, descriptorDigest: 'descriptor-1', lifecycle: 'DISCOVERED' } });
  await prisma.deviceAreaAssignment.create({ data: { deviceId: tenantDevice.id, areaId: areaOne.id, homeId: homeOne.id, source: 'HARNESS', actorType: 'SYSTEM' } });
  await prisma.nativeDevice.update({ where: { id: tenantDevice.id }, data: { lifecycle: 'INSTALLED' } });
  const propertyTicketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'HARNESS_PROPERTY', description: 'Disposable property support test' }) });
  if (propertyTicketResponse.response.status !== 201) fail(`Property support ticket creation failed (${propertyTicketResponse.response.status})`);
  const propertyTicketId = propertyTicketResponse.body.ticket.id;
  // The employee was deleted with the tenant-private ticket above; create a
  // fresh assigned employee for the property flow.
  const propertySupportPassword = `harness-property-support-${crypto.randomUUID()}`;
  const propertySupportEmail = `property-support-${crypto.randomUUID()}@invalid.test`;
  const propertySupportEmployee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Harness Property Support', email: propertySupportEmail, emailNormalized: propertySupportEmail, role: 'SENIOR_CUSTOMER_SUPPORT', status: 'ACTIVE', passwordHash: hashPassword(propertySupportPassword) } });
  const propertySupportLogin = await loginEmployee(base, propertySupportEmployee, propertySupportPassword);
  const propertySupportSession = propertySupportLogin.session;
  const propertySupportToken = propertySupportLogin.token;
  await prisma.supportTicket.update({ where: { id: propertyTicketId }, data: { assignedEmployeeId: propertySupportEmployee.id } });
  const broadeningTenantRequest = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': propertySupportToken }, body: JSON.stringify({ requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantMembership.id, areaIds: [areaOne.id], targetIds: [] }) });
  if (broadeningTenantRequest.response.status !== 201) fail(`Tenant approval prerequisite could not be created (${broadeningTenantRequest.response.status})`);
  const broadeningTenantApproval = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${broadeningTenantRequest.body.accessRequest.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ approve: true }) });
  if (broadeningTenantApproval.response.status !== 200) fail(`Tenant approval prerequisite failed (${broadeningTenantApproval.response.status})`);
  // A tenant-scoped request may include a permanent property device only when
  // the selected area is granted. That access must still notify the homeowner
  // because the operation touches property infrastructure, while retaining
  // tenant scope and never exposing tenant-private metadata. Use a separate
  // ticket so the partial unique index for one open request per ticket/scope
  // remains part of the test rather than being bypassed.
  const tenantPropertyTicketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'HARNESS_TENANT_PROPERTY_DEVICE', description: 'Disposable tenant permanent-device support test' }) });
  if (tenantPropertyTicketResponse.response.status !== 201) fail(`Tenant permanent-device support ticket creation failed (${tenantPropertyTicketResponse.response.status})`);
  const tenantPropertyTicketId = tenantPropertyTicketResponse.body.ticket.id;
  await prisma.supportTicket.update({ where: { id: tenantPropertyTicketId }, data: { assignedEmployeeId: propertySupportEmployee.id } });
  const tenantPropertyDeviceRequest = await fetchJson(`${base}/api/v2/support/tickets/${tenantPropertyTicketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': propertySupportToken }, body: JSON.stringify({ requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantMembership.id, areaIds: [areaOne.id], targetIds: [propertyDevice.id] }) });
  if (tenantPropertyDeviceRequest.response.status !== 201 || tenantPropertyDeviceRequest.body.accessRequest?.touchesPropertyInfrastructure !== true) fail(`Tenant support targeting a permanent device was not marked as property infrastructure (${tenantPropertyDeviceRequest.response.status}/${tenantPropertyDeviceRequest.body.errorCode || tenantPropertyDeviceRequest.body.error || JSON.stringify(tenantPropertyDeviceRequest.body)})`);
  const tenantPropertyRequestId = tenantPropertyDeviceRequest.body.accessRequest.id;
  const tenantPropertyApproval = await fetchJson(`${base}/api/v2/support/tickets/${tenantPropertyTicketId}/access-requests/${tenantPropertyRequestId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ approve: true }) });
  if (tenantPropertyApproval.response.status !== 200 || !tenantPropertyApproval.body.oneUseCode) fail(`Tenant permanent-device support approval failed (${tenantPropertyApproval.response.status})`);
  const tenantPropertyIssue = await fetchJson(`${base}/api/v2/support/tickets/${tenantPropertyTicketId}/access-requests/${tenantPropertyRequestId}/issue`, { method: 'POST', headers: { 'x-dinodia-employee-session': propertySupportToken } });
  if (tenantPropertyIssue.response.status !== 200) fail(`Tenant permanent-device support issue failed (${tenantPropertyIssue.response.status})`);
  const tenantPropertyRow = await prisma.supportAccessRequest.findUnique({ where: { id: tenantPropertyRequestId }, select: { employeeHandoffHash: true, codeHash: true } });
  const tenantPropertyProof = supportProofOfPossessionDigest({ employeeProofHash: tenantPropertyRow.employeeHandoffHash, serial: identityOne.serialNumber, ticketId: tenantPropertyTicketId, requestId: tenantPropertyRequestId, codeHash: tenantPropertyRow.codeHash, identityGeneration: identityOne.identityGeneration });
  const tenantPropertyRedeemed = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, ticketId: tenantPropertyTicketId, requestId: tenantPropertyRequestId, code: tenantPropertyApproval.body.oneUseCode, employeeProofOfPossession: tenantPropertyProof } });
  if (tenantPropertyRedeemed.response.status !== 200 || tenantPropertyRedeemed.body.scope !== 'TENANT_SCOPE') fail(`Tenant permanent-device support redemption failed (${tenantPropertyRedeemed.response.status})`);
  const tenantPropertyNotification = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': propertyToken.body.token } });
  if (tenantPropertyNotification.response.status !== 200 || !tenantPropertyNotification.body.notifications?.some((item) => item.ticketId === tenantPropertyTicketId && item.eventType === 'STARTED')) fail('Tenant support touching a permanent property device did not notify the homeowner');
  const propertyRequest = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': propertySupportToken }, body: JSON.stringify({ requestedScope: 'PROPERTY_SCOPE', areaIds: [], targetIds: [propertyDevice.id] }) });
  if (propertyRequest.response.status !== 201 || propertyRequest.body.accessRequest?.touchesPropertyInfrastructure !== true) fail(`Property support request did not require property scope (${propertyRequest.response.status})`);
  const propertyRequestId = propertyRequest.body.accessRequest.id;
  const propertyNotificationBefore = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': propertyToken.body.token } });
  if (propertyNotificationBefore.response.status !== 200 || propertyNotificationBefore.body.notifications?.some((item) => item.ticketId === propertyTicketId)) fail('A homeowner was notified before property support was approved and redeemed');
  const propertyChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ operationKind: 'support_access_approve', targetIds: [propertyTicketId, propertyRequestId], value: 'I approve this support access for my property' }) });
  if (propertyChallenge.response.status !== 200) fail(`Property approval step-up challenge failed (${propertyChallenge.response.status})`);
  const propertySignature = crypto.sign(null, stepUpChallengeMessage({ challengeId: propertyChallenge.body.challengeId, nonce: propertyChallenge.body.nonce, operationDigest: propertyChallenge.body.operationDigest }), crypto.createPrivateKey(propertyPhone.privateKey)).toString('base64url');
  const propertyProof = await fetchJson(`${base}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ challengeId: propertyChallenge.body.challengeId, nonce: propertyChallenge.body.nonce, deviceSignature: propertySignature }) });
  if (propertyProof.response.status !== 200) fail(`Property approval step-up proof failed (${propertyProof.response.status})`);
  const propertyApproval = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${propertyRequestId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ approve: true, confirmation: 'I approve this support access for my property', proof: propertyProof.body.proof }) });
  if (propertyApproval.response.status !== 200 || !propertyApproval.body.oneUseCode) fail(`Distinct homeowner property approval failed (${propertyApproval.response.status}/${propertyApproval.body.errorCode || ''})`);
  const propertyIssue = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${propertyRequestId}/issue`, { method: 'POST', headers: { 'x-dinodia-employee-session': propertySupportToken } });
  if (propertyIssue.response.status !== 200) fail(`Property support issue failed (${propertyIssue.response.status})`);
  const propertySupportRow = await prisma.supportAccessRequest.findUnique({ where: { id: propertyRequestId }, select: { employeeHandoffHash: true, codeHash: true } });
  const propertyProofOfPossession = supportProofOfPossessionDigest({ employeeProofHash: propertySupportRow.employeeHandoffHash, serial: identityOne.serialNumber, ticketId: propertyTicketId, requestId: propertyRequestId, codeHash: propertySupportRow.codeHash, identityGeneration: identityOne.identityGeneration });
  const propertyRedeemed = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, ticketId: propertyTicketId, requestId: propertyRequestId, code: propertyApproval.body.oneUseCode, employeeProofOfPossession: propertyProofOfPossession } });
  if (propertyRedeemed.response.status !== 200 || propertyRedeemed.body.scope !== 'PROPERTY_SCOPE') fail(`Property support redemption failed (${propertyRedeemed.response.status})`);
  const propertyNotification = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': propertyToken.body.token } });
  if (propertyNotification.response.status !== 200 || !propertyNotification.body.notifications?.some((item) => item.eventType === 'STARTED' && item.ticketId === propertyTicketId)) fail('Property support redemption did not create the homeowner notification');
  const wrongApproverRevoke = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${propertyRequestId}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ confirmation: 'I revoke this support access for my property', proof: 'wrong-approver' }) });
  if (wrongApproverRevoke.response.status !== 403) fail(`A non-approving tenant revoked property support (${wrongApproverRevoke.response.status})`);
  const revokeChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ operationKind: 'support_access_revoke', targetIds: [propertyTicketId, propertyRequestId], value: 'I revoke this support access for my property' }) });
  if (revokeChallenge.response.status !== 200) fail(`Property revoke step-up challenge failed (${revokeChallenge.response.status})`);
  const revokeSignature = crypto.sign(null, stepUpChallengeMessage({ challengeId: revokeChallenge.body.challengeId, nonce: revokeChallenge.body.nonce, operationDigest: revokeChallenge.body.operationDigest }), crypto.createPrivateKey(propertyPhone.privateKey)).toString('base64url');
  const revokeProof = await fetchJson(`${base}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ challengeId: revokeChallenge.body.challengeId, nonce: revokeChallenge.body.nonce, deviceSignature: revokeSignature }) });
  const propertyRevoked = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${propertyRequestId}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ confirmation: 'I revoke this support access for my property', proof: revokeProof.body.proof }) });
  if (propertyRevoked.response.status !== 200 || propertyRevoked.body.status !== 'REVOKED') fail(`Same-approver property revoke failed (${propertyRevoked.response.status}/${propertyRevoked.body.errorCode || ''})`);
  const propertyNotificationsAfter = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': propertyToken.body.token } });
  const propertyEvents = (propertyNotificationsAfter.body.notifications || []).filter((item) => item.ticketId === propertyTicketId).map((item) => item.eventType).sort();
  if (propertyNotificationsAfter.response.status !== 200 || propertyEvents.join(',') !== 'REVOKED,STARTED') fail(`Property notification lifecycle was incomplete or leaked (${propertyEvents.join(',')})`);
  const propertySupportSessionRow = await prisma.supportSession.findFirst({ where: { accessRequestId: propertyRequestId }, select: { id: true } });
  const propertyHubRevoke = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/revocation', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, sessionId: propertySupportSessionRow.id, lease: propertyRedeemed.body.lease } });
  if (propertyHubRevoke.response.status !== 200) fail(`Property hub revocation acknowledgement failed (${propertyHubRevoke.response.status})`);
  await prisma.supportSession.deleteMany({ where: { accessRequestId: { in: [broadeningTenantRequest.body.accessRequest.id, tenantPropertyRequestId, propertyRequestId] } } });
  await prisma.supportAccessRequest.deleteMany({ where: { id: { in: [broadeningTenantRequest.body.accessRequest.id, tenantPropertyRequestId, propertyRequestId] } } });
  await prisma.supportTicket.delete({ where: { id: tenantPropertyTicketId } });
  await prisma.supportTicket.delete({ where: { id: propertyTicketId } });
  await prisma.employeeSession.delete({ where: { id: propertySupportSession.id } });
  await prisma.companyEmployeeAccount.delete({ where: { id: propertySupportEmployee.id } });

  // Exercise the real trusted-phone challenge/issue/consume path with a
  // non-device sensitive operation. The signature is the disposable phone's
  // Ed25519 key, standing in for the iOS LocalAuthentication-gated assertion.
  const stepUpTicket = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'STEP_UP_HARNESS', description: 'Disposable step-up close test' }) });
  if (stepUpTicket.response.status !== 201) fail(`Step-up ticket creation failed (${stepUpTicket.response.status})`);
  const stepUpTicketId = stepUpTicket.body.ticket.id;
  const challenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ operationKind: 'support_ticket_close', targetIds: [stepUpTicketId], value: null }) });
  if (challenge.response.status !== 200 || !challenge.body.challengeId) fail(`Trusted-phone step-up challenge was not issued (${challenge.response.status})`);
  const cancelledChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: challenge.body.challengeId }) });
  if (cancelledChallenge.response.status !== 200) fail(`Trusted-phone challenge cancellation failed (${cancelledChallenge.response.status})`);
  const cancelledIssue = await fetchJson(`${base}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: challenge.body.challengeId, nonce: challenge.body.nonce, deviceSignature: 'cancelled' }) });
  if (cancelledIssue.response.status !== 403) fail(`Cancelled trusted-phone challenge was accepted (${cancelledIssue.response.status})`);
  const liveChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ operationKind: 'support_ticket_close', targetIds: [stepUpTicketId], value: null }) });
  const phoneSignature = crypto.sign(null, stepUpChallengeMessage({ challengeId: liveChallenge.body.challengeId, nonce: liveChallenge.body.nonce, operationDigest: liveChallenge.body.operationDigest }), crypto.createPrivateKey(phone.privateKey)).toString('base64url');
  const proof = await fetchJson(`${base}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: liveChallenge.body.challengeId, nonce: liveChallenge.body.nonce, deviceSignature: phoneSignature }) });
  if (proof.response.status !== 200 || !proof.body.proof) fail(`Trusted-phone step-up proof was not issued (${proof.response.status})`);
  const closed = await fetchJson(`${base}/api/v2/support/tickets/${stepUpTicketId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ action: 'close', proof: proof.body.proof }) });
  if (closed.response.status !== 200 || closed.body.status !== 'CLOSED') fail(`Operation-bound support close was not consumed (${closed.response.status}/${closed.body.errorCode || closed.body.error || 'unknown'})`);
  const replayClose = await fetchJson(`${base}/api/v2/support/tickets/${stepUpTicketId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ action: 'close', proof: proof.body.proof }) });
  if (replayClose.response.status !== 403) fail(`Operation-bound support close replay was accepted (${replayClose.response.status})`);
  // The token returned above is the actual Platform-issued app token. Bind the
  // disposable OS instance to the same installation lineage and exercise the
  // OS HTTP authorization path, not just the issuer route.
  await hub.store.savePlatform({ hubInstallId: hubOne.id, policyRevision: 0 });
  await hub.store.saveArea({ name: 'Tenant area' }, areaOne.id);
  await hub.store.upsertDevice({
    id: 'harness-tenant-device',
    name: 'Harness tenant light',
    protocol: 'zigbee',
    areaId: areaOne.id,
    labelIds: ['tenant_device'],
    metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id },
    state: { state: 'OFF' },
    setup: { status: 'ready' },
    entities: {
      'harness-tenant-device:state': {
        name: 'Harness tenant light',
        stateKey: 'state',
        domain: 'switch',
        category: 'control',
        writable: true,
        primary: true,
        capability: { readable: true, writable: true, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }, { serviceId: 'switch.turn_off' }, { serviceId: 'switch.toggle' }] },
      },
    },
  });
  const tenantEntity = hub.model.entities().find((entity) => entity.device.id === 'harness-tenant-device');
  if (!tenantEntity) fail(`The fake physical device did not produce a current control descriptor (${JSON.stringify({ presentation: hub.store.getDevice('harness-tenant-device')?.presentation || null, entities: hub.store.getDevice('harness-tenant-device')?.entities || null })})`);
  // Exercise the actual OS signing path and the Platform verifier together.
  // The broker does not expose a descriptor-signing oracle: PlatformPairing
  // signs this fixed request path with the descriptor bytes as its body hash.
  hub.pairing.identityBroker = {
    async signPlatformRequest(input) {
      const canonical = [String(input.method).toUpperCase(), String(input.path), String(input.timestamp), String(input.nonce), String(input.bodyHash)].join('\n');
      return { signature: crypto.sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey(identityOneSigning.privateKey)).toString('base64url') };
    },
  };
  const descriptorTargetIds = [tenantDevice.id];
  const descriptorValue = { state: 'ON' };
  const descriptorControlId = String(tenantEntity.entity.id);
  const descriptorAttestedValue = { ...descriptorValue, controlId: descriptorControlId };
  const descriptorOperationValue = descriptorBoundValue(descriptorAttestedValue, { [tenantDevice.id]: 'descriptor-1' });
  const descriptor = {
    version: 1,
    serial: identityOne.serialNumber,
    identityGeneration: identityOne.identityGeneration,
    actorId: account.id,
    customerSessionId: session.id,
    trustedDeviceId: trusted.id,
    homeId: homeOne.id,
    membershipId: tenantMembership.id,
    hubInstallId: hubOne.id,
    operationKind: 'device_sensitive_command',
    targetIds: descriptorTargetIds,
    controlId: descriptorControlId,
    descriptorRevision: 1,
    descriptorDigest: 'descriptor-1',
    operationDigest: operationDigest({ actorId: account.id, trustedDeviceId: trusted.id, customerSessionId: session.id, homeId: homeOne.id, membershipId: tenantMembership.id, hubInstallationId: hubOne.id, operationKind: 'device_sensitive_command', targetIds: descriptorTargetIds, value: descriptorOperationValue }),
    nonce: `descriptor-${crypto.randomUUID()}`,
    issuedAt: Date.now(),
  };
  descriptor.hubSignature = await hub.pairing.signStepUpDescriptor(descriptor);
  const descriptorChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ operationKind: 'device_sensitive_command', targetIds: descriptorTargetIds, value: descriptorValue, descriptorAttestation: descriptor }) });
  if (descriptorChallenge.response.status !== 200 || !descriptorChallenge.body.challengeId) fail(`OS bounded step-up descriptor was not accepted by Platform (${descriptorChallenge.response.status}/${descriptorChallenge.body.errorCode || descriptorChallenge.body.error || ''})`);
  const descriptorCancelled = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: descriptorChallenge.body.challengeId }) });
  if (descriptorCancelled.response.status !== 200) fail(`The accepted descriptor challenge could not be cancelled safely (${descriptorCancelled.response.status})`);
  const WebSocket = createRequire(import.meta.url)(path.join(osRoot, 'node_modules', 'ws'));
  const wsMessage = (socket, label = 'message') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`authenticated OS WebSocket ${label} timeout`)), 5000);
    socket.once('message', (value) => { clearTimeout(timer); resolve(JSON.parse(String(value))); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const wsOpen = (socket, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`authenticated OS WebSocket ${label} open timeout`)), 5000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('unexpected-response', (_request, response) => { clearTimeout(timer); reject(new Error(`websocket ${label} unexpected HTTP ${response.statusCode}`)); });
    socket.once('close', (code, reason) => { if (socket.readyState !== 1) { clearTimeout(timer); reject(new Error(`websocket ${label} closed before open (${code}/${String(reason)})`)); } });
  });
  const socketUrl = `ws://127.0.0.1:${hub.server.address().port}/api/websocket`;
  const tenantSocket = new WebSocket(socketUrl);
  const tenantAuthRequired = wsMessage(tenantSocket, 'tenant auth_required');
  await wsOpen(tenantSocket, 'tenant');
  if ((await tenantAuthRequired).type !== 'auth_required') fail('Native WebSocket did not request authentication');
  tenantSocket.send(JSON.stringify({ type: 'auth', access_token: tenantToken.body.token }));
  if ((await wsMessage(tenantSocket, 'tenant auth_ok')).type !== 'auth_ok') fail('A Platform-issued tenant token was not accepted by the native WebSocket');
  tenantSocket.send(JSON.stringify({ id: 1, type: 'get_states' }));
  const tenantStates = await wsMessage(tenantSocket, 'tenant get_states');
  if (!tenantStates.success || !tenantStates.result.some((state) => state.entity_id === tenantEntity.haId)) fail('Tenant WebSocket did not return its current authorized descriptor');
  tenantSocket.send(JSON.stringify({ id: 2, type: 'call_service', domain: 'switch', service: 'turn_on', target: { entity_id: tenantEntity.haId } }));
  const commandResult = await wsMessage(tenantSocket, 'tenant command');
  if (!commandResult.success || fakePhysicalCommandCount !== 1) {
    const tokenClaims = JSON.parse(Buffer.from(String(tenantToken.body.token).split('.')[2], 'base64url').toString('utf8'));
    fail(`Authorized command did not reach the safe fake physical adapter (${JSON.stringify({ commandResult, fakePhysicalCommandCount, token: { householdRole: tokenClaims.householdRole, scope: tokenClaims.scope, areaIds: tokenClaims.areaIds, membershipId: tokenClaims.membershipId, hubInstallationId: tokenClaims.hubInstallationId }, entity: { haId: tenantEntity.haId, capability: tenantEntity.entity?.capability, device: { areaId: tenantEntity.device.areaId, metadata: tenantEntity.device.metadata, labelIds: tenantEntity.device.labelIds } } })})`);
  }
  for (const { role, token } of [
    { role: 'owner', token: propertyToken.body.token },
    { role: 'property manager', token: managerToken.body.token },
  ]) {
    const roleSocket = new WebSocket(socketUrl);
    const roleAuthRequired = wsMessage(roleSocket, `same-home ${role} auth_required`);
    await wsOpen(roleSocket, `same-home ${role}`);
    if ((await roleAuthRequired).type !== 'auth_required') fail(`Same-home ${role} WebSocket did not request authentication`);
    roleSocket.send(JSON.stringify({ type: 'auth', access_token: token }));
    if ((await wsMessage(roleSocket, `same-home ${role} auth_ok`)).type !== 'auth_ok') fail(`Valid same-home ${role} token was not distinguished from invalid authentication`);
    roleSocket.send(JSON.stringify({ id: 10, type: 'get_states' }));
    const roleStates = await wsMessage(roleSocket, `same-home ${role} filtered states`);
    if (!roleStates.success || roleStates.result.some((state) => state.entity_id === tenantEntity.haId)) fail(`${role} WebSocket exposed tenant-private device state`);
    roleSocket.send(JSON.stringify({ id: 11, type: 'call_service', domain: 'switch', service: 'turn_on', target: { entity_id: tenantEntity.haId } }));
    const roleCommand = await wsMessage(roleSocket, `same-home ${role} denied command`);
    if (roleCommand.success || roleCommand.error?.code !== 'insufficient_scope' || fakePhysicalCommandCount !== 1) fail(`Same-home ${role} command was not denied without a physical side effect`);
    roleSocket.close();
  }

  await hub.store.upsertDevice({
    id: 'harness-tenant-device', name: 'Harness tenant light', protocol: 'zigbee', areaId: areaTwo.id,
    labelIds: ['tenant_device'], metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id }, state: { state: 'OFF' }, setup: { status: 'ready' },
    entities: { 'harness-tenant-device:state': { name: 'Harness tenant light', stateKey: 'state', domain: 'switch', category: 'control', writable: true, primary: true, capability: { readable: true, writable: true, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }] } } },
  });
  tenantSocket.send(JSON.stringify({ id: 12, type: 'call_service', domain: 'switch', service: 'turn_on', target: { entity_id: tenantEntity.haId } }));
  const movedDeviceCommand = await wsMessage(tenantSocket, 'moved tenant device command');
  if (movedDeviceCommand.success || fakePhysicalCommandCount !== 1) fail('Tenant command remained allowed after its device moved outside the granted area');
  await hub.store.upsertDevice({
    id: 'harness-tenant-device', name: 'Harness tenant light', protocol: 'zigbee', areaId: areaOne.id,
    labelIds: ['tenant_device'], metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id }, state: { state: 'OFF' }, setup: { status: 'ready' },
    entities: { 'harness-tenant-device:state': { name: 'Harness tenant light', stateKey: 'state', domain: 'switch', category: 'control', writable: true, primary: true, capability: { readable: true, writable: true, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }, { serviceId: 'switch.turn_off' }, { serviceId: 'switch.toggle' }] } } },
  });
  await hub.store.upsertDevice({
    id: 'harness-tenant-device',
    name: 'Harness tenant light',
    protocol: 'zigbee',
    areaId: areaOne.id,
    labelIds: ['tenant_device'],
    metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id },
    state: { state: 'OFF' },
    setup: { status: 'ready' },
    entities: {
      'harness-tenant-device:state': {
        name: 'Harness tenant light', stateKey: 'state', domain: 'switch', category: 'control', writable: false, primary: true,
        capability: { readable: true, writable: false, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }] },
      },
    },
  });
  tenantSocket.send(JSON.stringify({ id: 3, type: 'call_service', domain: 'switch', service: 'turn_on', target: { entity_id: tenantEntity.haId } }));
  const staleDescriptorResult = await wsMessage(tenantSocket, 'stale descriptor command');
  if (staleDescriptorResult.success || fakePhysicalCommandCount !== 1) fail('A descriptor mutation did not deny the stale WebSocket command without a physical side effect');
  const policyClosed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('policy-revoked WebSocket did not close')), 5000);
    tenantSocket.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason) }); });
    tenantSocket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  await hub.store.savePlatform({ policyRevision: 2 });
  tenantSocket.send(JSON.stringify({ id: 4, type: 'get_states' }));
  const policyClosure = await policyClosed;
  if (policyClosure.code !== 4401) fail(`Policy revision did not close the authenticated WebSocket (${policyClosure.code})`);
  await hub.store.upsertDevice({
    id: 'harness-tenant-device', name: 'Harness tenant light', protocol: 'zigbee', areaId: areaOne.id,
    labelIds: ['tenant_device'], metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id }, state: { state: 'OFF' }, setup: { status: 'ready' },
    entities: { 'harness-tenant-device:state': { name: 'Harness tenant light', stateKey: 'state', domain: 'switch', category: 'control', writable: true, primary: true, capability: { readable: true, writable: true, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }, { serviceId: 'switch.turn_off' }, { serviceId: 'switch.toggle' }] } } },
  });
  const ownerSocket = new WebSocket(socketUrl);
  const ownerAuthRequired = wsMessage(ownerSocket, 'owner auth_required');
  await wsOpen(ownerSocket, 'owner');
  if ((await ownerAuthRequired).type !== 'auth_required') fail('Wrong-home WebSocket did not request authentication');
  ownerSocket.send(JSON.stringify({ type: 'auth', access_token: ownerToken.body.token }));
  const ownerAuth = await wsMessage(ownerSocket, 'owner auth_invalid');
  if (ownerAuth.type !== 'auth_invalid') fail('A token for another home authenticated to this hub WebSocket');
  ownerSocket.close();
  const tenantDeviceAfter = hub.store.getDevice('harness-tenant-device');
  if (tenantDeviceAfter?.state?.state !== 'OFF') fail('The fake physical denial fixture was unexpectedly mutated before authorization');
  const offlineGrantId = `offline-${crypto.randomUUID()}`;
  const offlineSecurity = hub.store.getSecurity();
  await hub.store.saveSecurity({ offlineAuthorisations: {
    ...(offlineSecurity.offlineAuthorisations || {}),
    [offlineGrantId]: {
      version: 1,
      id: offlineGrantId,
      homeId: homeOne.id,
      hubInstallId: hubOne.id,
      membershipId: tenantMembership.id,
      trustedDeviceId: trusted.id,
      userId: account.id,
      householdRole: 'TENANT',
      publicKey: phone.publicKey,
      areaIds: [areaOne.id],
      scope: ['tenant:device-command'],
      policyRevision: 0,
      issuedAt: Date.now(),
      expiresAt: null,
      revokedAt: null,
    },
  }});
  const offlineCommandValue = {};
  const offlineControlId = String(tenantEntity.entity.id);
  if (!hub.model.findEntity(offlineControlId) || !hub.model.findEntity(tenantEntity.haId)) fail(`OS model cannot resolve the current descriptor by raw or public id (${offlineControlId}/${tenantEntity.haId})`);
  const offlineValueDigest = sha256(JSON.stringify({ deviceId: 'harness-tenant-device', entityId: tenantEntity.haId, controlId: offlineControlId, serviceId: 'switch.turn_on', value: offlineCommandValue }));
  const offlineChallenge = { v: 1, homeId: homeOne.id, hubInstallId: hubOne.id, areaId: areaOne.id, deviceId: 'harness-tenant-device', controlId: offlineControlId, valueDigest: offlineValueDigest, nonce: `offline-nonce-${crypto.randomUUID()}`, issuedAt: Date.now() };
  const offlineSignature = crypto.sign(null, Buffer.from(JSON.stringify(offlineChallenge), 'utf8'), crypto.createPrivateKey(phone.privateKey)).toString('base64url');
  const offlineHeaders = { 'x-dinodia-offline-grant': offlineGrantId, 'x-dinodia-offline-challenge': Buffer.from(JSON.stringify(offlineChallenge), 'utf8').toString('base64url'), 'x-dinodia-offline-signature': offlineSignature };
  const osBase = `http://127.0.0.1:${hub.server.address().port}`;
  const offlineEntityPath = encodeURIComponent(String(tenantEntity.entity.id));
  const offlineCommand = await fetchJson(`${osBase}/_dinodia/admin/api/entities/${offlineEntityPath}/service`, { method: 'POST', headers: { 'content-type': 'application/json', ...offlineHeaders }, body: JSON.stringify({ serviceId: 'switch.turn_on', data: offlineCommandValue }) });
  if (offlineCommand.response.status !== 200 || fakePhysicalCommandCount !== 2) fail(`Signed offline command did not reach the safe adapter (${offlineCommand.response.status}/${fakePhysicalCommandCount}/${JSON.stringify(offlineCommand.body)})`);
  const offlineReplay = await fetchJson(`${osBase}/_dinodia/admin/api/entities/${offlineEntityPath}/service`, { method: 'POST', headers: { 'content-type': 'application/json', ...offlineHeaders }, body: JSON.stringify({ serviceId: 'switch.turn_on', data: offlineCommandValue }) });
  if (offlineReplay.response.status !== 401) fail(`Signed offline nonce replay was accepted (${offlineReplay.response.status})`);
  const wrongOfflineChallenge = { ...offlineChallenge, nonce: `offline-wrong-value-${crypto.randomUUID()}`, valueDigest: sha256(JSON.stringify({ deviceId: 'harness-tenant-device', entityId: tenantEntity.haId, controlId: offlineControlId, serviceId: 'switch.turn_on', value: { changed: true } })) };
  const wrongOfflineHeaders = { ...offlineHeaders, 'x-dinodia-offline-challenge': Buffer.from(JSON.stringify(wrongOfflineChallenge), 'utf8').toString('base64url'), 'x-dinodia-offline-signature': crypto.sign(null, Buffer.from(JSON.stringify(wrongOfflineChallenge), 'utf8'), crypto.createPrivateKey(phone.privateKey)).toString('base64url') };
  const wrongOffline = await fetchJson(`${osBase}/_dinodia/admin/api/entities/${offlineEntityPath}/service`, { method: 'POST', headers: { 'content-type': 'application/json', ...wrongOfflineHeaders }, body: JSON.stringify({ serviceId: 'switch.turn_on', data: offlineCommandValue }) });
  if (wrongOffline.response.status !== 403 || fakePhysicalCommandCount !== 2) fail(`Offline value mismatch was not denied without a side effect (${wrongOffline.response.status}/${fakePhysicalCommandCount})`);
  await prisma.trustedDevice.update({ where: { id: trusted.id }, data: { sessionVersion: { increment: 1 } } });
  const revokedByPhoneRotation = await issue(homeOne.id);
  if (revokedByPhoneRotation.response.status !== 401) fail(`Trusted-device rotation did not invalidate the old customer session (${revokedByPhoneRotation.response.status})`);
  const revokedSecondHomeSession = await issue(homeTwo.id);
  if (revokedSecondHomeSession.response.status !== 401) fail(`Trusted-device rotation did not revoke the account-wide second-home session (${revokedSecondHomeSession.response.status})`);
  const operatorPassword = `harness-installer-password-${crypto.randomUUID()}`;
  const operatorEmail = `installer-${crypto.randomUUID()}@invalid.test`;
  const operatorEmployee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Harness Installer', email: operatorEmail, emailNormalized: operatorEmail, role: 'INSTALLER', status: 'ACTIVE', passwordHash: hashPassword(operatorPassword) } });
  const operatorLogin = await loginEmployee(base, operatorEmployee, operatorPassword);
  const operatorSession = operatorLogin.session;
  const operatorToken = operatorLogin.token;
  const operatorWork = await prisma.companyOperationalWorkItem.create({ data: { publicReference: `DIN-${sha256(`handoff-${crypto.randomUUID()}`).slice(0, 16).toUpperCase()}`, kind: 'INITIAL_HUB_INSTALLATION', state: 'ASSIGNED', homeId: homeOne.id, hubInstallationId: hubOne.id, certifiedSerialNumber: identityOne.serialNumber, assignedEmployeeId: operatorEmployee.id, createdByEmployeeId: operatorEmployee.id, reason: 'Disposable browser-bound operator handoff test' } });
  customerFixture = { accountId: account.id, sessionId: session.id, trustedDeviceId: trusted.id, propertyAccountId: propertyAccount.id, propertySessionId: propertySession.id, propertyTrustedDeviceId: propertyTrusted.id, managerAccountId: managerAccount.id, managerMembershipId: managerMembership.id, managerSessionId: managerSession.id, managerTrustedDeviceId: managerTrusted.id, homeOneId: homeOne.id, homeTwoId: homeTwo.id, hubOneId: hubOne.id, hubTwoId: hubTwo.id, identityOneId: identityOne.id, identityTwoId: identityTwo.id, tenantDeviceId: tenantDevice.id, machineSecret, tenantMembershipId: tenantMembership.id, ownerMembershipId: ownerMembership.id, propertyMembershipId: propertyMembership.id, areaOneId: areaOne.id, areaTwoId: areaTwo.id, tenantToken: tenantToken.body.token, ownerToken: ownerToken.body.token, propertyToken: propertyToken.body.token, managerToken: managerToken.body.token, ticketId, stepUpTicketId, identityOneSigningPrivateKey: identityOneSigning.privateKey, identityOneSigningPublicKey: identityOneSigning.publicKey, identityOneEncryptionPrivateKey: identityOneEncryption.privateKey, identityOneEncryptionPublicKey: identityOneEncryption.publicKey, identityOneSerial: identityOne.serialNumber, identityOneGeneration: identityOne.identityGeneration, operatorEmployeeId: operatorEmployee.id, operatorSessionId: operatorSession.id, operatorWorkId: operatorWork.id, operatorToken };
}

async function operatorMutationChecks() {
  const base = `http://127.0.0.1:${appPort}`;
  const homeId = customerFixture.homeOneId;
  const hubId = customerFixture.hubOneId;
  const employeePassword = `harness-cxo-operator-${crypto.randomUUID()}`;
  const employeeEmail = `operator-cxo-${crypto.randomUUID()}@invalid.test`;
  const employee = await prisma.companyEmployeeAccount.create({ data: {
    displayName: 'Harness CXO operator mutation',
    email: employeeEmail,
    emailNormalized: employeeEmail,
    role: 'CXO',
    status: 'ACTIVE',
    passwordHash: hashPassword(employeePassword),
  } });
  const login = await loginEmployee(base, employee, employeePassword);
  const makeWork = async (suffix) => prisma.companyOperationalWorkItem.create({ data: {
    publicReference: `DIN-${sha256(`operator-mutation-${suffix}-${crypto.randomUUID()}`).slice(0, 16).toUpperCase()}`,
    kind: 'INITIAL_HUB_INSTALLATION',
    state: 'IN_PROGRESS',
    homeId,
    hubInstallationId: hubId,
    certifiedSerialNumber: customerFixture.identityOneSerial,
    assignedEmployeeId: employee.id,
    createdByEmployeeId: employee.id,
    reason: `Disposable operator mutation ${suffix}`,
  } });
  const work = await makeWork('primary');
  const alternateWork = await makeWork('alternate');
  const idempotencyKeys = [];
  const post = (action, key, workflowId, extra = {}) => {
    idempotencyKeys.push(key);
    return fetchJson(`${base}/api/installer/home-support/homes/${encodeURIComponent(homeId)}/os-access/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(login.jar),
        'idempotency-key': key,
      },
      body: JSON.stringify({ workflowId, ...extra }),
    });
  };
  const createdVersions = new Set();
  const baselineVersion = (await prisma.hubCredentialVersion.aggregate({ where: { hubInstallationId: hubId, purpose: 'operator-credential' }, _max: { version: true } }))._max.version ?? 0;
  const originalHub = await prisma.hubInstallation.findUnique({ where: { id: hubId }, select: { currentOperatorCredentialVersion: true, accessPolicyRevision: true } });
  try {
    const firstKey = `operator-rotate-initial-${crypto.randomUUID()}`;
    const first = await post('rotate', firstKey, work.id);
    if (first.response.status !== 200 || first.body.state !== 'PENDING' || !Number.isInteger(first.body.version)) fail(`Authenticated operator rotation failed (${first.response.status}/${first.body.errorCode || 'unknown'})`);
    const returnedCredentialText = JSON.stringify(first.body);
    if (/dno_ops_|tokenHash|encryptedDeliveryEnvelope|privateKey|secret/i.test(returnedCredentialText)) fail('Operator rotation response exposed reusable credential material');
    createdVersions.add(first.body.version);
    const visibleStatus = await fetchJson(`${base}/api/installer/home-support/homes/${encodeURIComponent(homeId)}/os-access/status?workflowId=${encodeURIComponent(work.id)}`, { headers: { cookie: cookieHeader(login.jar) } });
    if (visibleStatus.response.status !== 200 || visibleStatus.body.credentials?.[0]?.version !== first.body.version || visibleStatus.body.credentials?.[0]?.state !== 'PENDING') fail('Authenticated operator status did not expose the durable lifecycle state');
    if (/dno_ops_|tokenHash|encryptedDeliveryEnvelope|privateKey|secret/i.test(JSON.stringify(visibleStatus.body))) fail('Operator status response exposed reusable credential material');
    const firstRowCount = await prisma.hubCredentialVersion.count({ where: { hubInstallationId: hubId, purpose: 'operator-credential' } });
    const rateKey = `operator-rotate:${employee.id}:${hubId}`;
    const mutationRecord = await prisma.idempotencyRecord.findUniqueOrThrow({ where: { namespace_keyHash: { namespace: 'operator-rotate:v1', keyHash: sha256(`${employee.id}:${firstKey}`) } }, select: { actorId: true, homeId: true, hubInstallationId: true, requestHash: true } });
    if (mutationRecord.actorId !== employee.id || mutationRecord.homeId !== homeId || mutationRecord.hubInstallationId !== hubId || !mutationRecord.requestHash) fail('Operator idempotency record is not durably bound to the resolved actor, home, hub and workflow request');
    const firstRateBucket = await prisma.authRateLimitBucket.findUniqueOrThrow({ where: { bucketKey: rateKey }, select: { attempts: true } });
    const replay = await post('rotate', firstKey, work.id);
    if (replay.response.status !== 200 || replay.body.version !== first.body.version || canonicalValue(replay.body) !== canonicalValue(first.body)) fail('Exact operator rotate retry did not return its original result');
    if (await prisma.hubCredentialVersion.count({ where: { hubInstallationId: hubId, purpose: 'operator-credential' } }) !== firstRowCount) fail('Exact operator rotate retry created a duplicate credential version');
    const replayRateBucket = await prisma.authRateLimitBucket.findUniqueOrThrow({ where: { bucketKey: rateKey }, select: { attempts: true } });
    if (replayRateBucket.attempts !== firstRateBucket.attempts) fail('Exact operator retry consumed an additional rate-limit attempt');

    const conflict = await post('rotate', firstKey, alternateWork.id);
    if (conflict.response.status !== 409) fail(`Conflicting operator idempotency-key reuse was accepted (${conflict.response.status})`);

    const concurrentKey = `operator-rotate-race-${crypto.randomUUID()}`;
    const concurrent = await Promise.all([post('rotate', concurrentKey, alternateWork.id), post('rotate', concurrentKey, alternateWork.id)]);
    if (concurrent.some((entry) => entry.response.status !== 200 || entry.body.version !== concurrent[0].body.version)) fail(`Concurrent same-key rotations did not converge (${concurrent.map((entry) => entry.response.status).join('/')})`);
    createdVersions.add(concurrent[0].body.version);
    if (await prisma.hubCredentialVersion.count({ where: { hubInstallationId: hubId, purpose: 'operator-credential' } }) !== firstRowCount + 1) fail('Concurrent same-key rotation created more than one credential version');
    const concurrentRateBucket = await prisma.authRateLimitBucket.findUniqueOrThrow({ where: { bucketKey: rateKey }, select: { attempts: true } });
    if (concurrentRateBucket.attempts !== firstRateBucket.attempts + 1) fail('Concurrent same-key rotation consumed more than one rate-limit attempt');

    for (let index = 0; index < 3; index += 1) {
      const key = `operator-rotate-limit-${index}-${crypto.randomUUID()}`;
      const accepted = await post('rotate', key, work.id);
      if (accepted.response.status !== 200) fail(`Operator rotation attempt ${index + 3} was unexpectedly denied (${accepted.response.status})`);
      createdVersions.add(accepted.body.version);
    }
    const sixth = await post('rotate', `operator-rotate-sixth-${crypto.randomUUID()}`, work.id);
    if (sixth.response.status !== 429) fail(`The sixth operator rotation attempt was not rate-limited (${sixth.response.status})`);

    const exactHourBoundary = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.authRateLimitBucket.update({ where: { bucketKey: rateKey }, data: { windowStart: exactHourBoundary, attempts: 5, attemptTimestamps: Array.from({ length: 5 }, () => exactHourBoundary.toISOString()), blockedUntil: null } });
    const boundary = await post('rotate', `operator-rotate-boundary-${crypto.randomUUID()}`, work.id);
    if (boundary.response.status !== 200) fail(`Operator rotate window did not reset at the one-hour boundary (${boundary.response.status})`);
    createdVersions.add(boundary.body.version);

    const revokeKey = `operator-revoke-initial-${crypto.randomUUID()}`;
    const revoke = await post('revoke', revokeKey, work.id, { reason: 'Disposable operator revoke idempotency test' });
    if (revoke.response.status !== 200 || typeof revoke.body.revoked !== 'number') fail(`Authenticated operator revocation failed (${revoke.response.status})`);
    const revokeReplay = await post('revoke', revokeKey, work.id, { reason: 'Disposable operator revoke idempotency test' });
    if (revokeReplay.response.status !== 200 || JSON.stringify(revokeReplay.body) !== JSON.stringify(revoke.body)) fail('Exact operator revoke retry did not return its original result');
    const conflictingRevoke = await post('revoke', revokeKey, work.id, { reason: 'Different reason for same idempotency key' });
    if (conflictingRevoke.response.status !== 409) fail(`Conflicting operator revoke idempotency-key reuse was accepted (${conflictingRevoke.response.status})`);

    for (let index = 0; index < 4; index += 1) {
      const accepted = await post('revoke', `operator-revoke-limit-${index}-${crypto.randomUUID()}`, work.id, { reason: `Disposable rate test ${index}` });
      if (accepted.response.status !== 200) fail(`Operator revoke attempt ${index + 2} was unexpectedly denied (${accepted.response.status})`);
    }
    const sixthRevoke = await post('revoke', `operator-revoke-sixth-${crypto.randomUUID()}`, work.id, { reason: 'Sixth attempt must be denied' });
    if (sixthRevoke.response.status !== 429) fail(`The sixth operator revoke attempt was not rate-limited (${sixthRevoke.response.status})`);
    const revokedRows = await prisma.hubCredentialVersion.count({ where: { hubInstallationId: hubId, purpose: 'operator-credential', state: 'REVOKED', version: { gt: baselineVersion } } });
    if (revokedRows !== createdVersions.size) fail(`Operator revocation did not revoke every created test version (${revokedRows}/${createdVersions.size})`);
    console.log('[stage1:integration] PASS: operator rotate/revoke routes enforce five-per-hub limits and transactionally replay idempotent results under concurrency');
  } finally {
    await prisma.hubCredentialVersion.deleteMany({ where: { hubInstallationId: hubId, purpose: 'operator-credential', version: { gt: baselineVersion } } }).catch(() => {});
    await prisma.idempotencyRecord.deleteMany({ where: { actorId: employee.id, namespace: { in: ['operator-rotate:v1', 'operator-revoke:v1'] } } }).catch(() => {});
    await prisma.authRateLimitBucket.deleteMany({ where: { bucketKey: { in: [`operator-rotate:${employee.id}:${hubId}`, `operator-revoke:${employee.id}:${hubId}`] } } }).catch(() => {});
    await prisma.auditEvent.deleteMany({ where: { actorType: 'EMPLOYEE', actorId: employee.id } }).catch(() => {});
    await prisma.hubInstallation.update({ where: { id: hubId }, data: { currentOperatorCredentialVersion: originalHub?.currentOperatorCredentialVersion ?? null, accessPolicyRevision: originalHub?.accessPolicyRevision ?? 0 } }).catch(() => {});
    await prisma.companyOperationalWorkItem.deleteMany({ where: { id: { in: [work.id, alternateWork.id] } } }).catch(() => {});
    await prisma.employeeSession.deleteMany({ where: { employeeId: employee.id } }).catch(() => {});
    await prisma.companyEmployeeAccount.delete({ where: { id: employee.id } }).catch(() => {});
  }
}

async function osChecks() {
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const platformBase = `http://127.0.0.1:${appPort}`;
  const osHost = new URL(base).host;
  const osOrigin = `http://${osHost}`;
  // The production hub uses dinodia-identityd over its restricted Unix
  // socket.  This disposable harness supplies the same narrow broker
  // contract in-process so the real production HTTP path can be exercised
  // without copying private key material into the OS application or logs.
  hub.pairing.apiUrl = platformBase;
  await hub.vault.set('platform.machineCredential', customerFixture.machineSecret);
  await hub.store.savePlatform({ paired: true, hubInstallId: customerFixture.hubOneId, provisioningCredentialVersion: 1, operatorCredentialVersion: 2, operatorCredentialStates: [{ version: 2, state: 'ACTIVE', graceUntil: null }], policyRevision: 0 });
  hub.pairing.identityBroker = {
    async getPublicIdentity() {
      return {
        serial: customerFixture.identityOneSerial,
        signingPublicKeyPem: customerFixture.identityOneSigningPublicKey,
        encryptionPublicKeyPem: customerFixture.identityOneEncryptionPublicKey,
        publicKeyFingerprint: publicKeyFingerprint(customerFixture.identityOneSigningPublicKey),
        encryptionKeyFingerprint: publicKeyFingerprint(customerFixture.identityOneEncryptionPublicKey),
        manufacturingSignature: '',
        generation: customerFixture.identityOneGeneration,
      };
    },
    async signPlatformRequest(input) {
      const canonical = [String(input.method).toUpperCase(), String(input.path), String(input.timestamp), String(input.nonce), String(input.bodyHash)].join('\n');
      return { signature: crypto.sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey(customerFixture.identityOneSigningPrivateKey)).toString('base64url') };
    },
    async decryptMachineCredentialEnvelope(input) {
      return { credential: decryptHubEnvelope(input.envelope, customerFixture.identityOneEncryptionPrivateKey, input.purpose, input.version) };
    },
  };
  const platformTenantRead = await fetchJson(`${base}/_dinodia/admin/api/devices`, { headers: { authorization: `Bearer ${customerFixture.tenantToken}` } });
  if (platformTenantRead.response.status !== 200) fail(`A real Platform-issued tenant token was not accepted by Dinodia OS (${platformTenantRead.response.status}/${platformTenantRead.body.errorCode || platformTenantRead.body.error || 'unknown'})`);
  const wrongHomeReplay = await fetchJson(`${base}/_dinodia/admin/api/devices`, { headers: { authorization: `Bearer ${customerFixture.ownerToken}` } });
  if (wrongHomeReplay.response.status !== 401) fail(`A Platform token for the other home was accepted by Dinodia OS (${wrongHomeReplay.response.status})`);
  const setup = await fetch(`${base}/setup`, { headers: { host: '127.0.0.1' } });
  if (setup.status !== 200) fail(`OS locked setup returned ${setup.status}`);
  const setupPage = await setup.text();
  if (!setupPage.includes('Dinodia OS') && !setupPage.includes('data-empty')) fail('OS setup did not serve the locked setup surface');
  if ((await fetch(`${base}/api/status`, { headers: { host: '127.0.0.1' } })).status !== 401) fail('OS unauthenticated API was not denied');
  if ((await fetch(`${base}/_dinodia/setup/status`, { headers: { host: '127.0.0.1' } })).status !== 403) fail('OS second browser was not locked');

  // Full operator handoff: browser A is created and registered by the hub,
  // Portal issues only an opaque handoff against assigned work, browser B
  // cannot redeem a copied id, and browser A receives only an HttpOnly OS
  // session handle.  No bearer or one-use secret is asserted in any response.
  const browserA = {};
  updateCookieJar(browserA, setup);
  const setupAttempt = await fetchJson(`${base}/_dinodia/setup/operator-attempt`, {
    method: 'POST',
    headers: { host: osHost, origin: osOrigin, cookie: cookieHeader(browserA), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(browserA, 'dinodia_setup_csrf')) },
  });
  if (setupAttempt.response.status !== 200 || setupAttempt.body.setupAttemptId !== decodeURIComponent(cookieValue(browserA, 'dinodia_operator_attempt'))) fail(`Hub-created operator browser attempt was not registered (${setupAttempt.response.status}/${setupAttempt.body.errorCode || setupAttempt.body.error || 'unknown'})`);
  const identityCheck = await prisma.hubManufacturingIdentity.findFirst({ where: { serialNumber: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration }, select: { status: true, serialNumber: true, identityGeneration: true } });
  if (!identityCheck || identityCheck.status !== 'ACTIVE') fail(`Operator fixture identity is not active before handoff (${JSON.stringify(identityCheck)})`);
  const hubIdentity = hub.store.getIdentity?.() || {};
  if (String(hubIdentity.serial || '') !== customerFixture.identityOneSerial) fail(`Disposable hub serial is not bound to the registered manufacturing serial (${String(hubIdentity.serial || '')}/${customerFixture.identityOneSerial})`);
  const wrongHomeLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeTwoId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: setupAttempt.body.setupAttemptId }),
  });
  if (wrongHomeLaunch.response.status !== 403) fail(`Operator work was accepted for a different home (${wrongHomeLaunch.response.status})`);
  const wrongAttemptLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: crypto.randomBytes(32).toString('base64url') }),
  });
  if (wrongAttemptLaunch.response.status !== 403) fail(`An unregistered setup attempt was accepted for operator handoff (${wrongAttemptLaunch.response.status})`);

  const wrongEmployeePassword = `harness-wrong-employee-${crypto.randomUUID()}`;
  const wrongEmployeeEmail = `other-installer-${crypto.randomUUID()}@invalid.test`;
  const wrongEmployee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Different assigned employee', email: wrongEmployeeEmail, emailNormalized: wrongEmployeeEmail, role: 'INSTALLER', status: 'ACTIVE', passwordHash: hashPassword(wrongEmployeePassword) } });
  const wrongEmployeeLogin = await loginEmployee(platformBase, wrongEmployee, wrongEmployeePassword);
  try {
    const wrongEmployeeLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(wrongEmployeeLogin.jar) },
      body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: setupAttempt.body.setupAttemptId }),
    });
    if (wrongEmployeeLaunch.response.status !== 403) fail(`A different active employee received an unassigned operator handoff (${wrongEmployeeLaunch.response.status})`);
  } finally {
    await prisma.employeeSession.deleteMany({ where: { employeeId: wrongEmployee.id } }).catch(() => {});
    await prisma.companyEmployeeAccount.delete({ where: { id: wrongEmployee.id } }).catch(() => {});
  }

  const expiredSetup = await fetch(`${base}/setup`, { headers: { host: '127.0.0.1' } });
  const expiredBrowser = {};
  updateCookieJar(expiredBrowser, expiredSetup);
  const expiredRegistration = await fetchJson(`${base}/_dinodia/setup/operator-attempt`, {
    method: 'POST',
    headers: { host: osHost, origin: osOrigin, cookie: cookieHeader(expiredBrowser), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(expiredBrowser, 'dinodia_setup_csrf')) },
  });
  if (expiredRegistration.response.status !== 200 || !expiredRegistration.body.setupAttemptId) fail(`Could not register disposable attempt for expiry denial (${expiredRegistration.response.status})`);
  await prisma.operatorBrowserAttempt.update({ where: { attemptId: expiredRegistration.body.setupAttemptId }, data: { expiresAt: new Date(Date.now() - 1) } });
  const expiredAttemptLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: expiredRegistration.body.setupAttemptId }),
  });
  if (expiredAttemptLaunch.response.status !== 403) fail(`An expired hub-created browser attempt received an operator handoff (${expiredAttemptLaunch.response.status})`);
  const launch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: setupAttempt.body.setupAttemptId }),
  });
  if (launch.response.status !== 200 || !launch.body.handoffId || launch.body.handoffSecret || launch.body.operatorToken || launch.body.sessionGrant) fail(`Company Portal did not issue an opaque operator handoff (${launch.response.status})`);
  const handoffJson = JSON.stringify(launch.body);
  if (/dno1\.|osb_|handoffSecret|secret/i.test(handoffJson)) fail('Company Portal handoff response contained a reusable credential');
  const directPrepare = await machineRequest({ base: platformBase, path: '/api/hub-agent/operator-session/consume', machineSecret: customerFixture.machineSecret, body: { serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, handoffId: launch.body.handoffId, browserBinding: decodeURIComponent(cookieValue(browserA, 'dinodia_operator_binding')), setupAttemptId: setupAttempt.body.setupAttemptId, phase: 'prepare' } });
  if (directPrepare.response.status !== 200 || !directPrepare.body.handoffSecretEnvelope) fail(`Machine-authenticated handoff prepare failed before OS consumption (${directPrepare.response.status}/${directPrepare.body.errorCode || directPrepare.body.error || 'unknown'})`);
  const missingSecretConsume = await machineRequest({ base: platformBase, path: '/api/hub-agent/operator-session/consume', machineSecret: customerFixture.machineSecret, body: { serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, handoffId: launch.body.handoffId, browserBinding: decodeURIComponent(cookieValue(browserA, 'dinodia_operator_binding')), setupAttemptId: setupAttempt.body.setupAttemptId, phase: 'consume' } });
  if (missingSecretConsume.response.status !== 401 || missingSecretConsume.body.errorCode !== 'handoff_secret_required') fail(`A machine handoff was consumed without proof of its one-use secret (${missingSecretConsume.response.status}/${missingSecretConsume.body.errorCode || 'unknown'})`);

  const setupB = await fetch(`${base}/setup`, { headers: { host: '127.0.0.1' } });
  const browserB = {};
  updateCookieJar(browserB, setupB);
  const copiedHandoff = await fetchJson(`${base}/_dinodia/setup/operator-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: osHost, origin: osOrigin, cookie: cookieHeader(browserB), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(browserB, 'dinodia_setup_csrf')) },
    body: JSON.stringify({ handoffId: launch.body.handoffId }),
  });
  if (![401, 403].includes(copiedHandoff.response.status)) fail(`A second browser redeemed a copied handoff (${copiedHandoff.response.status})`);

  const intendedHandoff = await fetch(`${base}/_dinodia/setup/operator-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: osHost, origin: osOrigin, cookie: cookieHeader(browserA), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(browserA, 'dinodia_setup_csrf')) },
    body: JSON.stringify({ handoffId: launch.body.handoffId }),
  });
  const intendedBody = await intendedHandoff.json().catch(() => ({}));
  updateCookieJar(browserA, intendedHandoff);
  if (intendedHandoff.status !== 200 || intendedBody.ok !== true) fail(`The originating browser could not consume the operator handoff (${intendedHandoff.status}/${intendedBody.errorCode || intendedBody.error || 'unknown'})`);
  const intendedSetCookies = typeof intendedHandoff.headers.getSetCookie === 'function' ? intendedHandoff.headers.getSetCookie().join(';') : String(intendedHandoff.headers.get('set-cookie') || '');
  if (!/dinodia_os_operator_session=[^;]+/.test(intendedSetCookies) || !/HttpOnly/i.test(intendedSetCookies)) fail('The originating browser did not receive an HttpOnly OS session cookie');
  if (/dno1\.|operatorToken|handoffSecret|sessionGrant|DINODIA_ADMIN_TOKEN/i.test(JSON.stringify(intendedBody))) fail('Operator handoff response exposed an OS bearer or reusable secret');
  const intendedOsRead = await fetchJson(`${base}/_dinodia/admin/api/devices`, { headers: { host: '127.0.0.1', cookie: cookieHeader(browserA) } });
  if (intendedOsRead.response.status !== 200 || !Array.isArray(intendedOsRead.body.devices)) fail(`The intended browser's HttpOnly handoff session did not authorize a real OS devices read (${intendedOsRead.response.status})`);
  const copiedSessionRead = await fetchJson(`${base}/_dinodia/admin/api/devices`, { headers: { host: '127.0.0.1', cookie: cookieHeader(browserB) } });
  if (copiedSessionRead.response.status !== 401) fail(`A second browser obtained OS access without the originating browser session (${copiedSessionRead.response.status})`);
  const replayHandoff = await fetchJson(`${base}/_dinodia/setup/operator-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: osHost, origin: osOrigin, cookie: cookieHeader(browserA), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(browserA, 'dinodia_setup_csrf')) },
    body: JSON.stringify({ handoffId: launch.body.handoffId }),
  });
  if (![400, 401, 403].includes(replayHandoff.response.status)) fail(`The operator handoff replay was accepted (${replayHandoff.response.status})`);
  await hub.store.savePlatform({ operatorCredentialStates: [] });
  const revokedOsRead = await fetchJson(`${base}/_dinodia/admin/api/devices`, { headers: { host: '127.0.0.1', cookie: cookieHeader(browserA) } });
  if (revokedOsRead.response.status !== 401) fail(`Removing the active operator credential did not revoke the real OS session (${revokedOsRead.response.status})`);
  console.log('[stage1:integration] PASS: authenticated 200 proves the intended browser session; second browser and revoked credential receive 401 without exposing token material');

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
  if (seededWork && prisma) {
    if (seededWork.hubInstallationId) {
      await prisma.homeClaimChallenge.deleteMany({ where: { hubInstallationId: seededWork.hubInstallationId } }).catch(() => {});
      await prisma.homeClaimReference.deleteMany({ where: { hubInstallationId: seededWork.hubInstallationId } }).catch(() => {});
      await prisma.hubInstallation.deleteMany({ where: { id: seededWork.hubInstallationId } }).catch(() => {});
    }
    if (seededWork.homeId) await prisma.home.deleteMany({ where: { id: seededWork.homeId } }).catch(() => {});
    await prisma.hubProvisioningAttempt.deleteMany({ where: { id: seededWork.attemptId } }).catch(() => {});
    await prisma.companyOperationalWorkItem.deleteMany({ where: { id: seededWork.workId } }).catch(() => {});
    await prisma.employeeSession.deleteMany({ where: { id: seededWork.employeeSessionId } }).catch(() => {});
    await prisma.companyEmployeeAccount.deleteMany({ where: { id: seededWork.employeeId } }).catch(() => {});
    await prisma.hubManufacturingIdentity.deleteMany({ where: { id: seededWork.identityId } }).catch(() => {});
  }
  if (customerFixture && prisma) {
    await prisma.supportTicket.deleteMany({ where: { id: customerFixture.stepUpTicketId } }).catch(() => {});
    await prisma.offlineMembershipAuthorisation.deleteMany({ where: { trustedDeviceId: customerFixture.trustedDeviceId } }).catch(() => {});
    await prisma.operatorHandoff.deleteMany({ where: { hubInstallationId: customerFixture.hubOneId } }).catch(() => {});
    await prisma.operatorBrowserAttempt.deleteMany({ where: { hubInstallationId: customerFixture.hubOneId } }).catch(() => {});
    await prisma.companyOperationalWorkItem.deleteMany({ where: { id: customerFixture.operatorWorkId } }).catch(() => {});
    await prisma.employeeSession.deleteMany({ where: { id: customerFixture.operatorSessionId } }).catch(() => {});
    await prisma.companyEmployeeAccount.deleteMany({ where: { id: customerFixture.operatorEmployeeId } }).catch(() => {});
    await prisma.customerSession.deleteMany({ where: { id: customerFixture.sessionId } }).catch(() => {});
    await prisma.trustedDevice.deleteMany({ where: { id: customerFixture.trustedDeviceId } }).catch(() => {});
    await prisma.customerSession.deleteMany({ where: { id: customerFixture.propertySessionId } }).catch(() => {});
    await prisma.trustedDevice.deleteMany({ where: { id: customerFixture.propertyTrustedDeviceId } }).catch(() => {});
    await prisma.customerSession.deleteMany({ where: { id: customerFixture.managerSessionId } }).catch(() => {});
    await prisma.trustedDevice.deleteMany({ where: { id: customerFixture.managerTrustedDeviceId } }).catch(() => {});
    await prisma.homeMembership.deleteMany({ where: { id: customerFixture.managerMembershipId } }).catch(() => {});
    await prisma.tenantAreaGrant.deleteMany({ where: { membershipId: { in: [customerFixture.tenantMembershipId, customerFixture.ownerMembershipId] } } }).catch(() => {});
    await prisma.homeMembership.deleteMany({ where: { id: { in: [customerFixture.tenantMembershipId, customerFixture.ownerMembershipId] } } }).catch(() => {});
    await prisma.area.deleteMany({ where: { id: { in: [customerFixture.areaOneId, customerFixture.areaTwoId] } } }).catch(() => {});
    await prisma.hubInstallation.deleteMany({ where: { id: { in: [customerFixture.hubOneId, customerFixture.hubTwoId] } } }).catch(() => {});
    await prisma.hubManufacturingIdentity.deleteMany({ where: { id: { in: [customerFixture.identityOneId, customerFixture.identityTwoId] } } }).catch(() => {});
    await prisma.home.deleteMany({ where: { id: { in: [customerFixture.homeOneId, customerFixture.homeTwoId] } } }).catch(() => {});
    await prisma.customerAccount.deleteMany({ where: { id: customerFixture.accountId } }).catch(() => {});
    await prisma.customerAccount.deleteMany({ where: { id: customerFixture.propertyAccountId } }).catch(() => {});
    await prisma.customerAccount.deleteMany({ where: { id: customerFixture.managerAccountId } }).catch(() => {});
  }
  if (prisma) await prisma.$disconnect().catch(() => {});
  if (sesServer) await new Promise((resolve) => sesServer.close(resolve));
  if (databaseStarted) spawnSync('docker', ['rm', '-f', dockerName], { stdio: 'ignore' });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const env = baseEnv();
try {
  assertParentCredentialsAreNotForwarded();
  run('docker', ['run', '-d', '--name', dockerName, '-e', `POSTGRES_PASSWORD=${databasePassword}`, '-e', 'POSTGRES_DB=dinodia_stage1', '-p', `127.0.0.1:${dbPort}:5432`, 'postgres:16-alpine']);
  databaseStarted = true;
  await waitFor(() => spawnSync('docker', ['exec', dockerName, 'pg_isready', '-U', 'postgres', '-d', 'dinodia_stage1'], { stdio: 'ignore' }).status === 0, 'PostgreSQL');
  run('npx', ['prisma', 'migrate', 'deploy'], env);
  prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  // Always build the current source before starting the real server. A stale
  // .next directory must never turn this behavioural gate into a test of an
  // older candidate.
  run('npm', ['run', 'build'], env);
  await startPlatform(env);
  const dataDir = path.join(tempRoot, 'os-data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(osRoot, 'node_modules', 'ws'))) {
    run('npm', ['ci', '--ignore-scripts'], { cwd: osRoot, env: { ...safeProcessEnvironment(), CI: '1', NODE_ENV: 'test' } });
  }
  await prisma.hubManufacturingIdentity.create({ data: {
    serialNumber: harnessProvisioningIdentity.serial,
    identityGeneration: harnessProvisioningIdentity.generation,
    signingPublicKey: harnessProvisioningIdentity.signingPublicKeyPem,
    encryptionPublicKey: harnessProvisioningIdentity.encryptionPublicKeyPem,
    signingKeyFingerprint: harnessProvisioningIdentity.publicKeyFingerprint,
    encryptionKeyFingerprint: harnessProvisioningIdentity.encryptionKeyFingerprint,
    status: 'ACTIVE',
  } });
  // The OS verifier must use the public half of the exact disposable key
  // injected into the actual Platform server, not an unrelated generated key.
  const operatorPublicKey = crypto.createPublicKey(env.OPERATOR_SESSION_PRIVATE_KEY).export({ format: 'pem', type: 'spki' });
  const harnessIdentityBroker = {
    async getPublicIdentity() {
      return { serial: harnessProvisioningIdentity.serial, signingPublicKeyPem: harnessProvisioningIdentity.signingPublicKeyPem, encryptionPublicKeyPem: harnessProvisioningIdentity.encryptionPublicKeyPem, publicKeyFingerprint: harnessProvisioningIdentity.publicKeyFingerprint, encryptionKeyFingerprint: harnessProvisioningIdentity.encryptionKeyFingerprint, manufacturingSignature: harnessManufacturingSignature, generation: harnessProvisioningIdentity.generation };
    },
    async signProvisioningEnvelope({ payload }) {
      return { signature: crypto.sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), crypto.createPrivateKey(harnessProvisioningSigning.privateKey)).toString('base64url') };
    },
    async signPlatformRequest({ method = 'POST', path: requestPath, timestamp, nonce, bodyHash }) {
      return { signature: crypto.sign(null, Buffer.from([String(method), String(requestPath), String(timestamp), String(nonce), String(bodyHash)].join('\n'), 'utf8'), crypto.createPrivateKey(harnessProvisioningSigning.privateKey)).toString('base64url') };
    },
    async signCloudChallenge({ payload }) {
      const canonical = JSON.stringify({ version: 1, serial: String(payload.serial), cloudUrl: String(payload.cloudUrl), challenge: String(payload.challenge), tunnelId: String(payload.tunnelId), tunnelName: String(payload.tunnelName), timestamp: Number(payload.timestamp), bodyHash: String(payload.bodyHash), identityFingerprint: String(payload.identityFingerprint), identityGeneration: Number(payload.identityGeneration) });
      return { signature: crypto.sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey(harnessProvisioningSigning.privateKey)).toString('base64url') };
    },
  };
  const { createHub } = await import(pathToFileURL(path.join(osRoot, 'src/server.js')).href);
  hub = createHub({
    // This fixture's certified serial is deliberately the same opaque string
    // as its installation UUID; the separate seed above still asserts the
    // Platform grants are bound to the certified serial snapshot.
    config: { nodeEnv: 'production', v2Environment: 'test', hubId: harnessHubInstallationId, haPort: 0, hubAgentPort: 0, dataDir, dataFile: path.join(dataDir, 'dinodia.json'), backupDir: path.join(dataDir, 'backups'), staticDir: path.join(osRoot, 'public'), operatorPublicKey, appPublicKeys: env.DINODIA_APP_PUBLIC_KEYS, platformApiUrl: 'https://dinodia-platform-v2.vercel.app', nativeAutomationsMode: 'off', hiveEnabled: false, googleNestEnabled: false, cloudflarePublicHostname: '' },
    identityBroker: harnessIdentityBroker,
    logger: { error() {}, warn() {}, log() {} },
    mqttBridge: { start() {}, close() {}, status() { return { configured: false, connected: false }; }, async command() { fakePhysicalCommandCount += 1; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, hostname: '' }; } },
  });
  hub.pairing.apiUrl = `http://127.0.0.1:${appPort}`;
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  await platformChecks();
  await stopPlatform();
  await startFakeSes();
  const sesEndpoint = `http://127.0.0.1:${sesPort}`;
  assertLoopbackTestEndpoint(sesEndpoint);
  const deliveryEnv = { ...env, V2_ENVIRONMENT: 'test', COMPANY_PORTAL_INITIAL_CXO_EMAIL: 'niveditgupta@dinodiasmartliving.com', AWS_REGION: 'eu-north-1', SES_FROM_EMAIL: 'no-reply@dinodiasmartliving.com', AWS_ACCESS_KEY_ID: 'stage1-test-access-key', AWS_SECRET_ACCESS_KEY: 'stage1-test-secret', SES_TEST_ENDPOINT: sesEndpoint };
  await startPlatform(deliveryEnv);
  await bootstrapDeliveryChecks(deliveryEnv);
  await customerAuthorizationChecks();
  await osChecks();
  await operatorMutationChecks();
  const childTargets = verifyChildOutboundTargets();
  console.log(`[stage1:integration] PASS: live Platform routes, locked Dinodia OS HTTP, browser isolation, authenticated native WebSocket command authorization and denial exercised against disposable PostgreSQL; parent=${[...outboundTargets].sort().join(',')}; children=${childTargets.join(',')}`);
} finally {
  await cleanup();
}

function pathToFileURL(file) { return new URL(`file://${file.split(path.sep).map(encodeURIComponent).join('/')}`); }
