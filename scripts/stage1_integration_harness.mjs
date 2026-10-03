import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import http from 'node:http';
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
const harnessCloudHostname = 'dinodia-harness-one.dinodiasmartliving.com';
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
let osHarnessNow = Date.now();
let operatorHandoffFetchDelayMs = 0;
let operatorHandoffPlatformRequestCount = 0;
const outboundTargets = new Set();

function fail(message) { throw new Error(`[stage1:integration] ${message}`); }
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const parsed = new URL(typeof input === 'string' ? input : input.url);
  outboundTargets.add(`${parsed.protocol}//${parsed.host}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) fail(`Harness attempted an outbound request to ${parsed.hostname}`);
  if (parsed.pathname === '/api/hub-agent/operator-session/consume') {
    operatorHandoffPlatformRequestCount += 1;
    if (operatorHandoffFetchDelayMs > 0) await sleep(operatorHandoffFetchDelayMs);
  }
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
function loadNativeV1Contract() {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(root, 'src/lib/contracts/dinodiaV1.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function('module', 'exports', compiled)(loaded, loaded.exports);
  return loaded.exports;
}
const nativeV1Contract = loadNativeV1Contract();
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
    CI: '1', NODE_ENV: 'production', V2_ENVIRONMENT: 'test', STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'true',
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
    DINODIA_NATIVE_POLICY_VERSION: `harness-current-policy-${crypto.randomUUID()}`,
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
async function fetchLoopback(url, init = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) fail(`Raw HTTP harness target is not loopback (${target.hostname})`);
  outboundTargets.add(`${target.protocol}//${target.host}`);
  return new Promise((resolve, reject) => {
    const request = http.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: init.method || 'GET', headers: init.headers || {}, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const textBody = Buffer.concat(chunks).toString('utf8');
        const setCookies = response.headers['set-cookie'] || [];
        resolve({
          status: Number(response.statusCode || 0),
          ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300,
          headers: { get: (name) => { const value = response.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value || null; }, getSetCookie: () => [...setCookies] },
          async json() { return JSON.parse(textBody); },
          async text() { return textBody; },
        });
      });
    });
    request.on('error', reject);
    if (init.body != null) request.write(String(init.body));
    request.end();
  });
}
async function fetchJsonLoopback(url, init = {}) {
  const response = await fetchLoopback(url, init);
  return { response, body: await response.json().catch(() => ({})) };
}
async function loginEmployee(base, employee, password) {
  const jar = {};
  const login = await fetchJson(`${base}/api/company/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: employee.email, password }) });
  updateCookieJar(jar, login.response);
  const token = cookieValue(jar, 'dinodia_employee_session');
  if (login.response.status !== 200 || !token) fail(`Real employee login failed (${login.response.status}/${login.body.errorCode || 'missing-cookie'})`);
  const session = await prisma.employeeSession.findFirst({ where: { employeeId: employee.id }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, expiresAt: true, recentAuthenticatedAt: true } });
  if (!session) fail('Real employee login did not create a durable session');
  let claims;
  try { claims = JSON.parse(Buffer.from(decodeURIComponent(token).split('.')[2], 'base64url').toString('utf8')); } catch { fail('Real employee login cookie was not a decodable signed session'); }
  return { token, jar, session, claims, loginBody: login.body, setCookie: String(login.response.headers.get('set-cookie') || '') };
}

async function employeeSessionPolicyChecks(runEnv) {
  const base = `http://127.0.0.1:${appPort}`;
  const employeePassword = `harness-session-policy-${crypto.randomUUID()}`;
  const employeeEmail = `session-policy-${crypto.randomUUID()}@invalid.test`;
  const employee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Session policy boundary fixture', email: employeeEmail, emailNormalized: employeeEmail, role: 'CXO', status: 'ACTIVE', passwordHash: hashPassword(employeePassword) } });
  try {
    await stopPlatform();
    await startPlatform({ ...runEnv, STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'false' });
    const ordinary = await loginEmployee(base, employee, employeePassword);
    if (!ordinary.setCookie.includes('Max-Age=28800') || !/HttpOnly/i.test(ordinary.setCookie) || !/Secure/i.test(ordinary.setCookie) || !/SameSite=Lax/i.test(ordinary.setCookie) || ordinary.claims.exp - ordinary.claims.iat !== 8 * 60 * 60 || ordinary.session.expiresAt.getTime() !== ordinary.claims.exp * 1000 || ordinary.claims.sessionPolicy !== undefined) fail('Policy OFF did not restore the aligned eight-hour Portal cookie, signed token and database expiry');
    await prisma.employeeSession.update({ where: { id: ordinary.session.id }, data: { recentAuthenticatedAt: new Date(Date.now() - 5 * 60 * 1000 - 1) } });
    const launchWhileStale = await fetchJson(`${base}/api/installer/home-support/homes/${crypto.randomUUID()}/os-access/launch`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(ordinary.jar) }, body: '{}' });
    if (launchWhileStale.response.status !== 401 || launchWhileStale.body.errorCode !== 'recent_authentication_required') fail('Policy OFF did not retain the five-minute recent-auth requirement on secure OS launch');
    await prisma.employeeSession.deleteMany({ where: { employeeId: employee.id } });

    await stopPlatform();
    await startPlatform({ ...runEnv, STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'true' });
    const extended = await loginEmployee(base, employee, employeePassword);
    const deadline = extended.session.expiresAt.getTime();
    if (!extended.setCookie.includes('Max-Age=86400') || !/HttpOnly/i.test(extended.setCookie) || !/Secure/i.test(extended.setCookie) || !/SameSite=Lax/i.test(extended.setCookie) || extended.claims.sessionPolicy !== 'STAGE1_INTERNAL_OPERATOR_DAY_SESSION' || extended.claims.exp - extended.claims.iat !== 24 * 60 * 60 || deadline !== extended.claims.exp * 1000 || Date.parse(extended.loginBody.expiresAt) !== deadline) fail('Policy ON did not give the durable Portal row, signed token, cookie and response one 24-hour absolute deadline');
    if (JSON.stringify(extended.loginBody).includes(extended.token)) fail('Employee login JSON exposed its reusable signed session');

    const authBoundary = Math.floor(Date.now() / 1000) * 1000;
    await prisma.employeeSession.update({ where: { id: extended.session.id }, data: { recentAuthenticatedAt: new Date(authBoundary - 5 * 60 * 1000) } });
    const recentRouteProbe = async (label, instant, expectedRecentDenial) => {
      await stopPlatform();
      await startPlatform({ ...runEnv, STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'true', STAGE1_TEST_NOW_MS: String(instant) });
      const response = await fetchJson(`${base}/api/installer/home-support/homes/${crypto.randomUUID()}/os-access/rotate`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(extended.jar), 'idempotency-key': `recent-boundary-${label}-${crypto.randomUUID()}` }, body: JSON.stringify({ workflowId: crypto.randomUUID() }) });
      const deniedForRecentAuth = response.response.status === 401 && response.body.errorCode === 'recent_authentication_required';
      if (deniedForRecentAuth !== expectedRecentDenial) fail(`Credential rotation recent-auth boundary ${label} behaved incorrectly (${response.response.status}/${response.body.errorCode || 'none'})`);
    };
    await recentRouteProbe('before', authBoundary - 1, false);
    await recentRouteProbe('exact', authBoundary, false);
    await recentRouteProbe('after', authBoundary + 1, true);
    await prisma.employeeSession.update({ where: { id: extended.session.id }, data: { recentAuthenticatedAt: new Date() } });

    const unchangedDeadline = extended.session.expiresAt.getTime();
    for (const [label, now, expected] of [['immediately-before', deadline - 1, 200], ['exactly-at', deadline, 401], ['immediately-after', deadline + 1, 401]]) {
      await stopPlatform();
      await startPlatform({ ...runEnv, STAGE1_INTERNAL_OPERATOR_DAY_SESSION: 'true', STAGE1_TEST_NOW_MS: String(now) });
      const probe = await fetchJson(`${base}/api/company/auth/session`, { headers: { cookie: cookieHeader(extended.jar) } });
      if (probe.response.status !== expected) fail(`Portal 24-hour absolute expiry ${label} returned ${probe.response.status}, expected ${expected}`);
      const durable = await prisma.employeeSession.findUnique({ where: { id: extended.session.id }, select: { expiresAt: true } });
      if (durable?.expiresAt.getTime() !== unchangedDeadline) fail('Portal status polling or process restart extended the durable absolute deadline');
    }
    console.log('[stage1:integration] PASS: real employee login/logout and Platform session route enforce aligned 8-hour OFF and 24-hour ON absolute deadlines; exact 24-hour boundary and launch-only recent-auth exception verified');
  } finally {
    await stopPlatform();
    await prisma.auditEvent.deleteMany({ where: { actorType: 'EMPLOYEE', actorId: employee.id } }).catch(() => {});
    await prisma.idempotencyRecord.deleteMany({ where: { actorId: employee.id } }).catch(() => {});
    await prisma.authRateLimitBucket.deleteMany({ where: { bucketKey: { contains: employee.id } } }).catch(() => {});
    await prisma.employeeSession.deleteMany({ where: { employeeId: employee.id } }).catch(() => {});
    await prisma.companyEmployeeAccount.delete({ where: { id: employee.id } }).catch(() => {});
    await startPlatform(runEnv);
  }
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
    // Keep the comparison value-free: row contents (which may include
    // credentials or private customer data) never leave PostgreSQL. The
    // digest detects update-in-place mutations that a row-count-only check
    // would miss.
    const rows = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::text AS count,
             md5(COALESCE(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)), '')) AS digest
      FROM public."${safeTable}" AS t
    `);
    snapshot[tablename] = `${String(rows[0]?.count ?? '0')}:${String(rows[0]?.digest ?? '')}`;
  }
  return snapshot;
}

async function protectedRouteDenialChecks(base) {
  const before = await tableRowSnapshot();
  const results = [];
  // Stage 2 Alexa contract routes deliberately return a fixed 501 without
  // consulting storage until the later Alexa feature stage. They are not
  // protected Stage 1 authorities and must not be folded into the 401 matrix.
  for (const [method, template, auth] of stage1RouteInventory.filter(([, , kind]) => !['public', 'public-login', 'capability', 'public-disabled-feature'].includes(kind))) {
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
    const responseText = await response.text();
    if (response.status === 204 && responseText.length !== 0)
      fail(`Idempotent logout denial unexpectedly returned response bytes: ${method} ${route}`);
    if (responseText.length > 0) {
      let payload;
      try { payload = JSON.parse(responseText); }
      catch { fail(`Denied protected route returned a non-JSON body: ${method} ${route}`); }
      const protectedFields = new Set([
        'data', 'home', 'homeId', 'homeMembershipId', 'membership', 'membershipId',
        'areaIds', 'device', 'deviceId', 'ticket', 'ticketId', 'trustedDevice',
        'trustedDeviceId', 'grant', 'credential', 'session', 'sessionId', 'token',
        'work', 'workflow', 'identity', 'serialNumber',
      ]);
      const findProtectedField = (value) => {
        if (!value || typeof value !== 'object') return null;
        for (const [key, child] of Object.entries(value)) {
          if (protectedFields.has(key)) return key;
          const nested = findProtectedField(child);
          if (nested) return nested;
        }
        return null;
      };
      const leakedField = findProtectedField(payload);
      if (leakedField) fail(`Denied protected route returned protected field ${leakedField}: ${method} ${route}`);
    }
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
  console.log(`[stage1:integration] PASS: ${results.length} inventoried protected Platform route/methods enforced unauthenticated 401 (idempotent logout 204, signed enrollment malformed-input 400) with no durable row-count/content changes and no protected response fields; invalid root signature returned 401`);
}
async function customerAuthorizationChecks(deliveryEnv) {
  const base = `http://127.0.0.1:${appPort}`;
  const platformBase = base;
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
  const hubOne = await prisma.hubInstallation.create({ data: { id: harnessHubInstallationId, homeId: homeOne.id, manufacturingIdentityId: identityOne.id, serialNumberSnapshot: identityOne.serialNumber, state: 'ACTIVE', lifecycleStatus: 'ACTIVE', baseUrl: 'http://192.168.1.76:8123', cloudUrl: 'https://dinodia-harness-one.dinodiasmartliving.com', reservedHostname: 'dinodia-harness-one.dinodiasmartliving.com', cloudUrlVerifiedAt: verifiedAt, remoteChallengeAt: verifiedAt, remoteVerificationAt: verifiedAt } });
  const hubTwo = await prisma.hubInstallation.create({ data: { homeId: homeTwo.id, manufacturingIdentityId: identityTwo.id, serialNumberSnapshot: identityTwo.serialNumber, state: 'ACTIVE', lifecycleStatus: 'ACTIVE', cloudUrl: 'https://dinodia-harness-two.dinodiasmartliving.com', reservedHostname: 'dinodia-harness-two.dinodiasmartliving.com', cloudUrlVerifiedAt: verifiedAt, remoteChallengeAt: verifiedAt, remoteVerificationAt: verifiedAt } });
  await prisma.home.update({ where: { id: homeOne.id }, data: { activeHubInstallationId: hubOne.id } });
  await prisma.home.update({ where: { id: homeTwo.id }, data: { activeHubInstallationId: hubTwo.id } });
  const claimReferenceValue = `harness-permanent-label-${crypto.randomUUID()}`;
  const claimReferenceHashValue = claimReferenceHash(claimReferenceValue, env.CLAIM_REFERENCE_PEPPER);
  const claimIdentitySigning = keyPair();
  const claimIdentityEncryption = x25519KeyPair();
  const claimIdentity = await prisma.hubManufacturingIdentity.create({ data: { serialNumber: `harness-claim-${crypto.randomUUID()}`, signingPublicKey: claimIdentitySigning.publicKey, encryptionPublicKey: claimIdentityEncryption.publicKey, signingKeyFingerprint: publicKeyFingerprint(claimIdentitySigning.publicKey), encryptionKeyFingerprint: publicKeyFingerprint(claimIdentityEncryption.publicKey) } });
  const claimHome = await prisma.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
  const claimHub = await prisma.hubInstallation.create({ data: { homeId: claimHome.id, manufacturingIdentityId: claimIdentity.id, serialNumberSnapshot: claimIdentity.serialNumber, state: 'PAIRING', lifecycleStatus: 'ACTIVE', permanentResolverHash: claimReferenceHashValue, permanentResolverGeneration: 1, permanentResolverStatus: 'ACTIVE' } });
  await prisma.home.update({ where: { id: claimHome.id }, data: { activeHubInstallationId: claimHub.id } });
  const claimReference = await prisma.homeClaimReference.create({ data: { homeId: claimHome.id, hubInstallationId: claimHub.id, purpose: 'INITIAL_OWNER', companyQrReferenceHash: claimReferenceHashValue, resolverGeneration: 1 } });
  const claimMachineSecret = `harness-claim-machine-${crypto.randomUUID()}`;
  await prisma.hubCredentialVersion.create({ data: { hubInstallationId: claimHub.id, version: 1, purpose: 'machine-credential', state: 'ACTIVE', tokenHash: sha256(claimMachineSecret), encryptedDeliveryEnvelope: { harness: true }, ciphertextKeyVersion: 1, deliveredAt: verifiedAt, acknowledgedAt: verifiedAt, activatedAt: verifiedAt } });
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
  const customerPassword = `harness-customer-${crypto.randomUUID()}`;
  const account = await prisma.customerAccount.create({ data: { displayName: 'Stage 1 customer', username, usernameNormalized: username, email, emailNormalized: email, emailVerifiedAt: now, passwordHash: hashPassword(customerPassword) } });
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
  await prisma.home.updateMany({ where: { id: { in: [homeOne.id, homeTwo.id] } }, data: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } });
  const phone = keyPair();
  const phoneThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(phone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const trustedInstallationId = `harness-phone-${crypto.randomUUID()}`;
  const trusted = await prisma.trustedDevice.create({ data: { customerAccountId: account.id, deviceInstallationId: trustedInstallationId, publicKey: phone.publicKey, publicKeyThumbprint: phoneThumbprint, deviceName: 'Harness phone' } });
  const customerCookieJar = {};
  const sessionCountBeforeMalformedLogin = await prisma.customerSession.count({ where: { customerAccountId: account.id } });
  const malformedLogin = await fetchJson(`${base}/api/v2/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: customerPassword, deviceInstallationId: trustedInstallationId, publicKey: phone.publicKey, deviceName: 'Harness phone', model: 'integration-test', osFamily: 'test', osVersion: 'test', extraAuthority: true }) });
  const sessionCountAfterMalformedLogin = await prisma.customerSession.count({ where: { customerAccountId: account.id } });
  if (malformedLogin.response.status !== 400 || malformedLogin.body.error?.code !== 'VALIDATION_FAILED' || sessionCountAfterMalformedLogin !== sessionCountBeforeMalformedLogin) fail('Actual customer login route accepted an extra authority field or created session state after DTO denial');
  console.log('[stage2:integration] PASS: actual customer login rejects unknown authority fields before creating a session');
  const customerLogin = await fetchJson(`${base}/api/v2/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: customerPassword, deviceInstallationId: trustedInstallationId, publicKey: phone.publicKey, deviceName: 'Harness phone', model: 'integration-test', osFamily: 'test', osVersion: 'test' }) });
  updateCookieJar(customerCookieJar, customerLogin.response);
  const rawSession = cookieValue(customerCookieJar, 'dinodia_customer_session');
  const loginReceiptKeys = Object.keys(customerLogin.body || {}).sort().join(',');
  if (customerLogin.response.status !== 200 || !rawSession || loginReceiptKeys !== 'accountId,expiresAt,ok,sessionId,trustedDeviceId' || Object.hasOwn(customerLogin.body || {}, 'token') || Object.hasOwn(customerLogin.body || {}, 'refreshToken') || !nativeV1Contract.validateCustomerSessionReceipt(customerLogin.body)) fail(`Canonical customer login did not issue a valid metadata receipt plus HttpOnly session cookie (${customerLogin.response.status})`);
  const session = await prisma.customerSession.findFirstOrThrow({ where: { customerAccountId: account.id, trustedDeviceId: trusted.id, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  const sessionWithoutCookie = await fetchJson(`${base}/api/v2/session`);
  if (sessionWithoutCookie.response.status !== 401 || sessionWithoutCookie.body.error?.code !== 'AUTH_REQUIRED' || !sessionWithoutCookie.body.error?.requestId || Object.hasOwn(sessionWithoutCookie.body, 'errorCode')) fail(`Account session restore did not return the canonical Native V1 authentication error (${sessionWithoutCookie.response.status})`);
  const restoredAccount = await fetchJson(`${base}/api/v2/session`, { headers: { cookie: `dinodia_customer_session=${encodeURIComponent(rawSession)}` } });
  const restoredMemberships = restoredAccount.body.memberships || [];
  const restoredTenant = restoredMemberships.find((membership) => membership.homeMembershipId === tenantMembership.id);
  const restoredOwner = restoredMemberships.find((membership) => membership.homeMembershipId === ownerMembership.id);
  if (restoredAccount.response.status !== 200 || !nativeV1Contract.validateAccountSessionContext(restoredAccount.body) || restoredAccount.body.accountId !== account.id || restoredMemberships.length !== 2 || restoredTenant?.role !== 'TENANT' || JSON.stringify(restoredTenant?.areaIds) !== JSON.stringify([areaOne.id]) || restoredTenant?.areaIds?.includes(areaOne.osAreaId) || restoredOwner?.role !== 'OWNER' || restoredOwner?.areaIds?.length !== 0 || Object.hasOwn(restoredAccount.body, 'token') || Object.hasOwn(restoredAccount.body, 'hubInstallationId')) fail(`Canonical account restore did not return only canonical Platform Area UUIDs for this account's active membership context (${restoredAccount.response.status})`);
  const restoredLegacyPath = await fetchJson(`${base}/api/v2/auth/session`, { headers: { cookie: `dinodia_customer_session=${encodeURIComponent(rawSession)}` } });
  if (restoredLegacyPath.response.status !== 200 || JSON.stringify(restoredLegacyPath.body) !== JSON.stringify(restoredAccount.body)) fail('The compatibility session path drifted from the canonical account-session DTO');
  const sessionExpiry = session.expiresAt;
  await prisma.customerSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1) } });
  const expiredRestore = await fetchJson(`${base}/api/v2/session`, { headers: { cookie: `dinodia_customer_session=${encodeURIComponent(rawSession)}` } });
  if (expiredRestore.response.status !== 401 || expiredRestore.body.error?.code !== 'TOKEN_EXPIRED' || !expiredRestore.body.error?.requestId || Object.hasOwn(expiredRestore.body, 'errorCode')) fail('Expired customer session did not return the canonical TOKEN_EXPIRED envelope');
  await prisma.customerSession.update({ where: { id: session.id }, data: { expiresAt: sessionExpiry } });
  const disabledAlexa = await fetchJson(`${base}/api/v2/alexa/discovery`);
  if (disabledAlexa.response.status !== 501 || disabledAlexa.body.error?.code !== 'FEATURE_NOT_ENABLED' || !disabledAlexa.body.error?.requestId) fail('Disabled Stage 12 route did not retain the canonical fail-closed error envelope');
  const logoutPhone = keyPair();
  const logoutInstallationId = `harness-logout-phone-${crypto.randomUUID()}`;
  const logoutLogin = await fetchJson(`${base}/api/v2/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: customerPassword, deviceInstallationId: logoutInstallationId, publicKey: logoutPhone.publicKey, deviceName: 'Harness logout phone', model: 'integration-test', osFamily: 'test', osVersion: 'test' }) });
  const logoutJar = {};
  updateCookieJar(logoutJar, logoutLogin.response);
  const logoutRawSession = cookieValue(logoutJar, 'dinodia_customer_session');
  if (logoutLogin.response.status !== 200 || !logoutRawSession) fail(`Canonical customer login did not issue a second test session (${logoutLogin.response.status})`);
  const logoutRequest = await fetchJson(`${base}/api/v2/session/logout`, { method: 'POST', headers: { cookie: `dinodia_customer_session=${encodeURIComponent(logoutRawSession)}` } });
  const logoutRow = await prisma.customerSession.findUnique({ where: { refreshTokenHash: sha256(logoutRawSession) }, select: { revokedAt: true } });
  const afterLogoutRestore = await fetchJson(`${base}/api/v2/session`, { headers: { cookie: `dinodia_customer_session=${encodeURIComponent(logoutRawSession)}` } });
  if (logoutRequest.response.status !== 200 || !nativeV1Contract.validateCustomerSessionLogoutReceipt(logoutRequest.body) || !logoutRow?.revokedAt || afterLogoutRestore.response.status !== 401) fail('Canonical logout did not return the exact receipt, durably revoke its session and deny a subsequent restore');
  console.log('[stage1:integration] PASS: actual customer login cookie restores the canonical two-home membership context; canonical logout revokes that cookie-backed session durably');
  console.log('[stage1:integration] PASS: real account-session route restores two role-distinct homes and tenant area grants, denies anonymous restore, and returns no hub bearer');
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
  const assertHubSession = (result, homeId, membershipId, label, expectedOrigin) => {
    const body = result.body || {};
    const expiresAt = Date.parse(body.expiresAt);
    const keys = Object.keys(body).sort().join(',');
    if (result.response.status !== 200 || keys !== 'expiresAt,homeId,hubEndpoint,membershipId,ok,token' || body.ok !== true || typeof body.token !== 'string' || !body.token || body.token.length > 8192 || body.token === 'TEST_ONLY_PLACEHOLDER_NOT_A_BEARER' || body.homeId !== homeId || body.membershipId !== membershipId || body.hubEndpoint?.state !== 'verified_cloud' || body.hubEndpoint?.origin !== expectedOrigin || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 5 * 60 * 1000 + 1000 || !nativeV1Contract.validateCustomerHubSession(body, { homeId, membershipId })) fail(`${label} did not return a canonical five-minute selected-home session and its exact verified endpoint contract (${result.response.status})`);
  };
  const tenantToken = await issue(homeOne.id);
  assertHubSession(tenantToken, homeOne.id, tenantMembership.id, 'Tenant hub session', 'https://dinodia-harness-one.dinodiasmartliving.com');
  const originalCloudUrl = hubOne.cloudUrl;
  await prisma.hubInstallation.update({ where: { id: hubOne.id }, data: { cloudUrl: 'http://dinodia-harness-one.dinodiasmartliving.com' } });
  const unverifiedEndpoint = await issue(homeOne.id);
  if (unverifiedEndpoint.response.status !== 200 || unverifiedEndpoint.body.hubEndpoint?.state !== 'unavailable' || Object.hasOwn(unverifiedEndpoint.body.hubEndpoint || {}, 'origin')) fail('Selected-home session exposed a non-HTTPS hub endpoint');
  await prisma.hubInstallation.update({ where: { id: hubOne.id }, data: { cloudUrl: originalCloudUrl } });
  console.log('[stage2:integration] PASS: selected-home session returns only the exact verified CloudURL origin; malformed/non-HTTPS endpoint state is explicitly unavailable');
  const noSessionHubToken = await fetchJson(`${base}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homeId: homeOne.id }) });
  if (noSessionHubToken.response.status !== 401 || noSessionHubToken.body.error?.code !== 'AUTH_REQUIRED' || Object.hasOwn(noSessionHubToken.body, 'errorCode')) fail('Hub session issuance did not use the canonical authentication boundary');
  const tenantClaims = JSON.parse(Buffer.from(tenantToken.body.token.split('.')[2], 'base64url').toString('utf8'));
  if (JSON.stringify(tenantClaims.areaIds) !== JSON.stringify([areaOne.id]) || tenantClaims.areaIds.includes(areaOne.osAreaId) || Object.hasOwn(tenantClaims, 'areaBindings') || Object.hasOwn(tenantClaims, 'osAreaId')) fail('Customer bearer did not contain only canonical Area IDs and leaked no private hub alias');
  const ownerToken = await issue(homeTwo.id);
  assertHubSession(ownerToken, homeTwo.id, ownerMembership.id, 'Second-home owner session', 'https://dinodia-harness-two.dinodiasmartliving.com');
  const propertyToken = await issueProperty();
  assertHubSession(propertyToken, homeOne.id, propertyMembership.id, 'Homeowner session', 'https://dinodia-harness-one.dinodiasmartliving.com');
  const managerToken = await issueManager();
  assertHubSession(managerToken, homeOne.id, managerMembership.id, 'Property-manager session', 'https://dinodia-harness-one.dinodiasmartliving.com');
  const wrongHomeHubSession = await issue(crypto.randomUUID());
  const extraFieldHubSession = await fetchJson(`${base}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': rawSession }, body: JSON.stringify({ homeId: homeOne.id, membershipId: tenantMembership.id }) });
  if (wrongHomeHubSession.response.status !== 403 || wrongHomeHubSession.body.error?.code !== 'SCOPE_DENIED' || Object.hasOwn(wrongHomeHubSession.body || {}, 'token') || extraFieldHubSession.response.status !== 400 || extraFieldHubSession.body.error?.code !== 'VALIDATION_FAILED' || Object.hasOwn(extraFieldHubSession.body || {}, 'token')) fail(`Selected-home session contract mismatch (wrong-home=${wrongHomeHubSession.response.status}/${wrongHomeHubSession.body?.error?.code || 'none'}, extra-field=${extraFieldHubSession.response.status}/${extraFieldHubSession.body?.error?.code || 'none'})`);
  const tenantOffline = await fetchJson(`${base}/api/v2/offline-authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ trustedDeviceId: trusted.id, publicKey: phone.publicKey }) });
  if (tenantOffline.response.status !== 200 || tenantOffline.body.authorisation?.homeId !== homeOne.id) fail(`Tenant offline authority was not scoped to the selected home (${tenantOffline.response.status})`);
  const revocablePhone = keyPair();
  const revocablePhoneThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(revocablePhone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const revocableInstallationId = `harness-revocable-phone-${crypto.randomUUID()}`;
  const revocableTrustedDevice = await prisma.trustedDevice.create({ data: { customerAccountId: account.id, deviceInstallationId: revocableInstallationId, publicKey: revocablePhone.publicKey, publicKeyThumbprint: revocablePhoneThumbprint, deviceName: 'Harness revocable phone' } });
  const revocableRawSession = `harness-revocable-session-${crypto.randomUUID()}`;
  await prisma.customerSession.create({ data: { customerAccountId: account.id, trustedDeviceId: revocableTrustedDevice.id, refreshTokenHash: sha256(revocableRawSession), securityVersion: account.securityVersion, trustedDeviceSessionVersion: revocableTrustedDevice.sessionVersion, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const revocableToken = await fetchJson(`${base}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': revocableRawSession }, body: JSON.stringify({ homeId: homeOne.id }) });
  if (revocableToken.response.status !== 200 || !revocableToken.body.token) fail(`Second enrolled test phone did not receive its real customer token (${revocableToken.response.status})`);
  const revocableOffline = await fetchJson(`${base}/api/v2/offline-authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': revocableToken.body.token }, body: JSON.stringify({ trustedDeviceId: revocableTrustedDevice.id, publicKey: revocablePhone.publicKey }) });
  if (revocableOffline.response.status !== 200 || revocableOffline.body.authorisation?.trustedDeviceId !== revocableTrustedDevice.id) fail(`Second phone did not receive a durable Platform offline authorisation (${revocableOffline.response.status})`);
  const ownerOffline = await fetchJson(`${base}/api/v2/offline-authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': ownerToken.body.token }, body: JSON.stringify({ trustedDeviceId: trusted.id, publicKey: phone.publicKey }) });
  if (ownerOffline.response.status !== 403) fail(`Owner received offline household command authority (${ownerOffline.response.status})`);
  const wrongPhone = await fetchJson(`${base}/api/v2/offline-authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ trustedDeviceId: crypto.randomUUID(), publicKey: phone.publicKey }) });
  if (wrongPhone.response.status !== 403) fail(`Wrong trusted device was accepted for offline authority (${wrongPhone.response.status})`);

  // Drive the real operator credential state machine through the running
  // Next routes. Delivery is observed by token-state, acknowledgement is a
  // separate durable write, and activation is a third exact-version write.
  const machineBase = `http://127.0.0.1:${appPort}`;
  const createSupportProofOfPossession = createRequire(import.meta.url)(path.join(osRoot, 'src/auth/supportProofOfPossession.js')).createSupportProofOfPossession;
  async function decryptedHubSupportRedemption({ ticketId, code }) {
    const deliveredProof = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/proof', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, ticketId } });
    if (deliveredProof.response.status !== 200 || !deliveredProof.body.employeeProofEnvelope || !/^[0-9a-f-]{36}$/i.test(deliveredProof.body.requestId || '')) fail(`Machine-authenticated support proof delivery failed (${deliveredProof.response.status}/${deliveredProof.body.errorCode || 'unknown'})`);
    const decrypted = decryptHubEnvelope(JSON.parse(deliveredProof.body.employeeProofEnvelope), identityOneEncryption.privateKey, 'support-session', 1);
    const proofPayload = JSON.parse(decrypted);
    if (proofPayload.version !== 2 || typeof proofPayload.employeeGrant !== 'string' || typeof proofPayload.employeeProofPrivateKey !== 'string') fail('Hub-decrypted support proof payload was malformed');
    const grantParts = proofPayload.employeeGrant.split('.');
    if (grantParts.length !== 4 || grantParts[0] !== 'dno1') fail('Hub-decrypted support employee grant was malformed');
    const grantClaims = JSON.parse(Buffer.from(grantParts[2], 'base64url').toString('utf8'));
    const proofContext = {
      serial: identityOne.serialNumber,
      ticketId,
      requestId: deliveredProof.body.requestId,
      employeeId: String(grantClaims.sub),
      homeId: String(grantClaims.homeId),
      codeHash: sha256(code),
      identityGeneration: Number(deliveredProof.body.identityGeneration),
      nonce: crypto.randomBytes(24).toString('base64url'),
      proofExpiresAt: Number(grantClaims.exp),
    };
    const signature = createSupportProofOfPossession({ ...proofContext, privateKeyPem: proofPayload.employeeProofPrivateKey });
    proofPayload.employeeProofPrivateKey = '';
    return {
      serial: proofContext.serial,
      identityGeneration: proofContext.identityGeneration,
      ticketId,
      requestId: proofContext.requestId,
      employeeId: proofContext.employeeId,
      homeId: proofContext.homeId,
      nonce: proofContext.nonce,
      proofExpiresAt: proofContext.proofExpiresAt,
      requestBodyDigest: signature.requestBodyDigest,
      employeeProofSignature: signature.signature,
      code,
    };
  }
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
  const losingAccountId = concurrentClaims[0].response.status === 200 ? loserAccount.id : winnerAccount.id;
  const reservationId = claimSuccesses[0].body.reservationId;
  const claimHeaders = { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET };
  const claimAction = (body, extraHeaders = {}) => fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { ...claimHeaders, ...extraHeaders }, body: JSON.stringify(body) });
  const snapshotClaimSetup = async (targetReservationId, targetAccountId, targetHomeId) => {
    const [reservation, pendingSetup, home, customerAccount, policyAcceptances, sessions, trustedDevices] = await Promise.all([
      prisma.homeClaimReservation.findUniqueOrThrow({ where: { id: targetReservationId }, select: { state: true, expiresAt: true, setupRevision: true, lastQualifyingMutationAt: true, updatedAt: true, claimReference: { select: { state: true, claimedAccountId: true, consumedAt: true } } } }),
      prisma.pendingHomeSetup.findUniqueOrThrow({ where: { reservationId: targetReservationId }, select: { requiredStep: true, setupRevision: true, lastQualifyingMutationAt: true, retainedAddressRevision: true, retainedAddressDigest: true, retainedAddressConfirmedAt: true, retainedAddressConfirmedByAccountId: true, updatedAt: true } }),
      prisma.home.findUniqueOrThrow({ where: { id: targetHomeId }, select: { addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true, addressStatus: true, managementRevision: true, updatedAt: true } }),
      prisma.customerAccount.findUniqueOrThrow({ where: { id: targetAccountId }, select: { displayName: true, username: true, usernameNormalized: true, updatedAt: true } }),
      prisma.policyAcceptance.findMany({ where: { customerAccountId: targetAccountId, policyKind: 'DINODIA_NATIVE' }, orderBy: { policyVersion: 'asc' }, select: { policyVersion: true, acceptedAt: true, createdAt: true } }),
      prisma.customerSession.findMany({ where: { customerAccountId: targetAccountId }, orderBy: { id: 'asc' }, select: { id: true, securityVersion: true, trustedDeviceSessionVersion: true, expiresAt: true, revokedAt: true, revokeReason: true } }),
      prisma.trustedDevice.findMany({ where: { customerAccountId: targetAccountId }, orderBy: { id: 'asc' }, select: { id: true, sessionVersion: true, revokedAt: true } }),
    ]);
    return JSON.parse(JSON.stringify({ reservation, pendingSetup, home, customerAccount, policyAcceptances, sessions, trustedDevices }));
  };
  async function queueClaimRoutePastExpiry(targetReservationId, action, label) {
    let releaseLock;
    let signalLocked;
    const claimReferenceLocked = new Promise((resolve) => { signalLocked = resolve; });
    const claimReferenceHold = new Promise((resolve) => { releaseLock = resolve; });
    const expiresAt = new Date(Date.now() + 1200);
    const lockTransaction = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${claimReference.id}::uuid FOR UPDATE`;
      await tx.homeClaimReservation.update({ where: { id: targetReservationId }, data: { createdAt: new Date(Date.now() - 2000), expiresAt } });
      signalLocked();
      await claimReferenceHold;
    });
    await claimReferenceLocked;
    const routePromise = action();
    let requestWaitingForLock = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const waiting = await prisma.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%HomeClaimReference%'`;
      if (Number(waiting[0]?.count) > 0) { requestWaitingForLock = true; break; }
      await sleep(25);
    }
    if (!requestWaitingForLock) {
      releaseLock();
      await lockTransaction;
      await routePromise;
      fail(`${label} did not reach the real claim-reference lock`);
    }
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining > 0) await sleep(remaining + 30);
    releaseLock();
    await lockTransaction;
    return routePromise;
  }
  const claimHolderPhone = keyPair();
  const claimHolderThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(claimHolderPhone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const claimHolderTrusted = await prisma.trustedDevice.create({ data: { customerAccountId: winningAccountId, deviceInstallationId: `claim-holder-${crypto.randomUUID()}`, publicKey: claimHolderPhone.publicKey, publicKeyThumbprint: claimHolderThumbprint, deviceName: 'Disposable claim holder phone' } });
  await prisma.customerSession.create({ data: { customerAccountId: winningAccountId, trustedDeviceId: claimHolderTrusted.id, refreshTokenHash: sha256(`claim-holder-session-${crypto.randomUUID()}`), securityVersion: 1, trustedDeviceSessionVersion: 1, expiresAt: new Date(Date.now() + 3600000) } });
  const repeatedClaim = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: winningAccountId }) });
  if (repeatedClaim.response.status !== 200 || repeatedClaim.body.reservationId !== reservationId || repeatedClaim.body.expiresAt !== claimSuccesses[0].body.expiresAt) fail('Claim polling/idempotent replay changed the reservation deadline');
  const initialProfile = { displayName: 'Claim winner updated', username: `claim-updated-${crypto.randomUUID()}` };
  const mutation = await claimAction({ action: 'mutate', reservationId, customerAccountId: winningAccountId, step: 'PROFILE', mutation: initialProfile });
  if (mutation.response.status !== 200 || new Date(mutation.body.expiresAt).getTime() <= new Date(claimSuccesses[0].body.expiresAt).getTime()) fail('A persisted qualifying claim mutation did not extend the reservation');
  await prisma.homeClaimReservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() + 30_000) } });
  const beforeProfileReplay = await snapshotClaimSetup(reservationId, winningAccountId, claimHome.id);
  const repeatedProfile = await claimAction({ action: 'mutate', reservationId, customerAccountId: winningAccountId, step: 'PROFILE', mutation: { displayName: ` ${initialProfile.displayName} `, username: ` ${initialProfile.username.toUpperCase()} ` } });
  const afterProfileReplay = await snapshotClaimSetup(reservationId, winningAccountId, claimHome.id);
  if (repeatedProfile.response.status !== 200 || repeatedProfile.body.expiresAt !== beforeProfileReplay.reservation.expiresAt || repeatedProfile.body.setupRevision !== beforeProfileReplay.reservation.setupRevision || JSON.stringify(afterProfileReplay) !== JSON.stringify(beforeProfileReplay)) fail('Normalized unchanged PROFILE replay extended or mutated claim/account state');
  const invalidProfile = await claimAction({ action: 'mutate', reservationId, customerAccountId: winningAccountId, step: 'PROFILE', mutation: { displayName: '', username: `invalid-profile-${crypto.randomUUID()}` } });
  const afterInvalidProfile = await snapshotClaimSetup(reservationId, winningAccountId, claimHome.id);
  if (invalidProfile.response.status !== 400 || JSON.stringify(afterInvalidProfile) !== JSON.stringify(beforeProfileReplay)) fail('Invalid PROFILE validation changed claim/account state or deadline');
  const changedProfile = { displayName: 'Claim winner changed', username: `claim-changed-${crypto.randomUUID()}` };
  const profileChange = await claimAction({ action: 'mutate', reservationId, customerAccountId: winningAccountId, step: 'PROFILE', mutation: changedProfile });
  const afterProfileChange = await snapshotClaimSetup(reservationId, winningAccountId, claimHome.id);
  if (profileChange.response.status !== 200 || new Date(profileChange.body.expiresAt).getTime() <= new Date(beforeProfileReplay.reservation.expiresAt).getTime() || profileChange.body.setupRevision !== beforeProfileReplay.reservation.setupRevision + 1 || afterProfileChange.customerAccount.displayName !== changedProfile.displayName || afterProfileChange.customerAccount.usernameNormalized !== changedProfile.username.toLowerCase()) fail('A changed PROFILE save did not persist exactly one qualifying extension');
  console.log('[stage3:integration] PASS: real claim route preserves expiry/revision on normalized PROFILE replay and extends once for changed values');
  // The production check constraint requires an ACTIVE reservation's expiry
  // to remain after its creation time. Move both timestamps together so the
  // fixture is already expired without bypassing that invariant.
  let releaseClaimReference;
  let signalClaimReferenceLocked;
  const claimReferenceLocked = new Promise((resolve) => { signalClaimReferenceLocked = resolve; });
  const claimReferenceHold = new Promise((resolve) => { releaseClaimReference = resolve; });
  const claimExpiryLock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${claimReference.id}::uuid FOR UPDATE`;
    const expiredCreatedAt = new Date(Date.now() - 2000);
    const expiryWhileLocked = new Date(Date.now() + 350);
    await tx.homeClaimReservation.update({ where: { id: reservationId }, data: { createdAt: expiredCreatedAt, expiresAt: expiryWhileLocked } });
    signalClaimReferenceLocked();
    await claimReferenceHold;
  });
  await claimReferenceLocked;
  const expiredMutationPromise = claimAction({ action: 'mutate', reservationId, customerAccountId: winningAccountId, step: 'PROFILE', mutation: { displayName: 'Expired reservation revival', username: `expired-revival-${crypto.randomUUID()}` } });
  let requestWaitingForLock = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const waiting = await prisma.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%HomeClaimReference%'`;
    if (Number(waiting[0]?.count) > 0) { requestWaitingForLock = true; break; }
    await sleep(50);
  }
  if (!requestWaitingForLock) {
    releaseClaimReference();
    await claimExpiryLock;
    await expiredMutationPromise;
    fail('Expired-while-queued claim mutation did not reach the real database lock boundary');
  }
  await sleep(400);
  releaseClaimReference();
  await claimExpiryLock;
  const beforeExpiredMutation = await snapshotClaimSetup(reservationId, winningAccountId, claimHome.id);
  const expiredMutation = await expiredMutationPromise;
  const afterExpiredMutation = await snapshotClaimSetup(reservationId, winningAccountId, claimHome.id);
  if (expiredMutation.response.status !== 409 || JSON.stringify(afterExpiredMutation) !== JSON.stringify(beforeExpiredMutation)) fail('A setup mutation revived or changed an expired reservation');
  console.log('[stage3:integration] PASS: invalid PROFILE validation and a request queued across exact claim expiry preserve all account/setup/claim rows and authority');
  const expiredClaim = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: losingAccountId }) });
  if (expiredClaim.response.status !== 409) fail(`Expired claim did not return the bounded restart error (${expiredClaim.response.status})`);
  const deletedWinner = await prisma.customerAccount.findUnique({ where: { id: winningAccountId }, select: { id: true } });
  const resetClaim = await prisma.homeClaimReference.findUnique({ where: { id: claimReference.id }, select: { state: true } });
  const resetHome = await prisma.home.findUnique({ where: { id: claimHome.id }, select: { lifecycle: true } });
  if (deletedWinner || resetClaim?.state !== 'AVAILABLE' || resetHome?.lifecycle !== 'CLAIMABLE') fail('Expired claim cleanup did not commit before returning its error');
  if (!(await prisma.customerAccount.findUnique({ where: { id: losingAccountId }, select: { id: true } })) || await prisma.trustedDevice.count({ where: { id: claimHolderTrusted.id } }) || await prisma.customerSession.count({ where: { customerAccountId: winningAccountId } })) fail('Expired holder cleanup deleted the unrelated scanner or retained the holder session/trusted device');
  const secondHolder = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: losingAccountId }) });
  if (secondHolder.response.status !== 200) fail('Unrelated survivor could not reserve after prior holder cleanup');
  await prisma.homeClaimReservation.update({ where: { id: secondHolder.body.reservationId }, data: { createdAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000) } });
  const secondExpiry = await fetchJson(`${machineBase}/api/internal/stage1/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage1-contract-secret': env.STAGE1_CONTRACT_SECRET }, body: JSON.stringify({ action: 'redeem', reference: claimReferenceValue, customerAccountId: account.id }) });
  if (secondExpiry.response.status !== 409 || await prisma.customerAccount.findUnique({ where: { id: losingAccountId }, select: { id: true } })) fail('Second expiry did not clean only its actual holder');
  if (!(await prisma.customerAccount.findUnique({ where: { id: account.id }, select: { id: true } })) || !(await prisma.homeMembership.findUnique({ where: { id: tenantMembership.id }, select: { id: true } })) || !(await prisma.trustedDevice.findUnique({ where: { id: trusted.id }, select: { id: true } })) || !(await prisma.customerSession.findFirst({ where: { customerAccountId: account.id, revokedAt: null }, select: { id: true } }))) fail('A different verified scanner lost account, membership, trusted device or session during holder expiry');
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
  const scheduledRuns = await Promise.all([0, 1].map(() => fetchJson(`${machineBase}/api/cron/native-operations`, { method: 'POST', headers: { authorization: `Bearer ${env.CRON_SECRET}` } })));
  const scheduledRun = scheduledRuns.find((result) => result.response.status === 200);
  if (!scheduledRun || scheduledRuns.filter((result) => result.response.status === 202 && result.body.skipped === 'already_running').length !== 1) fail(`Concurrent real PostgreSQL dispatcher requests did not elect exactly one lease holder (${scheduledRuns.map((result) => result.response.status).join(',')})`);
  if (scheduledRun.response.status !== 200 || Number(scheduledRun.body.releasedClaims) < 1) fail(`Shared native-operations dispatcher did not release the expired claim (${scheduledRun.response.status}/${JSON.stringify(scheduledRun.body)})`);
  if (Number(scheduledRun.body.credentials?.rotated) < 1) fail(`The shared native-operations dispatcher did not rotate an operator credential past its 60-minute issue deadline (${JSON.stringify(scheduledRun.body.credentials)})`);
  const automaticallyRotated = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 }, select: { state: true, issuedAt: true } });
  if (automaticallyRotated?.state !== 'PENDING' || automaticallyRotated.issuedAt.getTime() > Date.now()) fail('The due operator rotation did not persist exactly one pending version before hub delivery');
  if (await prisma.customerAccount.findUnique({ where: { id: scheduledAccount.id }, select: { id: true } })) fail('Scheduled claim expiry did not delete an otherwise-unrelated verified account');
  const staffEmail = `claim-staff-${crypto.randomUUID()}@invalid.test`;
  const staffPassword = `claim-staff-password-${crypto.randomUUID()}`;
  const staff = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Claim correction staff', email: staffEmail, emailNormalized: staffEmail, role: 'CXO', status: 'ACTIVE', passwordHash: hashPassword(staffPassword) } });
  const staffLogin = await loginEmployee(machineBase, staff, staffPassword);
  const manualAccount = await prisma.customerAccount.create({ data: { displayName: 'Manual release holder', username: `manual-holder-${crypto.randomUUID()}`, usernameNormalized: `manual-holder-${crypto.randomUUID()}`, email: `manual-holder-${crypto.randomUUID()}@invalid.test`, emailNormalized: `manual-holder-${crypto.randomUUID()}@invalid.test`, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const manualClaim = await claimAction({ action: 'redeem', reference: claimReferenceValue, customerAccountId: manualAccount.id });
  if (manualClaim.response.status !== 200) fail('Disposable manual-release holder could not reserve the claim');
  const unstaffedRelease = await claimAction({ action: 'release', reservationId: manualClaim.body.reservationId, reason: 'test' });
  if (unstaffedRelease.response.status !== 401 || (await prisma.homeClaimReservation.findUniqueOrThrow({ where: { id: manualClaim.body.reservationId } })).state !== 'ACTIVE') fail('Unauthenticated manual release altered an active reservation');
  const staffCookie = { cookie: cookieHeader(staffLogin.jar) };
  const reasonlessRelease = await claimAction({ action: 'release', reservationId: manualClaim.body.reservationId }, staffCookie);
  if (reasonlessRelease.response.status !== 400) fail('Manual release without reason was accepted');
  const manualRelease = await claimAction({ action: 'release', reservationId: manualClaim.body.reservationId, reason: 'Disposable verified correction' }, staffCookie);
  if (manualRelease.response.status !== 200 || await prisma.customerAccount.findUnique({ where: { id: manualAccount.id }, select: { id: true } })) fail('Authorised manual release failed to clean only its holder');

  const redeemRaceAccount = await prisma.customerAccount.create({ data: { displayName: 'Redeem lock boundary', username: `redeem-lock-${crypto.randomUUID()}`, usernameNormalized: `redeem-lock-${crypto.randomUUID()}`, email: `redeem-lock-${crypto.randomUUID()}@invalid.test`, emailNormalized: `redeem-lock-${crypto.randomUUID()}@invalid.test`, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const redeemRaceClaim = await claimAction({ action: 'redeem', reference: claimReferenceValue, customerAccountId: redeemRaceAccount.id });
  if (redeemRaceClaim.response.status !== 200) fail('Could not create disposable reservation for queued redemption boundary');
  const queuedRedemption = await queueClaimRoutePastExpiry(redeemRaceClaim.body.reservationId, () => claimAction({ action: 'redeem', reference: claimReferenceValue, customerAccountId: redeemRaceAccount.id }), 'Claim redemption');
  const [redeemRaceReservation, redeemRaceReference, redeemRaceHome, redeemRaceDraft, redeemRaceSurvivor] = await Promise.all([
    prisma.homeClaimReservation.findUnique({ where: { id: redeemRaceClaim.body.reservationId }, select: { state: true } }),
    prisma.homeClaimReference.findUnique({ where: { id: claimReference.id }, select: { state: true, consumedAt: true } }),
    prisma.home.findUnique({ where: { id: claimHome.id }, select: { lifecycle: true } }),
    prisma.pendingHomeSetup.findUnique({ where: { reservationId: redeemRaceClaim.body.reservationId }, select: { id: true } }),
    prisma.customerAccount.findUnique({ where: { id: redeemRaceAccount.id }, select: { id: true } }),
  ]);
  if (queuedRedemption.response.status !== 409 || queuedRedemption.body.errorCode !== 'claim_reservation_expired' || (redeemRaceReservation && redeemRaceReservation.state !== 'EXPIRED') || redeemRaceReference?.state !== 'AVAILABLE' || redeemRaceReference.consumedAt || redeemRaceHome?.lifecycle !== 'CLAIMABLE' || redeemRaceDraft || redeemRaceSurvivor) fail(`Redemption queued across expiry returned stale authority or failed holder-bound cleanup (HTTP ${queuedRedemption.response.status}/${queuedRedemption.body.errorCode}, reservation ${redeemRaceReservation?.state || 'deleted'}, claim ${redeemRaceReference?.state || 'missing'}, home ${redeemRaceHome?.lifecycle || 'missing'}, draft ${Boolean(redeemRaceDraft)}, account ${Boolean(redeemRaceSurvivor)})`);
  console.log('[stage3:integration] PASS: actual claim redemption rechecks expiry after the claim-reference lock and commits holder cleanup without consuming the claim');

  const completeRaceAccount = await prisma.customerAccount.create({ data: { displayName: 'Completion lock boundary', username: `complete-lock-${crypto.randomUUID()}`, usernameNormalized: `complete-lock-${crypto.randomUUID()}`, email: `complete-lock-${crypto.randomUUID()}@invalid.test`, emailNormalized: `complete-lock-${crypto.randomUUID()}@invalid.test`, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const completeRacePhone = keyPair();
  const completeRaceThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(completeRacePhone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const completeRaceTrustedDevice = await prisma.trustedDevice.create({ data: { customerAccountId: completeRaceAccount.id, deviceInstallationId: `complete-lock-phone-${crypto.randomUUID()}`, publicKey: completeRacePhone.publicKey, publicKeyThumbprint: completeRaceThumbprint, deviceName: 'Disposable completion-boundary phone' } });
  await prisma.customerSession.create({ data: { customerAccountId: completeRaceAccount.id, trustedDeviceId: completeRaceTrustedDevice.id, refreshTokenHash: sha256(`complete-lock-session-${crypto.randomUUID()}`), securityVersion: completeRaceAccount.securityVersion, trustedDeviceSessionVersion: completeRaceTrustedDevice.sessionVersion, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const completeRaceClaim = await claimAction({ action: 'redeem', reference: claimReferenceValue, customerAccountId: completeRaceAccount.id });
  if (completeRaceClaim.response.status !== 200) fail('Could not create disposable reservation for queued completion boundary');
  const completeRaceAddress = { addressLine1: '2 Expiry Boundary Lane', city: 'London', postcode: 'N2 2AA', country: 'GB', timezone: 'Europe/London' };
  const completeRaceAddressSave = await claimAction({ action: 'mutate', reservationId: completeRaceClaim.body.reservationId, customerAccountId: completeRaceAccount.id, step: 'ADDRESS', mutation: completeRaceAddress });
  const completeRaceAddressView = await claimAction({ action: 'address', reservationId: completeRaceClaim.body.reservationId, customerAccountId: completeRaceAccount.id });
  const completeRaceConfirmation = await claimAction({ action: 'mutate', reservationId: completeRaceClaim.body.reservationId, customerAccountId: completeRaceAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: completeRaceAddressView.body.addressRevision, addressDigest: completeRaceAddressView.body.addressDigest } });
  if (completeRaceAddressSave.response.status !== 200 || completeRaceAddressView.response.status !== 200 || completeRaceConfirmation.response.status !== 200) fail('Could not prepare the disposable pending claim for completion boundary test');
  const completionAuthority = async () => {
    const [reservation, pendingSetup, reference, home, accountExists, ownerCount] = await Promise.all([
      prisma.homeClaimReservation.findUniqueOrThrow({ where: { id: completeRaceClaim.body.reservationId }, select: { state: true, setupRevision: true, lastQualifyingMutationAt: true } }),
      prisma.pendingHomeSetup.findUniqueOrThrow({ where: { reservationId: completeRaceClaim.body.reservationId }, select: { state: true, requiredStep: true, setupRevision: true, retainedAddressRevision: true, retainedAddressDigest: true, retainedAddressConfirmedAt: true, retainedAddressConfirmedByAccountId: true } }),
      prisma.homeClaimReference.findUniqueOrThrow({ where: { id: claimReference.id }, select: { state: true, claimedAccountId: true, consumedAt: true } }),
      prisma.home.findUniqueOrThrow({ where: { id: claimHome.id }, select: { lifecycle: true, managementRevision: true, addressStatus: true } }),
      prisma.customerAccount.findUnique({ where: { id: completeRaceAccount.id }, select: { id: true } }),
      prisma.homeMembership.count({ where: { homeId: claimHome.id, status: 'ACTIVE', role: 'OWNER' } }),
    ]);
    const [sessions, trustedDevices] = await Promise.all([
      prisma.customerSession.findMany({ where: { customerAccountId: completeRaceAccount.id }, orderBy: { id: 'asc' }, select: { id: true, securityVersion: true, trustedDeviceSessionVersion: true, expiresAt: true, revokedAt: true, revokeReason: true } }),
      prisma.trustedDevice.findMany({ where: { customerAccountId: completeRaceAccount.id }, orderBy: { id: 'asc' }, select: { id: true, sessionVersion: true, revokedAt: true } }),
    ]);
    return JSON.stringify({ reservation, pendingSetup, reference, home, accountExists: Boolean(accountExists), ownerCount, sessions, trustedDevices });
  };
  const beforeQueuedCompletion = await completionAuthority();
  const queuedCompletion = await queueClaimRoutePastExpiry(completeRaceClaim.body.reservationId, () => claimAction({ action: 'complete', reservationId: completeRaceClaim.body.reservationId, customerAccountId: completeRaceAccount.id }), 'Claim completion');
  const afterQueuedCompletion = await completionAuthority();
  if (queuedCompletion.response.status !== 409 || queuedCompletion.body.errorCode !== 'claim_reservation_expired' || afterQueuedCompletion !== beforeQueuedCompletion) fail('Claim completion queued across expiry accepted stale authority or changed claim/account/Home state');
  const cleanupAfterDeniedCompletion = await claimAction({ action: 'redeem', reference: claimReferenceValue, customerAccountId: completeRaceAccount.id });
  if (cleanupAfterDeniedCompletion.response.status !== 409 || await prisma.customerAccount.findUnique({ where: { id: completeRaceAccount.id }, select: { id: true } }) || await prisma.pendingHomeSetup.findUnique({ where: { reservationId: completeRaceClaim.body.reservationId }, select: { id: true } }) || (await prisma.homeClaimReference.findUniqueOrThrow({ where: { id: claimReference.id }, select: { state: true, consumedAt: true } })).state !== 'AVAILABLE') fail('Expired completion reservation did not clean up on the next authorized expiry check');
  console.log('[stage3:integration] PASS: actual claim completion rechecks expiry after reference/Home locks with zero stale owner, claim, draft or account effects');

  const pendingAccount = await prisma.customerAccount.create({ data: { displayName: 'Pending owner', username: `pending-owner-${crypto.randomUUID()}`, usernameNormalized: `pending-owner-${crypto.randomUUID()}`, email: `pending-owner-${crypto.randomUUID()}@invalid.test`, emailNormalized: `pending-owner-${crypto.randomUUID()}@invalid.test`, emailVerifiedAt: now, passwordHash: 'harness-only-password-hash' } });
  const pendingPhone = keyPair();
  const pendingThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(pendingPhone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const pendingTrustedDevice = await prisma.trustedDevice.create({ data: { customerAccountId: pendingAccount.id, deviceInstallationId: `pending-policy-phone-${crypto.randomUUID()}`, publicKey: pendingPhone.publicKey, publicKeyThumbprint: pendingThumbprint, deviceName: 'Disposable policy-boundary phone' } });
  await prisma.customerSession.create({ data: { customerAccountId: pendingAccount.id, trustedDeviceId: pendingTrustedDevice.id, refreshTokenHash: sha256(`pending-policy-session-${crypto.randomUUID()}`), securityVersion: pendingAccount.securityVersion, trustedDeviceSessionVersion: pendingTrustedDevice.sessionVersion, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const pendingClaim = await claimAction({ action: 'redeem', reference: claimReferenceValue, customerAccountId: pendingAccount.id });
  if (pendingClaim.response.status !== 200) fail(`Pending initial claim failed (${pendingClaim.response.status})`);
  const pendingId = pendingClaim.body.reservationId;
  const initialCurrentPolicyVersion = env.DINODIA_NATIVE_POLICY_VERSION;
  const beforeUnapprovedPolicy = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  const unapprovedPolicy = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: 'harness-invented-policy-v9' } });
  if (unapprovedPolicy.response.status !== 409 || JSON.stringify(await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id)) !== JSON.stringify(beforeUnapprovedPolicy)) fail('Caller-invented POLICY version was accepted or changed claim/account/Home state');
  const malformedPolicy = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: {} } });
  if (malformedPolicy.response.status !== 400 || JSON.stringify(await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id)) !== JSON.stringify(beforeUnapprovedPolicy)) fail('Malformed POLICY version changed claim/account/Home state');
  const policyOne = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: initialCurrentPolicyVersion } });
  if (policyOne.response.status !== 200) fail('Initial policy acceptance failed');
  const policyAcceptanceOne = await prisma.policyAcceptance.findUniqueOrThrow({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: pendingAccount.id, policyKind: 'DINODIA_NATIVE', policyVersion: initialCurrentPolicyVersion } }, select: { acceptedAt: true } });
  await prisma.homeClaimReservation.update({ where: { id: pendingId }, data: { expiresAt: new Date(Date.now() + 30_000) } });
  const beforePolicyReplay = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  const invalidPolicy = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: ' ' } });
  const afterInvalidPolicy = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  if (invalidPolicy.response.status !== 400 || JSON.stringify(afterInvalidPolicy) !== JSON.stringify(beforePolicyReplay)) fail('Invalid POLICY validation changed claim/account/home state or deadline');
  const repeatedPolicy = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: ` ${initialCurrentPolicyVersion} ` } });
  const afterPolicyReplay = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  const unchangedPolicyAcceptance = await prisma.policyAcceptance.findUniqueOrThrow({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: pendingAccount.id, policyKind: 'DINODIA_NATIVE', policyVersion: initialCurrentPolicyVersion } }, select: { acceptedAt: true } });
  if (repeatedPolicy.response.status !== 200 || repeatedPolicy.body.expiresAt !== beforePolicyReplay.reservation.expiresAt || repeatedPolicy.body.setupRevision !== beforePolicyReplay.reservation.setupRevision || JSON.stringify(afterPolicyReplay) !== JSON.stringify(beforePolicyReplay) || unchangedPolicyAcceptance.acceptedAt.getTime() !== policyAcceptanceOne.acceptedAt.getTime()) fail('Unchanged POLICY replay extended or mutated reservation/acceptance state');
  const staleWhileV1 = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: 'harness-current-policy-v2' } });
  if (staleWhileV1.response.status !== 409 || JSON.stringify(await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id)) !== JSON.stringify(beforePolicyReplay)) fail('A non-current POLICY version was accepted while the server policy remained unchanged');
  const changedCurrentPolicyVersion = `harness-current-policy-${crypto.randomUUID()}`;
  deliveryEnv.DINODIA_NATIVE_POLICY_VERSION = changedCurrentPolicyVersion;
  await stopPlatform();
  await startPlatform(deliveryEnv);
  const staleAfterAuthorizedChange = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: initialCurrentPolicyVersion } });
  if (staleAfterAuthorizedChange.response.status !== 409 || JSON.stringify(await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id)) !== JSON.stringify(beforePolicyReplay)) fail('A formerly current but now stale POLICY version changed durable state');
  const beforePolicyChange = await prisma.homeClaimReservation.findUniqueOrThrow({ where: { id: pendingId }, select: { expiresAt: true, setupRevision: true } });
  const policyTwo = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: changedCurrentPolicyVersion } });
  if (policyTwo.response.status !== 200 || new Date(policyTwo.body.expiresAt).getTime() <= beforePolicyChange.expiresAt.getTime() || policyTwo.body.setupRevision !== beforePolicyChange.setupRevision + 1 || await prisma.policyAcceptance.count({ where: { customerAccountId: pendingAccount.id, policyKind: 'DINODIA_NATIVE' } }) !== 2) fail('A server-authorized current POLICY version change did not extend the reservation exactly once');
  const beforeCurrentPolicyReplay = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  const currentPolicyReplay = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: changedCurrentPolicyVersion } });
  if (currentPolicyReplay.response.status !== 200 || JSON.stringify(await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id)) !== JSON.stringify(beforeCurrentPolicyReplay)) fail('Duplicate acceptance of the actual current POLICY version changed durable state');
  await prisma.homeClaimReservation.update({ where: { id: pendingId }, data: { expiresAt: new Date(Date.now() - 1) } });
  const beforeExpiredPolicy = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  const expiredPolicy = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'POLICY', mutation: { policyVersion: changedCurrentPolicyVersion } });
  if (expiredPolicy.response.status !== 409 || expiredPolicy.body.errorCode !== 'claim_reservation_expired' || JSON.stringify(await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id)) !== JSON.stringify(beforeExpiredPolicy)) fail('Expired POLICY submission changed acceptance, deadline, revisions, address confirmation, session, trusted-device or claim authority');
  console.log('[stage3:integration] PASS: expired POLICY submission is denied without changing acceptance, expiry/revisions, Home/address confirmation, sessions, trusted devices or claim authority');
  await prisma.homeClaimReservation.update({ where: { id: pendingId }, data: { expiresAt: new Date(Date.now() + 30_000) } });
  console.log('[stage3:integration] PASS: the actual claim route accepts only the server-current policy, rejects arbitrary/stale versions without effects, and extends once after a server-authorized version change');

  let addressInput = { addressLine1: '1 Registered Lane', city: 'London', postcode: 'N1 1AA', country: 'GB', timezone: 'Europe/London' };
  const addressSave = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS', mutation: addressInput });
  if (addressSave.response.status !== 200) fail(`Initial address save failed (${addressSave.response.status})`);
  const initialAddressHome = await prisma.home.findUniqueOrThrow({ where: { id: claimHome.id }, select: { managementRevision: true } });
  const beforeInvalidAddress = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  const invalidAddress = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS', mutation: { ...addressInput, city: '' } });
  const afterInvalidAddress = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  if (invalidAddress.response.status !== 400 || JSON.stringify(afterInvalidAddress) !== JSON.stringify(beforeInvalidAddress)) fail('Invalid ADDRESS validation changed Home, confirmation or reservation state');
  const presentedAddress = await claimAction({ action: 'address', reservationId: pendingId, customerAccountId: pendingAccount.id });
  if (presentedAddress.response.status !== 200 || presentedAddress.body.addressLine1 !== addressInput.addressLine1) fail('Current registered address was not presented to its claimant');
  const staleConfirmation = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: presentedAddress.body.addressRevision - 1, addressDigest: presentedAddress.body.addressDigest } });
  const afterStaleConfirmation = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  if (staleConfirmation.response.status !== 409 || JSON.stringify(afterStaleConfirmation) !== JSON.stringify(beforeInvalidAddress)) fail(`Stale address revision was accepted or mutated state (${staleConfirmation.response.status})`);
  const confirmed = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: presentedAddress.body.addressRevision, addressDigest: presentedAddress.body.addressDigest } });
  if (confirmed.response.status !== 200) fail(`Current address confirmation failed (${confirmed.response.status})`);
  await prisma.homeClaimReservation.update({ where: { id: pendingId }, data: { expiresAt: new Date(Date.now() + 30_000) } });
  const beforeAddressReplay = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  const repeatedAddress = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS', mutation: { ...addressInput, addressLine1: ` ${addressInput.addressLine1} `, country: 'gb' } });
  const afterAddressReplay = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  if (repeatedAddress.response.status !== 200 || repeatedAddress.body.expiresAt !== beforeAddressReplay.reservation.expiresAt || repeatedAddress.body.setupRevision !== beforeAddressReplay.reservation.setupRevision || JSON.stringify(afterAddressReplay) !== JSON.stringify(beforeAddressReplay)) fail('Normalized unchanged ADDRESS replay changed expiry, Home revision, or retained-address confirmation');
  const beforeAddressChange = await prisma.homeClaimReservation.findUniqueOrThrow({ where: { id: pendingId }, select: { expiresAt: true, setupRevision: true } });
  addressInput = { ...addressInput, addressLine1: '1B Registered Lane' };
  const changedAddress = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS', mutation: addressInput });
  const afterAddressChange = await snapshotClaimSetup(pendingId, pendingAccount.id, claimHome.id);
  if (changedAddress.response.status !== 200 || new Date(changedAddress.body.expiresAt).getTime() <= beforeAddressChange.expiresAt.getTime() || changedAddress.body.setupRevision !== beforeAddressChange.setupRevision + 1 || afterAddressChange.home.managementRevision !== initialAddressHome.managementRevision + 1 || afterAddressChange.pendingSetup.retainedAddressConfirmedAt || afterAddressChange.pendingSetup.retainedAddressDigest) fail('Changed ADDRESS did not extend once, increment Home revision, and invalidate its prior confirmation');
  console.log('[stage3:integration] PASS: real claim route keeps normalized unchanged ADDRESS idempotent and changed ADDRESS invalidates prior confirmation while extending once');
  const changedAddressPresentation = await claimAction({ action: 'address', reservationId: pendingId, customerAccountId: pendingAccount.id });
  if (changedAddressPresentation.response.status !== 200 || changedAddressPresentation.body.addressLine1 !== addressInput.addressLine1) fail('Changed registered address was not presented for version-matched confirmation');
  const changedAddressConfirmation = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: changedAddressPresentation.body.addressRevision, addressDigest: changedAddressPresentation.body.addressDigest } });
  if (changedAddressConfirmation.response.status !== 200) fail('Changed registered address could not be confirmed at its current version');
  const repeatedConfirmation = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: presentedAddress.body.addressRevision, addressDigest: presentedAddress.body.addressDigest } });
  if (repeatedConfirmation.response.status !== 409) fail('An obsolete retained-address confirmation remained valid after address change');
  const duplicateChangedConfirmation = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: changedAddressPresentation.body.addressRevision, addressDigest: changedAddressPresentation.body.addressDigest } });
  if (duplicateChangedConfirmation.response.status !== 200 || duplicateChangedConfirmation.body.expiresAt !== changedAddressConfirmation.body.expiresAt || duplicateChangedConfirmation.body.setupRevision !== changedAddressConfirmation.body.setupRevision) fail('Duplicate retained-address confirmation extended a claim');
  const forgedCorrection = await claimAction({ action: 'correct_address', homeId: claimHome.id, employeeId: pendingAccount.id, address: { ...addressInput, addressLine1: 'Forged Lane' } });
  if (forgedCorrection.response.status !== 403) fail(`Customer identity corrected a registered address (${forgedCorrection.response.status})`);
  const correction = await claimAction({ action: 'correct_address', homeId: claimHome.id, employeeId: staff.id, address: { ...addressInput, addressLine1: '2 Corrected Lane' } });
  if (correction.response.status !== 200) fail(`Authorised staff correction failed (${correction.response.status})`);
  const invalidated = await prisma.pendingHomeSetup.findUnique({ where: { reservationId: pendingId }, select: { retainedAddressConfirmedAt: true, retainedAddressDigest: true } });
  if (invalidated?.retainedAddressConfirmedAt || invalidated?.retainedAddressDigest) fail('Staff correction failed to invalidate the former confirmation');
  const staleAfterCorrection = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: presentedAddress.body.addressRevision, addressDigest: presentedAddress.body.addressDigest } });
  if (staleAfterCorrection.response.status !== 409) fail(`Previous confirmation survived staff correction (${staleAfterCorrection.response.status})`);
  const claimantOverwrite = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS', mutation: addressInput });
  if (claimantOverwrite.response.status !== 403) fail(`Claimant overwrote staff-corrected address (${claimantOverwrite.response.status})`);
  const beforeHelp = await prisma.homeClaimReference.findUnique({ where: { id: claimReference.id }, select: { state: true, consumedAt: true } });
  const help = await claimAction({ action: 'get_help', reservationId: pendingId, customerAccountId: pendingAccount.id });
  const afterHelp = await prisma.homeClaimReference.findUnique({ where: { id: claimReference.id }, select: { state: true, consumedAt: true } });
  if (help.response.status !== 200 || help.body.authorityChanged !== false || JSON.stringify(beforeHelp) !== JSON.stringify(afterHelp) || await prisma.homeMembership.count({ where: { homeId: claimHome.id } })) fail('Get Help mutated claim or ownership authority');
  const correctedAddress = await claimAction({ action: 'address', reservationId: pendingId, customerAccountId: pendingAccount.id });
  if (correctedAddress.response.status !== 200 || correctedAddress.body.addressLine1 !== '2 Corrected Lane') fail('Claimant did not see the corrected retained address');
  const reconfirmed = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: correctedAddress.body.addressRevision, addressDigest: correctedAddress.body.addressDigest } });
  if (reconfirmed.response.status !== 200) fail(`Corrected address was not confirmable (${reconfirmed.response.status})`);
  const pendingCompletion = await claimAction({ action: 'complete', reservationId: pendingId, customerAccountId: pendingAccount.id });
  const preInstallReference = await prisma.homeClaimReference.findUnique({ where: { id: claimReference.id }, select: { state: true, consumedAt: true } });
  if (pendingCompletion.response.status !== 200 || preInstallReference?.state !== 'PENDING_INSTALLATION' || preInstallReference.consumedAt || await prisma.homeMembership.count({ where: { homeId: claimHome.id } })) fail('Pre-installation claim consumed the reference or activated ownership');
  const prematureActivation = await claimAction({ action: 'activate', reservationId: pendingId, customerAccountId: pendingAccount.id });
  if (prematureActivation.response.status !== 409 || await prisma.homeMembership.count({ where: { homeId: claimHome.id } })) fail('Owner activated before complete installation');
  await prisma.hubInstallation.update({ where: { id: claimHub.id }, data: { cloudUrl: 'https://claim-harness.dinodiasmartliving.com', cloudUrlVerifiedAt: new Date(), remoteChallengeAt: new Date(), remoteVerificationAt: new Date(), cleanupState: 'ACKNOWLEDGED' } });
  await prisma.area.create({ data: { homeId: claimHome.id, osAreaId: `claim-area-${crypto.randomUUID()}`, originalName: 'Entrance' } });
  await prisma.home.update({ where: { id: claimHome.id }, data: { installationStatus: 'COMPLETE' } });
  const postPendingCorrection = await claimAction({ action: 'correct_address', homeId: claimHome.id, employeeId: staff.id, address: { ...addressInput, addressLine1: '3 Corrected Lane' } });
  if (postPendingCorrection.response.status !== 200) fail('Staff could not correct retained address during pending installation');
  const staleActivation = await claimAction({ action: 'activate', reservationId: pendingId, customerAccountId: pendingAccount.id });
  if (staleActivation.response.status !== 409 || await prisma.homeMembership.count({ where: { homeId: claimHome.id } })) fail('Post-pending staff correction failed to block stale owner activation');
  const pendingAddress = await claimAction({ action: 'address', reservationId: pendingId, customerAccountId: pendingAccount.id });
  const pendingReconfirmation = await claimAction({ action: 'mutate', reservationId: pendingId, customerAccountId: pendingAccount.id, step: 'ADDRESS_CONFIRMATION', mutation: { addressRevision: pendingAddress.body.addressRevision, addressDigest: pendingAddress.body.addressDigest } });
  if (pendingAddress.response.status !== 200 || pendingAddress.body.addressLine1 !== '3 Corrected Lane' || pendingReconfirmation.response.status !== 200) fail('Pending claimant could not reconfirm corrected retained address');
  await prisma.customerAccount.update({ where: { id: pendingAccount.id }, data: { status: 'SUSPENDED' } });
  const suspendedActivation = await claimAction({ action: 'activate', reservationId: pendingId, customerAccountId: pendingAccount.id });
  if (suspendedActivation.response.status !== 403 || await prisma.homeMembership.count({ where: { homeId: claimHome.id } })) fail('Suspended customer account gained owner authority during claim activation');
  await prisma.customerAccount.update({ where: { id: pendingAccount.id }, data: { status: 'ACTIVE' } });
  const activated = await claimAction({ action: 'activate', reservationId: pendingId, customerAccountId: pendingAccount.id });
  const activationReplay = await claimAction({ action: 'activate', reservationId: pendingId, customerAccountId: pendingAccount.id });
  const activatedReference = await prisma.homeClaimReference.findUnique({ where: { id: claimReference.id }, select: { state: true, consumedAt: true } });
  if (activated.response.status !== 200 || activationReplay.response.status !== 200 || !activationReplay.body.idempotentReplay || activatedReference?.state !== 'CONSUMED' || !activatedReference.consumedAt || await prisma.homeMembership.count({ where: { homeId: claimHome.id, role: 'OWNER', status: 'ACTIVE' } }) !== 1 || await prisma.nativeDomainOutbox.count({ where: { idempotencyKey: `claim-activated:${claimReference.id}` } }) !== 1) fail(`Guarded activation did not create exactly one owner, consumed claim and event (first=${activated.response.status}/${activated.body?.errorCode || activated.body?.error?.code || 'none'}, replay=${activationReplay.response.status}/${activationReplay.body?.errorCode || activationReplay.body?.error?.code || 'none'}, claim=${activatedReference?.state || 'none'})`);
  const wrongReplay = await claimAction({ action: 'activate', reservationId: pendingId, customerAccountId: account.id });
  if (wrongReplay.response.status !== 409) fail(`Another account replayed completed activation (${wrongReplay.response.status})`);
  console.log('[stage3:integration] PASS: expired holder-only cleanup preserves a different scanner and its memberships/sessions/trusted device; versioned retained address, staff correction, Get Help, pending ownerless state and one-time guarded activation passed');
  await prisma.home.update({ where: { id: claimHome.id }, data: { lifecycle: 'RETIRED' } });
  await prisma.homeMembership.deleteMany({ where: { homeId: claimHome.id } });
  await prisma.homeClaimChallenge.deleteMany({ where: { hubInstallationId: claimHub.id } });
  await prisma.homeClaimReference.deleteMany({ where: { id: claimReference.id } });
  await prisma.hubInstallation.delete({ where: { id: claimHub.id } });
  await prisma.home.delete({ where: { id: claimHome.id } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: claimIdentity.id } });
  await prisma.customerAccount.delete({ where: { id: pendingAccount.id } });
  await prisma.employeeSession.deleteMany({ where: { employeeId: staff.id } });
  await prisma.companyEmployeeAccount.delete({ where: { id: staff.id } });
  await prisma.customerAccount.deleteMany({ where: { id: { in: [winnerAccount.id, loserAccount.id] } } });
  const tokenState = await machineRequest({ base: machineBase, path: '/api/hub-agent/token-state', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, operatorCredentialVersion: 1 } });
  if (tokenState.response.status !== 200 || tokenState.body.operatorCredentialDelivery?.version !== 2) fail(`Operator credential delivery did not expose the next version (${tokenState.response.status})`);
  const operatorV2 = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 }, select: { id: true, tokenHash: true, state: true } });
  if (operatorV2?.state !== 'DELIVERED') fail(`Operator credential was not durably marked DELIVERED (${operatorV2?.state})`);
  const deliveryAudits = await prisma.auditEvent.findMany({ where: { targetType: 'HubCredentialVersion', targetId: operatorV2.id, action: 'operator_credential_delivered' }, select: { id: true, metadata: true } });
  if (deliveryAudits.length !== 1 || JSON.stringify(deliveryAudits[0].metadata).includes(operatorV2.tokenHash)) fail('Credential delivery did not create exactly one redacted audit event');
  const deliveryRetry = await machineRequest({ base: machineBase, path: '/api/hub-agent/token-state', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, operatorCredentialVersion: 1 } });
  if (deliveryRetry.response.status !== 200 || deliveryRetry.body.operatorCredentialDelivery?.version !== 2) fail(`Interrupted delivery retry did not resend the same version (${deliveryRetry.response.status})`);
  if (await prisma.auditEvent.count({ where: { targetType: 'HubCredentialVersion', targetId: operatorV2.id, action: 'operator_credential_delivered' } }) !== 1) fail('Idempotent delivery retry duplicated its state-transition audit');
  const acknowledgementRetries = await Promise.all([0, 1].map(() => machineRequest({ base: machineBase, path: '/api/hub-agent/v2/credentials/acknowledge', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, version: 2, credentialFingerprint: operatorV2.tokenHash } })));
  if (acknowledgementRetries.some((result) => result.response.status !== 200 || result.body.state !== 'ACKNOWLEDGED')) fail(`Concurrent exact-version operator acknowledgement did not converge (${acknowledgementRetries.map((result) => result.response.status).join(',')})`);
  const acknowledgedRow = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: hubOne.id, purpose: 'operator-credential', version: 2 }, select: { state: true, acknowledgedAt: true, activatedAt: true } });
  if (acknowledgedRow?.state !== 'ACKNOWLEDGED' || !acknowledgedRow.acknowledgedAt || acknowledgedRow.activatedAt) fail('Acknowledgement incorrectly activated the operator credential');
  const acknowledgementAudits = await prisma.auditEvent.findMany({ where: { targetType: 'HubCredentialVersion', targetId: operatorV2.id, action: 'operator_credential_acknowledged' }, select: { id: true, metadata: true } });
  if (acknowledgementAudits.length !== 1 || JSON.stringify(acknowledgementAudits[0].metadata).includes(operatorV2.tokenHash)) fail('Credential acknowledgement did not create exactly one redacted audit event');
  const acknowledgementRetry = await machineRequest({ base: machineBase, path: '/api/hub-agent/v2/credentials/acknowledge', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, version: 2, credentialFingerprint: operatorV2.tokenHash } });
  if (acknowledgementRetry.response.status !== 200 || acknowledgementRetry.body.state !== 'ACKNOWLEDGED') fail('Exact-version acknowledgement retry was not idempotent');
  if (await prisma.auditEvent.count({ where: { targetType: 'HubCredentialVersion', targetId: operatorV2.id, action: 'operator_credential_acknowledged' } }) !== 1) fail('Idempotent acknowledgement retry duplicated its state-transition audit');
  const activationRetries = await Promise.all([0, 1].map(() => machineRequest({ base: machineBase, path: '/api/hub-agent/v2/credentials/activate', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, version: 2, credentialFingerprint: operatorV2.tokenHash } })));
  if (activationRetries.some((result) => result.response.status !== 200 || result.body.state !== 'ACTIVE')) fail(`Concurrent exact-version operator activation did not converge (${activationRetries.map((result) => result.response.status).join(',')})`);
  const activationAudits = await prisma.auditEvent.findMany({ where: { targetType: 'HubCredentialVersion', targetId: operatorV2.id, action: 'operator_credential_activated' }, select: { id: true, metadata: true } });
  if (activationAudits.length !== 1 || JSON.stringify(activationAudits[0].metadata).includes(operatorV2.tokenHash)) fail('Credential activation did not create exactly one redacted audit event');
  const activationRetry = await machineRequest({ base: machineBase, path: '/api/hub-agent/v2/credentials/activate', machineSecret, body: { serial: identityOne.serialNumber, identityGeneration: identityOne.identityGeneration, version: 2, credentialFingerprint: operatorV2.tokenHash } });
  if (activationRetry.response.status !== 200 || activationRetry.body.state !== 'ACTIVE') fail('Exact-version activation retry was not idempotent');
  if (await prisma.auditEvent.count({ where: { targetType: 'HubCredentialVersion', targetId: operatorV2.id, action: 'operator_credential_activated' } }) !== 1) fail('Idempotent activation retry duplicated its state-transition audit');
  console.log('[stage1:integration] PASS: PENDING/DELIVERED/ACKNOWLEDGED/ACTIVE are distinct durable transitions with one redacted audit each and idempotent hub retries');
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
  const identitySwapBefore = await tableRowSnapshot();
  const routeId = '00000000-0000-4000-8000-000000000001';
  const routePath = (template) => template
    .replaceAll(':homeId', routeId)
    .replaceAll(':hubInstallationId', routeId)
    .replaceAll(':ticketId', routeId)
    .replaceAll(':requestId', '00000000-0000-4000-8000-000000000002')
    .replaceAll(':trustedDeviceId', routeId);
  const identitySwapProbes = [
    ...stage1RouteInventory.filter(([, , requiredAuthority]) => requiredAuthority === 'customer')
      .map(([method, template]) => ({
        label: `employee credentials cannot call customer route ${method} ${template}`,
        method,
        route: routePath(template),
        headers: { 'x-dinodia-employee-session': supportToken },
        expectedCode: 'AUTH_REQUIRED',
      })),
    ...stage1RouteInventory.filter(([, , requiredAuthority]) => requiredAuthority === 'employee')
      .map(([method, template]) => ({
        label: `customer credentials cannot call employee route ${method} ${template}`,
        method,
        route: routePath(template),
        headers: { 'x-dinodia-app-token': tenantToken.body.token },
        expectedCode: template.startsWith('/api/v2/') ? 'AUTH_REQUIRED' : 'employee_session_invalid',
      })),
  ];
  for (const { label, route, method, headers, expectedCode } of identitySwapProbes) {
    const response = await fetchJson(`${base}${route}`, {
      method,
      headers: { ...headers, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    if (response.response.status !== 401) fail(`${label}: cross-principal request was not denied with HTTP 401 (${response.response.status})`);
    if (route.startsWith('/api/v2/')) {
      if (response.body?.error?.code !== expectedCode || !response.body?.error?.requestId || Object.hasOwn(response.body || {}, 'errorCode')) fail(`${label}: Native V2 denial did not return canonical 401 ${expectedCode} (${response.response.status}/${response.body?.error?.code || 'no_code'})`);
    } else if (response.body?.errorCode !== expectedCode || typeof response.body?.error !== 'string' || response.body?.error?.code) {
      fail(`${label}: Stage 1 employee boundary did not retain its bounded employee-authentication denial (${response.response.status}/${response.body?.errorCode || 'no_code'})`);
    }
    const serialized = JSON.stringify(response.body || {});
    const protectedValues = [supportToken, tenantToken.body.token, account.id, propertyAccount.id, supportEmployee.id,
      homeOne.id, homeTwo.id, tenantMembership.id, ownerMembership.id, propertyMembership.id, managerMembership.id];
    if (protectedValues.some((value) => typeof value === 'string' && value.length > 0 && serialized.includes(value)))
      fail(`${label}: denied cross-principal response echoed a credential or known account/home/membership identity`);
    if (/"(?:accountId|employeeId|homeMembershipId|membershipId|homeId|token|refreshToken|session|memberships|work|workflow|identity|device)"\s*:/.test(serialized)) fail(`${label}: denied cross-principal response included protected identity or authority fields`);
  }
  const identitySwapAfter = await tableRowSnapshot();
  if (JSON.stringify(identitySwapBefore) !== JSON.stringify(identitySwapAfter)) fail('Cross-principal customer/employee probes changed durable rows');
  console.log(`[stage2:integration] PASS: employee credentials denied from ${stage1RouteInventory.filter(([, , authority]) => authority === 'customer').length} customer-only route methods and customer credentials denied from ${stage1RouteInventory.filter(([, , authority]) => authority === 'employee').length} employee-only route methods; canonical/bounded errors, no protected response fields or durable row changes`);
  const ticketCountBeforeInvalidCategory = await prisma.supportTicket.count({ where: { customerAccountId: account.id } });
  const invalidCategoryTicket = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'HARNESS_PRIVATE', description: 'Must be rejected before persistence' }) });
  const ticketCountAfterInvalidCategory = await prisma.supportTicket.count({ where: { customerAccountId: account.id } });
  if (invalidCategoryTicket.response.status !== 400 || ticketCountAfterInvalidCategory !== ticketCountBeforeInvalidCategory) fail('The support route accepted an undeclared category or persisted a denied ticket');
  const ticketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'ACCESS_OR_PERMISSIONS', description: 'Disposable tenant-private support test' }) });
  if (ticketResponse.response.status !== 201 || ticketResponse.body.ticket?.status !== 'OPEN' || !ticketResponse.body.ticket?.createdAt) fail(`Customer support ticket creation failed its canonical receipt (${ticketResponse.response.status})`);
  const ticketId = ticketResponse.body.ticket?.id;
  await prisma.supportTicket.update({ where: { id: ticketId }, data: { assignedEmployeeId: supportEmployee.id } });
  const supportRequestCountBeforeDuplicates = await prisma.supportAccessRequest.count({ where: { ticketId } });
  const duplicateSupportScope = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': supportToken }, body: JSON.stringify({ requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantMembership.id, areaIds: [areaOne.id, areaOne.id], targetIds: [] }) });
  const supportRequestCountAfterDuplicates = await prisma.supportAccessRequest.count({ where: { ticketId } });
  if (duplicateSupportScope.response.status !== 400 || supportRequestCountAfterDuplicates !== supportRequestCountBeforeDuplicates) fail('Duplicate scoped-support targets were accepted or persisted');
  const accessResponse = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': supportToken }, body: JSON.stringify({ requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantMembership.id, areaIds: [areaOne.id], targetIds: [] }) });
  if (accessResponse.response.status !== 201 || accessResponse.body.accessRequest?.touchesPropertyInfrastructure !== false) fail(`Tenant-private support request was not scoped privately (${accessResponse.response.status})`);
  const requestId = accessResponse.body.accessRequest.id;
  const implicitSupportDecision = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests/${requestId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({}) });
  const stillRequested = await prisma.supportAccessRequest.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } });
  if (implicitSupportDecision.response.status !== 400 || stillRequested.status !== 'REQUESTED') fail('An omitted support decision was interpreted as approval or changed durable state');
  const approval = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests/${requestId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ approve: true }) });
  if (approval.response.status !== 200 || !approval.body.oneUseCode) fail(`Tenant support approval did not issue a one-use customer code (${approval.response.status})`);
  const supportCode = approval.body.oneUseCode;
  const approvedSupportRow = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { codeExpiresAt: true, sessionHardStopAt: true } });
  if (!approvedSupportRow?.codeExpiresAt || approvedSupportRow.codeExpiresAt.getTime() < Date.now() + 9 * 60 * 1000 || !approvedSupportRow.sessionHardStopAt || approvedSupportRow.sessionHardStopAt.getTime() < Date.now() + 29 * 60 * 1000) fail('Support approval did not persist the ten-minute code and thirty-minute hard stop');
  const tenantNotificationsBefore = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': tenantToken.body.token } });
  if (tenantNotificationsBefore.response.status !== 200 || tenantNotificationsBefore.body.notifications?.length !== 0) fail('Tenant-private support leaked a homeowner notification side channel');
  const issueResponse = await fetchJson(`${base}/api/v2/support/tickets/${ticketId}/access-requests/${requestId}/issue`, { method: 'POST', headers: { 'x-dinodia-employee-session': supportToken } });
  if (issueResponse.response.status !== 200 || issueResponse.body.code || issueResponse.body.employeeProofEnvelope || !issueResponse.body.supportUrl) fail(`Employee support issue response exposed or omitted bounded handoff (${issueResponse.response.status})`);
  const redeemBody = await decryptedHubSupportRedemption({ ticketId, code: supportCode });
  if (JSON.stringify(redeemBody).includes('employeeProofPrivateKey') || JSON.stringify(redeemBody).includes('employeeGrant')) fail('Support redemption request exposed decrypted employee proof material');
  const invalidSupportProof = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: { ...redeemBody, homeId: homeTwo.id } });
  if (invalidSupportProof.response.status !== 401) fail(`Support redemption accepted a signature after its home context changed (${invalidSupportProof.response.status})`);
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

  const denialTicketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'OTHER', description: 'Disposable support denial test' }) });
  if (denialTicketResponse.response.status !== 201) fail(`Support denial test ticket was not created (${denialTicketResponse.response.status})`);
  const denialTicketId = denialTicketResponse.body.ticket.id;
  await prisma.supportTicket.update({ where: { id: denialTicketId }, data: { assignedEmployeeId: supportEmployee.id } });
  const denialRequestResponse = await fetchJson(`${base}/api/v2/support/tickets/${denialTicketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': supportToken }, body: JSON.stringify({ requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantMembership.id, areaIds: [areaOne.id], targetIds: [] }) });
  if (denialRequestResponse.response.status !== 201) fail(`Support denial request was not created (${denialRequestResponse.response.status})`);
  const denialRequestId = denialRequestResponse.body.accessRequest.id;
  const denialDecision = await fetchJson(`${base}/api/v2/support/tickets/${denialTicketId}/access-requests/${denialRequestId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ approve: false }) });
  const deniedRow = await prisma.supportAccessRequest.findUniqueOrThrow({ where: { id: denialRequestId }, select: { status: true, codeHash: true } });
  if (denialDecision.response.status !== 200 || denialDecision.body.status !== 'DENIED' || denialDecision.body.oneUseCode !== undefined || deniedRow.status !== 'DENIED' || deniedRow.codeHash !== null) fail('Explicit support denial issued or persisted an approval code');
  await prisma.supportAccessRequest.delete({ where: { id: denialRequestId } });
  await prisma.supportTicket.delete({ where: { id: denialTicketId } });
  await prisma.employeeSession.delete({ where: { id: supportSession.id } });
  await prisma.companyEmployeeAccount.delete({ where: { id: supportEmployee.id } });

  // Broaden the same tenant ticket only after a tenant approval, then require
  // the separate homeowner approval and the homeowner's trusted-phone
  // confirmation. Property access creates a durable owner notification;
  // tenant-private access above created none.
  const propertyDevice = await prisma.nativeDevice.create({ data: { homeId: homeOne.id, hubInstallationId: hubOne.id, osDeviceId: `harness-property-device-${crypto.randomUUID()}`, originalName: 'Harness property light', technicalLabel: 'property_device', managementClass: 'PROPERTY_DEVICE', deviceType: 'light', lifecycle: 'INSTALLED' } });
  const tenantDescriptorDigest = crypto.createHash('sha256').update('harness-tenant-descriptor-v1').digest('hex');
  const tenantDevice = await prisma.nativeDevice.create({ data: { homeId: homeOne.id, hubInstallationId: hubOne.id, osDeviceId: 'harness-tenant-device', originalName: 'Harness tenant light', technicalLabel: 'tenant_device', managementClass: 'TENANT_DEVICE', deviceType: 'light', ownerMembershipId: tenantMembership.id, descriptorRevision: 1, descriptorDigest: tenantDescriptorDigest, lifecycle: 'DISCOVERED' } });
  await prisma.deviceAreaAssignment.create({ data: { deviceId: tenantDevice.id, areaId: areaOne.id, homeId: homeOne.id, source: 'HARNESS', actorType: 'SYSTEM' } });
  await prisma.nativeDevice.update({ where: { id: tenantDevice.id }, data: { lifecycle: 'INSTALLED' } });
  const propertyTicketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'HUB_OR_CONNECTION', description: 'Disposable property support test' }) });
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
  const tenantPropertyTicketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'DEVICE_PROBLEM', description: 'Disposable tenant permanent-device support test' }) });
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
  const tenantPropertyRedeemBody = await decryptedHubSupportRedemption({ ticketId: tenantPropertyTicketId, code: tenantPropertyApproval.body.oneUseCode });
  const tenantPropertyRedeemed = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: tenantPropertyRedeemBody });
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
  const propertyRedeemBody = await decryptedHubSupportRedemption({ ticketId: propertyTicketId, code: propertyApproval.body.oneUseCode });
  const propertyRedeemed = await machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: propertyRedeemBody });
  if (propertyRedeemed.response.status !== 200 || propertyRedeemed.body.scope !== 'PROPERTY_SCOPE') fail(`Property support redemption failed (${propertyRedeemed.response.status})`);
  const propertyNotification = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': propertyToken.body.token } });
  if (propertyNotification.response.status !== 200 || !propertyNotification.body.notifications?.some((item) => item.eventType === 'STARTED' && item.ticketId === propertyTicketId)) fail('Property support redemption did not create the homeowner notification');
  const wrongApproverRevoke = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${propertyRequestId}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ confirmation: 'I revoke this support access for my property', proof: 'wrong-approver' }) });
  if (wrongApproverRevoke.response.status !== 403) fail(`A non-approving tenant revoked property support (${wrongApproverRevoke.response.status})`);
  const revokeChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ operationKind: 'support_access_revoke', targetIds: [propertyTicketId, propertyRequestId], value: 'I revoke this support access for my property' }) });
  if (revokeChallenge.response.status !== 200) fail(`Property revoke step-up challenge failed (${revokeChallenge.response.status})`);
  const revokeSignature = crypto.sign(null, stepUpChallengeMessage({ challengeId: revokeChallenge.body.challengeId, nonce: revokeChallenge.body.nonce, operationDigest: revokeChallenge.body.operationDigest }), crypto.createPrivateKey(propertyPhone.privateKey)).toString('base64url');
  const revokeProof = await fetchJson(`${base}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ challengeId: revokeChallenge.body.challengeId, nonce: revokeChallenge.body.nonce, deviceSignature: revokeSignature }) });
  if (revokeProof.response.status !== 200 || !revokeProof.body.proof) fail(`Property revoke step-up proof issuance failed (${revokeProof.response.status})`);
  const beforeRejectedPropertyRevoke = await prisma.supportAccessRequest.findUniqueOrThrow({ where: { id: propertyRequestId }, select: { status: true, revision: true, updatedAt: true, desiredRevokedAt: true } });
  const beforeRejectedRevokeSessions = await prisma.supportSession.findMany({ where: { accessRequestId: propertyRequestId }, select: { status: true, desiredRevokedAt: true, hubAcknowledgedAt: true } });
  const beforeRejectedRevokeAudit = await prisma.auditEvent.count({ where: { targetType: 'SupportAccessRequest', targetId: propertyRequestId, action: 'support_access_revoked' } });
  const beforeRejectedRevokeNotifications = await prisma.supportAccessNotification.count({ where: { accessRequestId: propertyRequestId } });
  const rejectedExtraAuthorityRevoke = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${propertyRequestId}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ confirmation: 'I revoke this support access for my property', proof: revokeProof.body.proof, homeId: propertyTicketId }) });
  const afterRejectedPropertyRevoke = await prisma.supportAccessRequest.findUniqueOrThrow({ where: { id: propertyRequestId }, select: { status: true, revision: true, updatedAt: true, desiredRevokedAt: true } });
  const afterRejectedRevokeSessions = await prisma.supportSession.findMany({ where: { accessRequestId: propertyRequestId }, select: { status: true, desiredRevokedAt: true, hubAcknowledgedAt: true } });
  const afterRejectedRevokeAudit = await prisma.auditEvent.count({ where: { targetType: 'SupportAccessRequest', targetId: propertyRequestId, action: 'support_access_revoked' } });
  const afterRejectedRevokeNotifications = await prisma.supportAccessNotification.count({ where: { accessRequestId: propertyRequestId } });
  if (rejectedExtraAuthorityRevoke.response.status !== 400 || rejectedExtraAuthorityRevoke.body.error?.code !== 'VALIDATION_FAILED' ||
      JSON.stringify(beforeRejectedPropertyRevoke) !== JSON.stringify(afterRejectedPropertyRevoke) ||
      JSON.stringify(beforeRejectedRevokeSessions) !== JSON.stringify(afterRejectedRevokeSessions) || beforeRejectedRevokeAudit !== afterRejectedRevokeAudit) {
    fail(`Actual support-revoke route accepted extra authority or caused durable effects (${rejectedExtraAuthorityRevoke.response.status}/${rejectedExtraAuthorityRevoke.body.error?.code || 'none'})`);
  }
  if (beforeRejectedRevokeNotifications !== afterRejectedRevokeNotifications || Object.keys(rejectedExtraAuthorityRevoke.body || {}).join(',') !== 'error' ||
      JSON.stringify(rejectedExtraAuthorityRevoke.body).includes(revokeProof.body.proof)) fail('Rejected support-revoke route leaked protected response fields or changed notification/proof state');
  console.log('[stage2:integration] PASS: actual property-support revoke route rejects extra authority with canonical VALIDATION_FAILED, zero response data, no durable effects, and leaves the exact one-use proof available for the valid revocation');
  const propertyRevoked = await fetchJson(`${base}/api/v2/support/tickets/${propertyTicketId}/access-requests/${propertyRequestId}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': propertyToken.body.token }, body: JSON.stringify({ confirmation: 'I revoke this support access for my property', proof: revokeProof.body.proof }) });
  if (propertyRevoked.response.status !== 200 || !nativeV1Contract.validateSupportAccessRevokeReceipt(propertyRevoked.body)) fail(`Same-approver property revoke failed (${propertyRevoked.response.status}/${propertyRevoked.body.error?.code || ''})`);
  const propertyNotificationsAfter = await fetchJson(`${base}/api/v2/support/notifications`, { headers: { 'x-dinodia-app-token': propertyToken.body.token } });
  const propertyEvents = (propertyNotificationsAfter.body.notifications || []).filter((item) => item.ticketId === propertyTicketId).map((item) => item.eventType).sort();
  if (propertyNotificationsAfter.response.status !== 200 || propertyEvents.join(',') !== 'REVOKED,STARTED') fail(`Property notification lifecycle was incomplete or leaked (${propertyEvents.join(',')})`);

  // Race customer closure against the real machine-authenticated redemption
  // route. Regardless of which serializable transaction wins, closure must
  // leave no active support session and the one-use request must be revoked.
  const raceTicketResponse = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'OTHER', description: 'Disposable close versus redeem race' }) });
  if (raceTicketResponse.response.status !== 201) fail(`Support race ticket creation failed (${raceTicketResponse.response.status})`);
  const raceTicketId = raceTicketResponse.body.ticket.id;
  await prisma.supportTicket.update({ where: { id: raceTicketId }, data: { assignedEmployeeId: propertySupportEmployee.id } });
  const raceRequestResponse = await fetchJson(`${base}/api/v2/support/tickets/${raceTicketId}/access-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': propertySupportToken }, body: JSON.stringify({ requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantMembership.id, areaIds: [areaOne.id], targetIds: [] }) });
  if (raceRequestResponse.response.status !== 201) fail(`Support race request creation failed (${raceRequestResponse.response.status})`);
  const raceRequestId = raceRequestResponse.body.accessRequest.id;
  const raceApproval = await fetchJson(`${base}/api/v2/support/tickets/${raceTicketId}/access-requests/${raceRequestId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ approve: true }) });
  if (raceApproval.response.status !== 200 || !raceApproval.body.oneUseCode) fail(`Support race approval failed (${raceApproval.response.status})`);
  const raceIssue = await fetchJson(`${base}/api/v2/support/tickets/${raceTicketId}/access-requests/${raceRequestId}/issue`, { method: 'POST', headers: { 'x-dinodia-employee-session': propertySupportToken } });
  if (raceIssue.response.status !== 200) fail(`Support race employee handoff failed (${raceIssue.response.status})`);
  const raceRedeemBody = await decryptedHubSupportRedemption({ ticketId: raceTicketId, code: raceApproval.body.oneUseCode });
  const closeChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ operationKind: 'support_ticket_close', targetIds: [raceTicketId], value: null }) });
  if (closeChallenge.response.status !== 200) fail(`Support close race step-up challenge failed (${closeChallenge.response.status})`);
  const closeSignature = crypto.sign(null, stepUpChallengeMessage({ challengeId: closeChallenge.body.challengeId, nonce: closeChallenge.body.nonce, operationDigest: closeChallenge.body.operationDigest }), crypto.createPrivateKey(phone.privateKey)).toString('base64url');
  const closeProof = await fetchJson(`${base}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: closeChallenge.body.challengeId, nonce: closeChallenge.body.nonce, deviceSignature: closeSignature }) });
  if (closeProof.response.status !== 200) fail(`Support close race step-up proof failed (${closeProof.response.status})`);
  const [raceRedeem, raceClose] = await Promise.all([
    machineRequest({ base: machineBase, path: '/api/hub-agent/support/v2/redeem', machineSecret, body: raceRedeemBody }),
    fetchJson(`${base}/api/v2/support/tickets/${raceTicketId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ action: 'close', proof: closeProof.body.proof }) }),
  ]);
  if (raceClose.response.status !== 200 || ![200, 401, 403, 409].includes(raceRedeem.response.status)) fail(`Support close/redeem race did not reach a controlled terminal state (${raceClose.response.status}/${raceRedeem.response.status})`);
  const raceFinal = await prisma.supportAccessRequest.findUniqueOrThrow({ where: { id: raceRequestId }, select: { status: true } });
  const raceTicketFinal = await prisma.supportTicket.findUniqueOrThrow({ where: { id: raceTicketId }, select: { status: true } });
  const raceSessions = await prisma.supportSession.findMany({ where: { accessRequestId: raceRequestId }, select: { status: true, desiredRevokedAt: true } });
  if (raceTicketFinal.status !== 'CLOSED' || raceFinal.status !== 'REVOKED' || raceSessions.some((session) => session.status === 'ACTIVE' || !session.desiredRevokedAt)) fail('Support close/redeem race left live authority after ticket closure');
  await prisma.supportSession.deleteMany({ where: { accessRequestId: raceRequestId } });
  await prisma.supportAccessRequest.delete({ where: { id: raceRequestId } });
  await prisma.supportTicket.delete({ where: { id: raceTicketId } });
  console.log(`[stage1:integration] PASS: support close/redeem race closed ticket and revoked request with no active lease (redeem=${raceRedeem.response.status})`);

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
  const stepUpTicket = await fetchJson(`${base}/api/v2/support/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ category: 'OTHER', description: 'Disposable step-up close test' }) });
  if (stepUpTicket.response.status !== 201) fail(`Step-up ticket creation failed (${stepUpTicket.response.status})`);
  const stepUpTicketId = stepUpTicket.body.ticket.id;
  const challenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ operationKind: 'support_ticket_close', targetIds: [stepUpTicketId], value: null }) });
  if (challenge.response.status !== 200 || !challenge.body.challengeId) fail(`Trusted-phone step-up challenge was not issued (${challenge.response.status})`);
  const cancelledChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: challenge.body.challengeId }) });
  if (cancelledChallenge.response.status !== 200) fail(`Trusted-phone challenge cancellation failed (${cancelledChallenge.response.status})`);
  const cancelledIssue = await fetchJson(`${base}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: challenge.body.challengeId, nonce: challenge.body.nonce, deviceSignature: 'A'.repeat(64) }) });
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
  await hub.store.savePlatform({ hubInstallId: hubOne.id, policyRevision: 0, areaBindings: [{ areaId: areaOne.id, hubAreaId: areaOne.osAreaId }, { areaId: areaTwo.id, hubAreaId: areaTwo.osAreaId }] });
  await hub.store.saveArea({ name: 'Tenant area' }, areaOne.osAreaId);
  await hub.store.upsertDevice({
    id: 'harness-tenant-device',
    name: 'Harness tenant light',
    protocol: 'zigbee',
    areaId: areaOne.osAreaId,
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
    async getPublicIdentity() {
      return {
        serial: identityOne.serialNumber,
        signingPublicKeyPem: identityOneSigning.publicKey,
        encryptionPublicKeyPem: identityOneEncryption.publicKey,
        publicKeyFingerprint: publicKeyFingerprint(identityOneSigning.publicKey),
        encryptionKeyFingerprint: publicKeyFingerprint(identityOneEncryption.publicKey),
        manufacturingSignature: '',
        generation: identityOne.identityGeneration,
      };
    },
    async signPlatformRequest(input) {
      const canonical = [String(input.method).toUpperCase(), String(input.path), String(input.timestamp), String(input.nonce), String(input.bodyHash)].join('\n');
      return { signature: crypto.sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey(identityOneSigning.privateKey)).toString('base64url') };
    },
  };
  const descriptorTargetIds = [tenantDevice.id];
  const descriptorValue = { state: 'ON' };
  const descriptorControlId = String(tenantEntity.entity.id);
  const descriptorAttestedValue = { ...descriptorValue, controlId: descriptorControlId };
  const descriptorOperationValue = descriptorBoundValue(descriptorAttestedValue, { [tenantDevice.id]: tenantDescriptorDigest });
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
    descriptorDigest: tenantDescriptorDigest,
    operationDigest: operationDigest({ actorId: account.id, trustedDeviceId: trusted.id, customerSessionId: session.id, homeId: homeOne.id, membershipId: tenantMembership.id, hubInstallationId: hubOne.id, operationKind: 'device_sensitive_command', targetIds: descriptorTargetIds, value: descriptorOperationValue }),
    nonce: `descriptor-${crypto.randomUUID()}`,
    issuedAt: Date.now(),
  };
  descriptor.hubSignature = await hub.pairing.signStepUpDescriptor(descriptor);
  const descriptorChallenge = await fetchJson(`${base}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ operationKind: 'device_sensitive_command', targetIds: descriptorTargetIds, value: descriptorValue, descriptorAttestation: descriptor }) });
  if (descriptorChallenge.response.status !== 200 || !descriptorChallenge.body.challengeId) fail(`OS bounded step-up descriptor was not accepted by Platform (${descriptorChallenge.response.status}/${descriptorChallenge.body.errorCode || descriptorChallenge.body.error?.code || 'no_error_code'})`);
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
  await hub.store.upsertDevice({
    id: 'harness-ungranted-area-device', name: 'Harness ungranted area switch', protocol: 'zigbee', areaId: areaTwo.osAreaId,
    state: { state: 'OFF' }, setup: { status: 'ready' },
    entities: { 'harness-ungranted-area-device:state': { name: 'Unassigned switch', stateKey: 'state', domain: 'switch', category: 'control', writable: true, primary: true, capability: { readable: true, writable: true, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }] } } },
  });
  tenantSocket.send(JSON.stringify({ id: 3, type: 'call_service', domain: 'switch', service: 'turn_on', target: { entity_id: tenantEntity.haId, area_id: areaTwo.osAreaId } }));
  const mixedSelectorCommand = await wsMessage(tenantSocket, 'mixed-selector command denial');
  if (mixedSelectorCommand.success || fakePhysicalCommandCount !== 1) fail(`WebSocket mixed an authorized entity with an ungranted area target or caused a device effect (${mixedSelectorCommand.success}/${fakePhysicalCommandCount})`);
  await hub.store.upsertDevice({
    id: 'harness-sensitive-control', name: 'Harness sensitive control', protocol: 'stage1_fake', areaId: areaOne.osAreaId,
    labelIds: ['tenant_device'], metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id },
    state: { state: 'OFF' }, setup: { status: 'ready' },
    entities: { 'harness-sensitive-control:state': { name: 'Sensitive switch', stateKey: 'state', domain: 'switch', category: 'control', writable: true, primary: true, capability: { readable: true, writable: true, sensitive: true, primary: true, semanticRole: 'power', category: 'control', controlId: 'sensitive-power', bindings: [{ serviceId: 'switch.turn_on' }] } } },
  });
  const sensitiveEntity = hub.model.entities().find((entity) => entity.device.id === 'harness-sensitive-control');
  if (!sensitiveEntity) fail('The safe fake sensitive control did not expose its current descriptor');
  tenantSocket.send(JSON.stringify({ id: 4, type: 'call_service', domain: 'switch', service: 'turn_on', target: { entity_id: sensitiveEntity.haId, controlId: 'sensitive-power' } }));
  const unsteppedSensitiveCommand = await wsMessage(tenantSocket, 'unstepped sensitive command denial');
  if (unsteppedSensitiveCommand.success || fakePhysicalCommandCount !== 1) fail(`Sensitive WebSocket command dispatched without a fresh step-up proof (${unsteppedSensitiveCommand.success}/${fakePhysicalCommandCount})`);
  console.log('[stage1:integration] PASS: mixed-target WebSocket commands and sensitive unstepped commands are denied before fake-device dispatch');
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
    id: 'harness-tenant-device', name: 'Harness tenant light', protocol: 'zigbee', areaId: areaTwo.osAreaId,
    labelIds: ['tenant_device'], metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id }, state: { state: 'OFF' }, setup: { status: 'ready' },
    entities: { 'harness-tenant-device:state': { name: 'Harness tenant light', stateKey: 'state', domain: 'switch', category: 'control', writable: true, primary: true, capability: { readable: true, writable: true, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }] } } },
  });
  tenantSocket.send(JSON.stringify({ id: 12, type: 'call_service', domain: 'switch', service: 'turn_on', target: { entity_id: tenantEntity.haId } }));
  const movedDeviceCommand = await wsMessage(tenantSocket, 'moved tenant device command');
  if (movedDeviceCommand.success || fakePhysicalCommandCount !== 1) fail('Tenant command remained allowed after its device moved outside the granted area');
  await hub.store.upsertDevice({
    id: 'harness-tenant-device', name: 'Harness tenant light', protocol: 'zigbee', areaId: areaOne.osAreaId,
    labelIds: ['tenant_device'], metadata: { label: 'tenant_device', tenantOwnerMembershipId: tenantMembership.id }, state: { state: 'OFF' }, setup: { status: 'ready' },
    entities: { 'harness-tenant-device:state': { name: 'Harness tenant light', stateKey: 'state', domain: 'switch', category: 'control', writable: true, primary: true, capability: { readable: true, writable: true, primary: true, category: 'control', bindings: [{ serviceId: 'switch.turn_on' }, { serviceId: 'switch.turn_off' }, { serviceId: 'switch.toggle' }] } } },
  });
  await hub.store.upsertDevice({
    id: 'harness-tenant-device',
    name: 'Harness tenant light',
    protocol: 'zigbee',
    areaId: areaOne.osAreaId,
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
    id: 'harness-tenant-device', name: 'Harness tenant light', protocol: 'zigbee', areaId: areaOne.osAreaId,
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
  hub.pairing.apiUrl = base;
  await hub.vault.set('platform.machineCredential', machineSecret);
  await hub.store.savePlatform({ paired: true, hubInstallId: hubOne.id, provisioningCredentialVersion: 1 });
  // This disposable installation fixture intentionally lacks the separate
  // provisioning approval object; skip only the initial-liveness heartbeat
  // and exercise the real machine-authenticated policy/token-state route.
  hub.pairing.lastHeartbeatAt = Date.now();
  await hub.pairing.syncNow();
  const preRevocationOsGrant = hub.store.getSecurity().offlineAuthorisations?.[revocableOffline.body.authorisation.id];
  if (!preRevocationOsGrant || preRevocationOsGrant.userId !== account.id || preRevocationOsGrant.revokedAt) {
    const platformGrant = await prisma.offlineMembershipAuthorisation.findUnique({ where: { id: revocableOffline.body.authorisation.id }, select: { id: true, homeId: true, hubInstallationId: true, revokedAt: true } });
    fail(`The real active offline grant was not synchronized to Dinodia OS before device removal (${JSON.stringify({ osHasGrant: Boolean(preRevocationOsGrant), osAccountMatches: preRevocationOsGrant?.userId === account.id, osRevoked: Boolean(preRevocationOsGrant?.revokedAt), platformHasGrant: Boolean(platformGrant), platformHomeMatches: platformGrant?.homeId === homeOne.id, platformHubMatches: platformGrant?.hubInstallationId === hubOne.id, syncError: String(hub.pairing.lastError || '').slice(0, 160) })})`);
  }
  const removalChallenge = await fetchJson(`${platformBase}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ operationKind: 'trusted_device_remove', targetIds: [revocableTrustedDevice.id], value: null }) });
  if (removalChallenge.response.status !== 200) fail(`Trusted-device removal challenge failed (${removalChallenge.response.status})`);
  const removalSignature = crypto.sign(null, stepUpChallengeMessage({ challengeId: removalChallenge.body.challengeId, nonce: removalChallenge.body.nonce, operationDigest: removalChallenge.body.operationDigest }), crypto.createPrivateKey(phone.privateKey)).toString('base64url');
  const removalProof = await fetchJson(`${platformBase}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ challengeId: removalChallenge.body.challengeId, nonce: removalChallenge.body.nonce, deviceSignature: removalSignature }) });
  if (removalProof.response.status !== 200) fail(`Trusted-device removal proof failed (${removalProof.response.status})`);
  const malformedRemoval = await fetchJson(`${platformBase}/api/v2/trusted-devices/${revocableTrustedDevice.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token, 'x-dinodia-step-up-proof': removalProof.body.proof }, body: JSON.stringify({ proof: removalProof.body.proof, accountId: 'attacker-selected-account' }) });
  const beforeRejectedRemoval = await prisma.trustedDevice.findUniqueOrThrow({ where: { id: revocableTrustedDevice.id }, select: { revokedAt: true } });
  const beforeRejectedGrant = await prisma.offlineMembershipAuthorisation.findUniqueOrThrow({ where: { id: revocableOffline.body.authorisation.id }, select: { revokedAt: true } });
  if (malformedRemoval.response.status !== 400 || malformedRemoval.body.error?.code !== 'VALIDATION_FAILED' || beforeRejectedRemoval.revokedAt || beforeRejectedGrant.revokedAt) fail(`Malformed trusted-device removal was not rejected before durable effects (${malformedRemoval.response.status})`);
  const removedDevice = await fetchJson(`${platformBase}/api/v2/trusted-devices/${revocableTrustedDevice.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': tenantToken.body.token }, body: JSON.stringify({ proof: removalProof.body.proof }) });
  if (removedDevice.response.status !== 200 || removedDevice.body.accountWide !== true) fail(`Real account-wide trusted-device removal failed (${removedDevice.response.status})`);
  const revokedGrantRow = await prisma.offlineMembershipAuthorisation.findUnique({ where: { id: revocableOffline.body.authorisation.id }, select: { revokedAt: true, revokeReason: true } });
  if (!revokedGrantRow?.revokedAt || revokedGrantRow.revokeReason !== 'trusted_device_removed') fail('Platform device removal did not revoke its durable offline authority');
  const removedSessionRetry = await fetchJson(`${platformBase}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': revocableRawSession }, body: JSON.stringify({ homeId: homeOne.id }) });
  if (removedSessionRetry.response.status !== 401) fail(`Removed trusted device could issue another customer token (${removedSessionRetry.response.status})`);
  const revokedDeviceLogin = await fetchJson(`${platformBase}/api/v2/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: customerPassword, deviceInstallationId: revocableInstallationId, publicKey: revocablePhone.publicKey, deviceName: 'Harness revoked phone re-login', model: 'integration-test', osFamily: 'test', osVersion: 'test' }) });
  const revokedDeviceAfterLogin = await prisma.trustedDevice.findUniqueOrThrow({ where: { id: revocableTrustedDevice.id }, select: { revokedAt: true, publicKeyThumbprint: true, sessionVersion: true } });
  const revokedDeviceSessionCount = await prisma.customerSession.count({ where: { trustedDeviceId: revocableTrustedDevice.id } });
  if (revokedDeviceLogin.response.status !== 403 || revokedDeviceLogin.body.error?.code !== 'AUTH_REQUIRED' || !revokedDeviceLogin.body.error?.requestId || !revokedDeviceAfterLogin.revokedAt || revokedDeviceAfterLogin.publicKeyThumbprint !== revocablePhoneThumbprint || revokedDeviceSessionCount !== 1) fail('Ordinary password login silently restored a revoked trusted phone or created a new session');
  const changedIdentityLogin = await fetchJson(`${platformBase}/api/v2/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: customerPassword, deviceInstallationId: trustedInstallationId, publicKey: revocablePhone.publicKey, deviceName: 'Harness substituted phone key', model: 'integration-test', osFamily: 'test', osVersion: 'test' }) });
  if (changedIdentityLogin.response.status !== 409 || changedIdentityLogin.body.error?.code !== 'SCOPE_DENIED' || !changedIdentityLogin.body.error?.requestId) fail(`An active installation ID silently replaced its signing key (${changedIdentityLogin.response.status})`);
  while (hub.pairing.syncing) await new Promise((resolve) => setTimeout(resolve, 10));
  hub.pairing.nextRetryAt = 0;
  let callbackRevocation = null;
  const acceptOfflineAuthorisations = hub.pairing.acceptOfflineAuthorisations;
  hub.pairing.acceptOfflineAuthorisations = async (rows) => {
    callbackRevocation = rows.find((entry) => entry.payload?.id === revocableOffline.body.authorisation.id)?.payload || null;
    return acceptOfflineAuthorisations(rows);
  };
  const revocationSync = await hub.pairing.syncNow();
  hub.pairing.acceptOfflineAuthorisations = acceptOfflineAuthorisations;
  const signedRevocation = revocationSync?.offlineAuthorisations?.find((entry) => entry.payload?.id === revocableOffline.body.authorisation.id);
  if (!signedRevocation?.payload?.revokedAt || signedRevocation.payload.revokeReason !== 'trusted_device_removed') fail('The real machine-authenticated token-state response did not contain the signed account-wide revocation');
  const revokedOsGrant = hub.store.getSecurity().offlineAuthorisations?.[revocableOffline.body.authorisation.id];
  if (!revokedOsGrant?.revokedAt || revokedOsGrant.revokeReason !== 'trusted_device_removed') fail(`Running Dinodia OS did not persist the Platform-signed account-wide offline revocation (${JSON.stringify({ osHasGrant: Boolean(revokedOsGrant), osRevoked: Boolean(revokedOsGrant?.revokedAt), osReason: revokedOsGrant?.revokeReason || null, osUserMatches: revokedOsGrant?.userId === account.id, callbackHadGrant: Boolean(callbackRevocation), callbackRevoked: Boolean(callbackRevocation?.revokedAt), callbackReason: callbackRevocation?.revokeReason || null, syncError: String(hub.pairing.lastError || '').slice(0, 160) })})`);
  const revokedChallenge = { v: 1, homeId: homeOne.id, hubInstallId: hubOne.id, areaId: areaOne.id, deviceId: 'harness-tenant-device', controlId: offlineControlId, valueDigest: offlineValueDigest, nonce: `offline-revoked-${crypto.randomUUID()}`, issuedAt: Date.now() };
  const revokedHeaders = { 'x-dinodia-offline-grant': revocableOffline.body.authorisation.id, 'x-dinodia-offline-challenge': Buffer.from(JSON.stringify(revokedChallenge), 'utf8').toString('base64url'), 'x-dinodia-offline-signature': crypto.sign(null, Buffer.from(JSON.stringify(revokedChallenge), 'utf8'), crypto.createPrivateKey(revocablePhone.privateKey)).toString('base64url') };
  const revokedCommand = await fetchJson(`${osBase}/_dinodia/admin/api/entities/${offlineEntityPath}/service`, { method: 'POST', headers: { 'content-type': 'application/json', ...revokedHeaders }, body: JSON.stringify({ serviceId: 'switch.turn_on', data: offlineCommandValue }) });
  if (revokedCommand.response.status !== 401 || fakePhysicalCommandCount !== 2) fail(`Revoked phone retained offline command authority or caused a side effect (${revokedCommand.response.status}/${fakePhysicalCommandCount})`);
  console.log('[stage1:integration] PASS: real trusted-device removal revokes durable Platform and signed OS offline grants; revoked phone cannot re-login, replace its key, issue sessions or dispatch commands');
  const operatorPassword = `harness-installer-password-${crypto.randomUUID()}`;
  const operatorEmail = `installer-${crypto.randomUUID()}@invalid.test`;
  const operatorEmployee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Harness Installer', email: operatorEmail, emailNormalized: operatorEmail, role: 'INSTALLER', status: 'ACTIVE', passwordHash: hashPassword(operatorPassword) } });
  const operatorLogin = await loginEmployee(base, operatorEmployee, operatorPassword);
  const operatorSession = operatorLogin.session;
  const operatorToken = operatorLogin.token;
  const operatorWork = await prisma.companyOperationalWorkItem.create({ data: { publicReference: `DIN-${sha256(`handoff-${crypto.randomUUID()}`).slice(0, 16).toUpperCase()}`, kind: 'INITIAL_HUB_INSTALLATION', state: 'ASSIGNED', homeId: homeOne.id, hubInstallationId: hubOne.id, certifiedSerialNumber: identityOne.serialNumber, assignedEmployeeId: operatorEmployee.id, createdByEmployeeId: operatorEmployee.id, reason: 'Disposable browser-bound operator handoff test' } });
  customerFixture = { accountId: account.id, sessionId: session.id, trustedDeviceId: trusted.id, trustedPhonePrivateKey: phone.privateKey, customerSessionSecret: rawSession, offlineAuthorisationId: tenantOffline.body.authorisation.id, revocableTrustedDeviceId: revocableTrustedDevice.id, revocableRawSession, revocablePhonePrivateKey: revocablePhone.privateKey, revocableOfflineAuthorisationId: revocableOffline.body.authorisation.id, propertyAccountId: propertyAccount.id, propertySessionId: propertySession.id, propertyTrustedDeviceId: propertyTrusted.id, managerAccountId: managerAccount.id, managerMembershipId: managerMembership.id, managerSessionId: managerSession.id, managerTrustedDeviceId: managerTrusted.id, homeOneId: homeOne.id, homeTwoId: homeTwo.id, hubOneId: hubOne.id, hubTwoId: hubTwo.id, identityOneId: identityOne.id, identityTwoId: identityTwo.id, tenantDeviceId: tenantDevice.id, machineSecret, tenantMembershipId: tenantMembership.id, ownerMembershipId: ownerMembership.id, propertyMembershipId: propertyMembership.id, areaOneId: areaOne.id, areaOneOsId: areaOne.osAreaId, areaTwoId: areaTwo.id, areaTwoOsId: areaTwo.osAreaId, tenantToken: tenantToken.body.token, ownerToken: ownerToken.body.token, propertyToken: propertyToken.body.token, managerToken: managerToken.body.token, ticketId, stepUpTicketId, identityOneSigningPrivateKey: identityOneSigning.privateKey, identityOneSigningPublicKey: identityOneSigning.publicKey, identityOneEncryptionPrivateKey: identityOneEncryption.privateKey, identityOneEncryptionPublicKey: identityOneEncryption.publicKey, identityOneSerial: identityOne.serialNumber, identityOneGeneration: identityOne.identityGeneration, operatorEmployeeId: operatorEmployee.id, operatorSessionId: operatorSession.id, operatorWorkId: operatorWork.id, operatorToken };
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
    await prisma.employeeSession.update({ where: { id: login.session.id }, data: { recentAuthenticatedAt: new Date(Date.now() - 5 * 60 * 1000 - 1) } });
    const staleRotate = await post('rotate', `operator-rotate-stale-${crypto.randomUUID()}`, work.id);
    const staleRevoke = await post('revoke', `operator-revoke-stale-${crypto.randomUUID()}`, work.id, { reason: 'recent-auth policy check' });
    if (staleRotate.response.status !== 401 || staleRotate.body.errorCode !== 'recent_authentication_required' || staleRevoke.response.status !== 401 || staleRevoke.body.errorCode !== 'recent_authentication_required') fail('The day-session exception leaked into credential rotation or emergency revocation');
    await prisma.employeeSession.update({ where: { id: login.session.id }, data: { recentAuthenticatedAt: new Date() } });
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
  // Match the exact verified reserved hostname seeded for hub one. The
  // operator-attempt route intentionally rejects a caller-selected origin.
  const remoteHost = harnessCloudHostname;
  const remoteOsHeaders = { host: remoteHost, origin: `https://${remoteHost}`, 'x-forwarded-proto': 'https' };
  let localHost = '192.168.0.111:8123';
  let localOsHeaders = { host: localHost, origin: `http://${localHost}` };
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
  let simulatedLanAddress = '192.168.0.110';
  hub.pairing.getLanEndpoint = () => simulatedLanAddress
    ? { state: 'CURRENT', address: simulatedLanAddress, interfaceName: 'eth0' }
    : { state: 'UNAVAILABLE', interfaceName: null };
  // Synchronize signed policy from the actual Platform machine route into the
  // running OS store, including both active and later-revoked phone grants.
  await hub.pairing.requestImmediateHeartbeat();
  const synchronizedAreaBindings = hub.store.getPlatform().areaBindings;
  const sortedAreaBindings = [...synchronizedAreaBindings].sort((left, right) => left.areaId.localeCompare(right.areaId));
  const expectedAreaBindings = [
    { areaId: customerFixture.areaOneId, hubAreaId: customerFixture.areaOneOsId },
  ].sort((left, right) => left.areaId.localeCompare(right.areaId));
  if (JSON.stringify(sortedAreaBindings) !== JSON.stringify(expectedAreaBindings)) fail('Machine-authenticated token-state did not synchronize the canonical Area UUID to private OS alias mapping');
  let endpointRow = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointReportedAt: true, lanEndpointState: true, lanEndpointIdentityGeneration: true } });
  if (endpointRow.baseUrl !== 'http://192.168.0.110:8123' || endpointRow.lanEndpointState !== 'CURRENT' || endpointRow.lanEndpointRevision < 1 || endpointRow.lanEndpointIdentityGeneration !== customerFixture.identityOneGeneration) fail('The real signed OS heartbeat did not replace the stale historical LAN endpoint with the current identity-bound endpoint');
  const signedHeartbeat = async (body, nonce = `harness-endpoint-${crypto.randomUUID()}`) => {
    const requestPath = '/api/hub-agent/v2/heartbeat';
    const raw = JSON.stringify(body);
    const timestamp = String(Date.now());
    const bodyHash = sha256(raw);
    const signature = crypto.createHmac('sha256', sha256(customerFixture.machineSecret)).update(canonicalHubRequest({ method: 'POST', path: requestPath, timestamp, nonce, bodyHash }), 'utf8').digest('base64url');
    const headers = { 'content-type': 'application/json', 'x-dinodia-machine-version': '1', 'x-dinodia-machine-signature': signature, 'x-dinodia-hub-timestamp': timestamp, 'x-dinodia-hub-nonce': nonce, 'x-dinodia-body-sha256': bodyHash };
    return { result: await fetchJson(`${platformBase}${requestPath}`, { method: 'POST', headers, body: raw }), headers, raw };
  };
  await sleep(3);
  const repeatedEndpoint = await signedHeartbeat({ serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, hubRuntime: { version: 'test-runtime' }, lanEndpoint: { version: 1, revision: endpointRow.lanEndpointRevision, state: 'CURRENT', baseUrl: 'http://192.168.0.110:8123', discoveryHost: `dinodia-${customerFixture.identityOneSerial.toLowerCase()}.local` } });
  if (repeatedEndpoint.result.response.status !== 200 || repeatedEndpoint.result.body.lanEndpoint?.revision !== endpointRow.lanEndpointRevision) fail(`A fresh-nonce repeat of the same LAN observation was not idempotently acknowledged (${repeatedEndpoint.result.response.status})`);
  const repeatedReceipt = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointReportedAt: true } });
  if (repeatedReceipt.baseUrl !== endpointRow.baseUrl || repeatedReceipt.lanEndpointRevision !== endpointRow.lanEndpointRevision || repeatedReceipt.lanEndpointReportedAt <= endpointRow.lanEndpointReportedAt) fail('A same-revision signed heartbeat did not refresh only its durable receipt time');
  const nextEndpointRevision = repeatedReceipt.lanEndpointRevision + 1;
  simulatedLanAddress = '192.168.0.111';
  await hub.pairing.requestImmediateHeartbeat();
  endpointRow = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointReportedAt: true, lanEndpointState: true } });
  if (endpointRow.baseUrl !== 'http://192.168.0.111:8123' || endpointRow.lanEndpointRevision !== nextEndpointRevision || endpointRow.lanEndpointState !== 'CURRENT') fail('A simulated DHCP address change did not atomically publish the next LAN endpoint revision');
  const priorRevision = await signedHeartbeat({ serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, lanEndpoint: { version: 1, revision: nextEndpointRevision - 1, state: 'CURRENT', baseUrl: 'http://192.168.0.110:8123', discoveryHost: `dinodia-${customerFixture.identityOneSerial.toLowerCase()}.local` } });
  const conflictingRevision = await signedHeartbeat({ serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, lanEndpoint: { version: 1, revision: nextEndpointRevision, state: 'CURRENT', baseUrl: 'http://192.168.0.110:8123', discoveryHost: `dinodia-${customerFixture.identityOneSerial.toLowerCase()}.local` } });
  const publicAddress = await signedHeartbeat({ serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, lanEndpoint: { version: 1, revision: nextEndpointRevision + 1, state: 'CURRENT', baseUrl: 'http://8.8.8.8:8123', discoveryHost: `dinodia-${customerFixture.identityOneSerial.toLowerCase()}.local` } });
  if (priorRevision.result.response.status !== 409 || conflictingRevision.result.response.status !== 409 || publicAddress.result.response.status !== 400) fail(`Stale, conflicting or public endpoint reports were not rejected (${priorRevision.result.response.status}/${conflictingRevision.result.response.status}/${publicAddress.result.response.status})`);
  const afterEndpointDenials = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointState: true } });
  if (afterEndpointDenials.baseUrl !== endpointRow.baseUrl || afterEndpointDenials.lanEndpointRevision !== endpointRow.lanEndpointRevision || afterEndpointDenials.lanEndpointState !== 'CURRENT') fail('A rejected endpoint observation changed the durable BaseURL or endpoint authority');
  const replayedHeartbeat = await fetchJson(`${platformBase}/api/hub-agent/v2/heartbeat`, { method: 'POST', headers: repeatedEndpoint.headers, body: repeatedEndpoint.raw });
  if (replayedHeartbeat.response.status !== 401 || replayedHeartbeat.body.errorCode !== 'hub_nonce_replayed') fail(`Exact signed heartbeat replay was not rejected (${replayedHeartbeat.response.status}/${replayedHeartbeat.body.errorCode})`);
  const concurrentRevision = endpointRow.lanEndpointRevision + 1;
  const [concurrentPrior, concurrentNewer] = await Promise.all([
    signedHeartbeat({ serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, lanEndpoint: { version: 1, revision: endpointRow.lanEndpointRevision, state: 'CURRENT', baseUrl: 'http://192.168.0.111:8123', discoveryHost: `dinodia-${customerFixture.identityOneSerial.toLowerCase()}.local` } }),
    signedHeartbeat({ serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, lanEndpoint: { version: 1, revision: concurrentRevision, state: 'CURRENT', baseUrl: 'http://192.168.0.112:8123', discoveryHost: `dinodia-${customerFixture.identityOneSerial.toLowerCase()}.local` } }),
  ]);
  if (concurrentNewer.result.response.status !== 200 || ![200, 409].includes(concurrentPrior.result.response.status)) fail(`Concurrent out-of-order signed heartbeats did not resolve safely (${concurrentPrior.result.response.status}/${concurrentNewer.result.response.status})`);
  simulatedLanAddress = '192.168.0.112';
  await hub.pairing.requestImmediateHeartbeat();
  endpointRow = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointReportedAt: true, lanEndpointState: true } });
  if (endpointRow.baseUrl !== 'http://192.168.0.112:8123' || endpointRow.lanEndpointRevision !== concurrentRevision || endpointRow.lanEndpointState !== 'CURRENT') fail('Out-of-order heartbeat race did not converge to the latest signed physical endpoint');
  localHost = '192.168.0.112:8123';
  localOsHeaders = { host: localHost, origin: `http://${localHost}` };
  const afterConcurrentDenials = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointState: true } });
  if (afterConcurrentDenials.baseUrl !== endpointRow.baseUrl || afterConcurrentDenials.lanEndpointRevision !== endpointRow.lanEndpointRevision) fail('A concurrent stale endpoint report rolled back the current BaseURL');
  console.log('[stage1:integration] PASS: machine-authenticated heartbeat replaced the old LAN address; same-revision receipts refresh idempotently; DHCP revision, stale/conflict/public denial and nonce replay preserve endpoint authority');
  const syncedOfflineGrants = hub.store.getSecurity().offlineAuthorisations || {};
  if (!syncedOfflineGrants[customerFixture.offlineAuthorisationId] || syncedOfflineGrants[customerFixture.offlineAuthorisationId].userId !== customerFixture.accountId) fail('Platform-signed offline grant did not retain its customer identity on the OS');
  const revokedOsGrant = syncedOfflineGrants[customerFixture.revocableOfflineAuthorisationId];
  if (!revokedOsGrant?.userId || revokedOsGrant.userId !== customerFixture.accountId || !revokedOsGrant.revokedAt || revokedOsGrant.revokeReason !== 'trusted_device_removed') fail('Real signed policy sync did not persist the account-wide phone revocation on the OS');
  const revokedEntity = hub.model.entities().find((entity) => entity.device.id === 'harness-tenant-device');
  if (!revokedEntity) fail('Cannot find the fake tenant control for the revoked offline command check');
  const revokedControlId = String(revokedEntity.entity.id);
  const revokedCommandValue = {};
  const revokedValueDigest = sha256(JSON.stringify({ deviceId: 'harness-tenant-device', entityId: revokedEntity.haId, controlId: revokedControlId, serviceId: 'switch.turn_on', value: revokedCommandValue }));
  const revokedChallenge = { v: 1, homeId: customerFixture.homeOneId, hubInstallId: customerFixture.hubOneId, areaId: customerFixture.areaOneId, deviceId: 'harness-tenant-device', controlId: revokedControlId, valueDigest: revokedValueDigest, nonce: `offline-revoked-${crypto.randomUUID()}`, issuedAt: Date.now() };
  const revokedHeaders = { 'x-dinodia-offline-grant': customerFixture.revocableOfflineAuthorisationId, 'x-dinodia-offline-challenge': Buffer.from(JSON.stringify(revokedChallenge), 'utf8').toString('base64url'), 'x-dinodia-offline-signature': crypto.sign(null, Buffer.from(JSON.stringify(revokedChallenge), 'utf8'), crypto.createPrivateKey(customerFixture.revocablePhonePrivateKey)).toString('base64url') };
  const revokedCommand = await fetchJson(`${base}/_dinodia/admin/api/entities/${encodeURIComponent(revokedControlId)}/service`, { method: 'POST', headers: { 'content-type': 'application/json', ...revokedHeaders }, body: JSON.stringify({ serviceId: 'switch.turn_on', data: revokedCommandValue }) });
  if (revokedCommand.response.status !== 401 || fakePhysicalCommandCount !== 2) fail(`Revoked phone retained offline command authority or caused a side effect (${revokedCommand.response.status}/${fakePhysicalCommandCount})`);
  console.log('[stage1:integration] PASS: post-revocation hub sync rejects the previously issued offline grant without a command side effect');
  const platformTenantRead = await fetchJson(`${base}/_dinodia/admin/api/devices`, { headers: { authorization: `Bearer ${customerFixture.tenantToken}` } });
  if (platformTenantRead.response.status !== 200) fail(`A real Platform-issued tenant token was not accepted by Dinodia OS (${platformTenantRead.response.status}/${platformTenantRead.body.errorCode || platformTenantRead.body.error || 'unknown'})`);
  const freshNativeSession = await fetchJson(`${platformBase}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': customerFixture.customerSessionSecret }, body: JSON.stringify({ homeId: customerFixture.homeOneId }) });
  if (freshNativeSession.response.status !== 200 || !freshNativeSession.body.token) fail(`Real customer login could not refresh a selected-home token for Native V1 HTTP (${freshNativeSession.response.status}/${freshNativeSession.body.error?.code || 'unknown'})`);
  const nativeDeviceRead = await fetchJson(`${base}/api/dinodia/v1/devices`, { headers: { authorization: `Bearer ${freshNativeSession.body.token}` } });
  let nativeTenantDevice = nativeDeviceRead.body.data?.find((device) => device.id === 'harness-tenant-device');
  if (nativeDeviceRead.response.status !== 200 || !nativeTenantDevice || nativeTenantDevice.managementClass !== 'tenant_device' || nativeTenantDevice.ownerMembershipId !== customerFixture.tenantMembershipId || JSON.stringify(nativeTenantDevice.areaIds) !== JSON.stringify([customerFixture.areaOneId]) || nativeTenantDevice.areaIds.includes(customerFixture.areaOneOsId)) fail(`Native V1 OS read did not serialize only the canonical Platform Area UUID for a private device (${nativeDeviceRead.response.status}/${nativeDeviceRead.body?.error?.code || nativeDeviceRead.body?.errorCode || 'no-code'}/${JSON.stringify(nativeTenantDevice?.areaIds || null)})`);
  let nativeControl = nativeTenantDevice.controls.find((control) => control.writable && control.valueType === 'boolean');
  if (!nativeControl) fail('The safe fixture device did not expose a writable boolean Native V1 control');
  const originalSensitiveTestDevice = hub.store.getDevice(nativeTenantDevice.id);
  const sensitiveTestEntity = Object.values(originalSensitiveTestDevice?.entities || {}).find((entity) => String(entity.id || entity.sourceId || entity.stateKey || entity.name) === nativeControl.controlId);
  if (!originalSensitiveTestDevice || !sensitiveTestEntity?.capability) fail('Could not mark the authorized tenant control as sensitive for the Native V1 route regression');
  const sensitiveTestDevice = structuredClone(originalSensitiveTestDevice);
  const sensitiveTestEntityCopy = Object.values(sensitiveTestDevice.entities || {}).find((entity) => String(entity.id || entity.sourceId || entity.stateKey || entity.name) === nativeControl.controlId);
  sensitiveTestEntityCopy.capability = { ...sensitiveTestEntityCopy.capability, sensitive: true };
  await hub.store.upsertDevice(sensitiveTestDevice);
  const sensitiveNativeRead = await fetchJson(`${base}/api/dinodia/v1/devices`, { headers: { authorization: `Bearer ${freshNativeSession.body.token}` } });
  const nativeSensitiveDevice = sensitiveNativeRead.body.data?.find((device) => device.id === nativeTenantDevice.id);
  const nativeSensitiveControl = nativeSensitiveDevice?.controls.find((control) => control.controlId === nativeControl.controlId);
  if (!nativeSensitiveControl || nativeSensitiveControl.stepUpPolicy !== 'required' || nativeSensitiveControl.confirmationPolicy !== 'step_up' || nativeSensitiveControl.automatable) fail('OS Native V1 failed to project the current tenant control as sensitive and non-automatable');
  const nativeSensitiveCommand = { commandId: `command-${crypto.randomUUID()}`, homeId: customerFixture.homeOneId, homeMembershipId: customerFixture.tenantMembershipId, deviceId: nativeSensitiveDevice.id, controlId: nativeSensitiveControl.controlId, descriptorRevision: nativeSensitiveDevice.descriptorRevision, value: true, issuedAt: new Date().toISOString(), idempotencyKey: `native-sensitive-${crypto.randomUUID()}`, stepUpOperationId: crypto.randomUUID() };
  const sensitiveEffectsBefore = fakePhysicalCommandCount;
  const deniedNativeSensitiveCommand = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': nativeSensitiveCommand.idempotencyKey, 'x-dinodia-step-up-proof': 'harness-invalid-step-up-proof' }, body: JSON.stringify(nativeSensitiveCommand) });
  if (deniedNativeSensitiveCommand.response.status !== 403 || deniedNativeSensitiveCommand.body.error?.code !== 'STEP_UP_REQUIRED' || fakePhysicalCommandCount !== sensitiveEffectsBefore) fail(`Sensitive Native V1 command did not require a valid exact-operation proof before dispatch (${deniedNativeSensitiveCommand.response.status}/${deniedNativeSensitiveCommand.body?.error?.code || 'no-code'}/${fakePhysicalCommandCount - sensitiveEffectsBefore})`);
  const sensitiveValue = true;
  const descriptorChallengeResponse = await fetchJsonLoopback(`${base}/api/step-up/descriptor-challenge`, {
    method: 'POST',
    headers: { ...localOsHeaders, authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: nativeSensitiveDevice.id, controlId: nativeSensitiveControl.controlId, nonce: `descriptor-${crypto.randomUUID()}`, value: sensitiveValue }),
  });
  if (descriptorChallengeResponse.response.status !== 200 || descriptorChallengeResponse.body.ok !== true) fail(`Actual OS descriptor-challenge route did not attest the current sensitive control (${descriptorChallengeResponse.response.status}/${descriptorChallengeResponse.body.errorCode || 'no-code'})`);
  const sensitiveDescriptorAttestation = { ...descriptorChallengeResponse.body };
  delete sensitiveDescriptorAttestation.ok;
  const sensitiveChallengeRequest = { operationKind: 'device_sensitive_command', targetIds: [nativeSensitiveDevice.id], value: sensitiveValue, descriptorAttestation: sensitiveDescriptorAttestation };
  if (!nativeV1Contract.validateStepUpChallengeRequest(sensitiveChallengeRequest)) fail('Test setup constructed a step-up challenge request rejected by the canonical Platform DTO validator');
  const platformSensitiveDevice = await prisma.nativeDevice.findFirst({ where: { homeId: customerFixture.homeOneId, hubInstallationId: customerFixture.hubOneId, osDeviceId: nativeSensitiveDevice.id }, select: { id: true, lifecycle: true } });
  if (!platformSensitiveDevice || platformSensitiveDevice.lifecycle !== 'INSTALLED') fail('The OS device did not resolve to one installed Platform record inside the selected home and hub');
  const challengesBeforeAlias = await prisma.stepUpChallenge.count({ where: { customerSessionId: customerFixture.sessionId, operationKind: 'device_sensitive_command' } });
  const clientAliasChallenge = await fetchJson(`${platformBase}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': customerFixture.tenantToken }, body: JSON.stringify({ ...sensitiveChallengeRequest, targetIds: [platformSensitiveDevice.id] }) });
  const challengesAfterAlias = await prisma.stepUpChallenge.count({ where: { customerSessionId: customerFixture.sessionId, operationKind: 'device_sensitive_command' } });
  if (clientAliasChallenge.response.status !== 400 || clientAliasChallenge.body.error?.code !== 'VALIDATION_FAILED' || /harness-tenant-device|descriptorDigest|operationDigest/.test(JSON.stringify(clientAliasChallenge.body)) || challengesAfterAlias !== challengesBeforeAlias || fakePhysicalCommandCount !== sensitiveEffectsBefore) fail(`A caller-supplied Platform database UUID substituted for the OS attested device identity (${clientAliasChallenge.response.status}/${clientAliasChallenge.body.error?.code || 'no-code'}; challenges=${challengesAfterAlias - challengesBeforeAlias}; effects=${fakePhysicalCommandCount - sensitiveEffectsBefore})`);
  console.log('[stage2:integration] PASS: a caller-supplied Platform database UUID cannot replace the exact hub-attested OS device ID or create a sensitive challenge');
  const challengesBeforeReadOnly = await prisma.stepUpChallenge.count({ where: { customerSessionId: customerFixture.sessionId, operationKind: 'device_sensitive_command' } });
  await prisma.nativeDevice.update({ where: { id: platformSensitiveDevice.id }, data: { lifecycle: 'VIEW_ONLY' } });
  const readOnlyStepUp = await fetchJson(`${platformBase}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': customerFixture.tenantToken }, body: JSON.stringify(sensitiveChallengeRequest) });
  await prisma.nativeDevice.update({ where: { id: platformSensitiveDevice.id }, data: { lifecycle: platformSensitiveDevice.lifecycle } });
  const challengesAfterReadOnly = await prisma.stepUpChallenge.count({ where: { customerSessionId: customerFixture.sessionId, operationKind: 'device_sensitive_command' } });
  if (readOnlyStepUp.response.status !== 403 || readOnlyStepUp.body.error?.code !== 'SCOPE_DENIED' || /harness-tenant-device|descriptorDigest|operationDigest/.test(JSON.stringify(readOnlyStepUp.body)) || challengesAfterReadOnly !== challengesBeforeReadOnly || fakePhysicalCommandCount !== sensitiveEffectsBefore) fail('A view-only device received a step-up challenge or caused a protected side effect');
  console.log('[stage2:integration] PASS: a currently VIEW_ONLY Platform device cannot obtain a sensitive-command challenge and creates no challenge row or device effect');
  for (const principal of [
    { label: 'owner', token: customerFixture.propertyToken, sessionId: customerFixture.propertySessionId },
    { label: 'property manager', token: customerFixture.managerToken, sessionId: customerFixture.managerSessionId },
  ]) {
    const challengesBeforeRoleDenial = await prisma.stepUpChallenge.count({ where: { customerSessionId: principal.sessionId, operationKind: 'device_sensitive_command' } });
    const roleDeniedStepUp = await fetchJson(`${platformBase}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': principal.token }, body: JSON.stringify(sensitiveChallengeRequest) });
    const challengesAfterRoleDenial = await prisma.stepUpChallenge.count({ where: { customerSessionId: principal.sessionId, operationKind: 'device_sensitive_command' } });
    if (roleDeniedStepUp.response.status !== 403 || roleDeniedStepUp.body.error?.code !== 'SCOPE_DENIED' || /harness-tenant-device|descriptorDigest|operationDigest/.test(JSON.stringify(roleDeniedStepUp.body)) || challengesAfterRoleDenial !== challengesBeforeRoleDenial || fakePhysicalCommandCount !== sensitiveEffectsBefore) fail(`A ${principal.label} obtained tenant-only command confirmation or exposed private descriptor details`);
  }
  console.log('[stage2:integration] PASS: owner and property-manager sessions cannot obtain tenant-only sensitive-command challenges or create challenge/device effects');
  const sensitiveChallenge = await fetchJson(`${platformBase}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': customerFixture.tenantToken }, body: JSON.stringify(sensitiveChallengeRequest) });
  if (sensitiveChallenge.response.status !== 200 || !sensitiveChallenge.body.challengeId) fail(`Actual Platform did not issue the current descriptor-bound phone challenge (${sensitiveChallenge.response.status}/${sensitiveChallenge.body.error?.code || 'no-code'})`);
  const challengesBeforeAttestationReplay = await prisma.stepUpChallenge.count({ where: { customerSessionId: customerFixture.sessionId, operationKind: 'device_sensitive_command' } });
  const replayedDescriptorAttestation = await fetchJson(`${platformBase}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': customerFixture.tenantToken }, body: JSON.stringify(sensitiveChallengeRequest) });
  const challengesAfterAttestationReplay = await prisma.stepUpChallenge.count({ where: { customerSessionId: customerFixture.sessionId, operationKind: 'device_sensitive_command' } });
  if (replayedDescriptorAttestation.response.status !== 403 || replayedDescriptorAttestation.body.error?.code !== 'SCOPE_DENIED' || replayedDescriptorAttestation.body.error?.message !== 'The hub descriptor challenge has already been used' || challengesAfterAttestationReplay !== challengesBeforeAttestationReplay || fakePhysicalCommandCount !== sensitiveEffectsBefore) fail(`An exact OS descriptor-attestation replay did not fail before creating another trusted-phone challenge (${replayedDescriptorAttestation.response.status}/${replayedDescriptorAttestation.body.error?.code || 'no-code'}; challengeDelta=${challengesAfterAttestationReplay - challengesBeforeAttestationReplay}; effects=${fakePhysicalCommandCount - sensitiveEffectsBefore})`);
  console.log('[stage2:integration] PASS: replaying the same hub-signed descriptor nonce cannot create a second Platform phone challenge or device effect');
  const sensitivePhoneSignature = crypto.sign(null, stepUpChallengeMessage({ challengeId: sensitiveChallenge.body.challengeId, nonce: sensitiveChallenge.body.nonce, operationDigest: sensitiveChallenge.body.operationDigest }), crypto.createPrivateKey(customerFixture.trustedPhonePrivateKey)).toString('base64url');
  const issuedSensitiveProof = await fetchJson(`${platformBase}/api/v2/security/step-up/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': customerFixture.tenantToken }, body: JSON.stringify({ challengeId: sensitiveChallenge.body.challengeId, nonce: sensitiveChallenge.body.nonce, deviceSignature: sensitivePhoneSignature }) });
  if (issuedSensitiveProof.response.status !== 200 || typeof issuedSensitiveProof.body.proof !== 'string' || typeof issuedSensitiveProof.body.operationId !== 'string') fail(`Actual Platform did not issue the one-use sensitive-command proof (${issuedSensitiveProof.response.status}/${issuedSensitiveProof.body.error?.code || 'no-code'})`);
  const authorizedSensitiveCommand = { commandId: `command-${crypto.randomUUID()}`, homeId: customerFixture.homeOneId, homeMembershipId: customerFixture.tenantMembershipId, deviceId: nativeSensitiveDevice.id, controlId: nativeSensitiveControl.controlId, descriptorRevision: nativeSensitiveDevice.descriptorRevision, value: sensitiveValue, issuedAt: new Date().toISOString(), idempotencyKey: `native-sensitive-valid-${crypto.randomUUID()}`, stepUpOperationId: issuedSensitiveProof.body.operationId };
  const sensitiveDispatchEffectsBefore = fakePhysicalCommandCount;
  const acceptedSensitiveCommand = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': authorizedSensitiveCommand.idempotencyKey, 'x-dinodia-step-up-proof': issuedSensitiveProof.body.proof }, body: JSON.stringify(authorizedSensitiveCommand) });
  if (acceptedSensitiveCommand.response.status !== 202 || fakePhysicalCommandCount !== sensitiveDispatchEffectsBefore + 1) fail(`A fresh exact-operation trusted-phone proof did not authorize exactly one fake-device dispatch (${acceptedSensitiveCommand.response.status}/${acceptedSensitiveCommand.body.error?.code || 'no-code'}/${fakePhysicalCommandCount - sensitiveDispatchEffectsBefore})`);
  const replayedSensitiveCommand = { ...authorizedSensitiveCommand, commandId: `command-${crypto.randomUUID()}`, idempotencyKey: `native-sensitive-replay-${crypto.randomUUID()}` };
  const replayedSensitiveResponse = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': replayedSensitiveCommand.idempotencyKey, 'x-dinodia-step-up-proof': issuedSensitiveProof.body.proof }, body: JSON.stringify(replayedSensitiveCommand) });
  if (replayedSensitiveResponse.response.status !== 403 || replayedSensitiveResponse.body.error?.code !== 'STEP_UP_REQUIRED' || fakePhysicalCommandCount !== sensitiveDispatchEffectsBefore + 1) fail(`A consumed trusted-phone proof replay was not denied with zero additional device effects (${replayedSensitiveResponse.response.status}/${replayedSensitiveResponse.body.error?.code || 'no-code'}/${fakePhysicalCommandCount - sensitiveDispatchEffectsBefore - 1})`);
  console.log('[stage2:integration] PASS: actual Platform phone challenge/issue authorizes one descriptor-bound OS HTTP command; invalid proof and a replay with a fresh idempotency key are denied with zero extra fake-device effects');
  await hub.store.upsertDevice(originalSensitiveTestDevice);
  const restoredNativeRead = await fetchJson(`${base}/api/dinodia/v1/devices`, { headers: { authorization: `Bearer ${freshNativeSession.body.token}` } });
  nativeTenantDevice = restoredNativeRead.body.data?.find((device) => device.id === 'harness-tenant-device');
  nativeControl = nativeTenantDevice?.controls.find((control) => control.writable && control.valueType === 'boolean');
  if (restoredNativeRead.response.status !== 200 || !nativeTenantDevice || !nativeControl) fail('The tenant descriptor did not recover after the sensitive step-up regression fixture was restored');
  const nativeCommand = { commandId: `command-${crypto.randomUUID()}`, homeId: customerFixture.homeOneId, homeMembershipId: customerFixture.tenantMembershipId, deviceId: nativeTenantDevice.id, controlId: nativeControl.controlId, descriptorRevision: nativeTenantDevice.descriptorRevision, value: true, issuedAt: new Date().toISOString(), idempotencyKey: `native-area-${crypto.randomUUID()}` };
  const physicalBeforeNative = fakePhysicalCommandCount;
  const acceptedNativeCommand = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': nativeCommand.idempotencyKey }, body: JSON.stringify(nativeCommand) });
  if (acceptedNativeCommand.response.status !== 202 || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail(`Native V1 command through a canonical-ID DTO did not dispatch exactly once (${acceptedNativeCommand.response.status}/${fakePhysicalCommandCount - physicalBeforeNative})`);
  const exactNativeRetry = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': nativeCommand.idempotencyKey }, body: JSON.stringify(nativeCommand) });
  if (exactNativeRetry.response.status !== 202 || exactNativeRetry.body.commandId !== nativeCommand.commandId || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail(`An exact Native V1 retry did not return the original acknowledgement without redispatch (${exactNativeRetry.response.status}/${fakePhysicalCommandCount - physicalBeforeNative})`);
  const conflictingNativeRetryCommand = { ...nativeCommand, value: false };
  const conflictingNativeRetry = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': nativeCommand.idempotencyKey }, body: JSON.stringify(conflictingNativeRetryCommand) });
  if (conflictingNativeRetry.response.status !== 409 || conflictingNativeRetry.body.error?.code !== 'REVISION_CONFLICT' || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail(`A conflicting Native V1 idempotency-key reuse was not denied without redispatch (${conflictingNativeRetry.response.status}/${conflictingNativeRetry.body?.error?.code || 'no-code'}/${fakePhysicalCommandCount - physicalBeforeNative})`);
  console.log('[stage2:integration] PASS: exact Native V1 retry returned the original acknowledgement without redispatch; changed-payload key reuse was denied with REVISION_CONFLICT and zero extra fake-device effects');
  const queuedRaceCommand = { ...nativeCommand, commandId: `command-${crypto.randomUUID()}`, idempotencyKey: `native-queued-revision-${crypto.randomUUID()}`, issuedAt: new Date().toISOString() };
  const queuedRaceHash = sha256(`${customerFixture.tenantMembershipId}\n${queuedRaceCommand.idempotencyKey}`);
  const queuedRaceSnapshot = hub.store.getDevice(queuedRaceCommand.deviceId);
  const queuedRaceEntityId = Object.values(queuedRaceSnapshot?.entities || {}).find((entity) => String(entity.id || entity.sourceId || '') === nativeControl.controlId)?.id;
  if (!queuedRaceSnapshot || !queuedRaceEntityId) fail('Could not resolve the real fake-device descriptor for the queued Native V1 race');
  let signalQueuedDispatch;
  let releaseQueuedDispatch;
  let dispatchClaimIntercepted = false;
  const queuedDispatchReached = new Promise((resolve) => { signalQueuedDispatch = resolve; });
  const queuedDispatchGate = new Promise((resolve) => { releaseQueuedDispatch = resolve; });
  const saveSecurityMethod = hub.store.saveSecurity;
  const saveSecurityBound = saveSecurityMethod.bind(hub.store);
  hub.store.saveSecurity = async (patch = {}) => {
    if (!dispatchClaimIntercepted && patch.nativeCommandResults?.[queuedRaceHash]?.status === 'dispatching') {
      dispatchClaimIntercepted = true;
      signalQueuedDispatch();
      await queuedDispatchGate;
    }
    return saveSecurityBound(patch);
  };
  const raceFakeEffectsBefore = fakePhysicalCommandCount;
  const queuedRaceRequest = fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': queuedRaceCommand.idempotencyKey }, body: JSON.stringify(queuedRaceCommand) });
  let queuedRaceResponse;
  let queuedRaceError;
  const dispatchPauseTimeout = setTimeout(() => { queuedRaceError = new Error('Native V1 command did not reach the controlled dispatch-claim boundary'); signalQueuedDispatch(); releaseQueuedDispatch(); }, 5000);
  try {
    await queuedDispatchReached;
    clearTimeout(dispatchPauseTimeout);
    if (queuedRaceError || !dispatchClaimIntercepted) throw queuedRaceError || new Error('Native V1 dispatch-claim barrier was not reached');
    const readOnlyDevice = structuredClone(queuedRaceSnapshot);
    const readOnlyEntity = Object.values(readOnlyDevice.entities || {}).find((entity) => String(entity.id || entity.sourceId || '') === nativeControl.controlId);
    if (!readOnlyEntity) throw new Error('Queued Native V1 race lost its current fake-device control descriptor');
    readOnlyEntity.writable = false;
    readOnlyEntity.capability = { ...readOnlyEntity.capability, readable: true, writable: false, automatable: false };
    await hub.store.upsertDevice(readOnlyDevice);
    releaseQueuedDispatch();
    queuedRaceResponse = await queuedRaceRequest;
  } finally {
    clearTimeout(dispatchPauseTimeout);
    releaseQueuedDispatch();
    hub.store.saveSecurity = saveSecurityMethod;
    await queuedRaceRequest.catch(() => {});
    await hub.store.upsertDevice(queuedRaceSnapshot);
  }
  if (queuedRaceError) throw queuedRaceError;
  if (queuedRaceResponse?.response.status !== 409 || queuedRaceResponse.body.error?.code !== 'CATALOG_REVISION_MISMATCH' || fakePhysicalCommandCount !== raceFakeEffectsBefore) fail(`A control made read-only after command acceptance was dispatched or not rejected at the final boundary (${queuedRaceResponse?.response.status}/${queuedRaceResponse?.body?.error?.code || 'no-code'}/${fakePhysicalCommandCount - raceFakeEffectsBefore})`);
  console.log('[stage2:integration] PASS: a Native V1 control made read-only while its request waited at the dispatch-claim boundary returned CATALOG_REVISION_MISMATCH with zero fake-device effects');
  const wrongHomeCommand = { ...nativeCommand, commandId: `command-${crypto.randomUUID()}`, homeId: customerFixture.homeTwoId, idempotencyKey: `native-wrong-home-${crypto.randomUUID()}` };
  const deniedNativeCommand = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${freshNativeSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': wrongHomeCommand.idempotencyKey }, body: JSON.stringify(wrongHomeCommand) });
  if (deniedNativeCommand.response.status !== 403 || deniedNativeCommand.body.error?.code !== 'HOME_MISMATCH' || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail('Wrong-home Native V1 command was not denied before fake-device dispatch');
  const ownerNativeRead = await fetchJson(`${base}/api/dinodia/v1/devices`, { headers: { authorization: `Bearer ${customerFixture.propertyToken}` } });
  if (ownerNativeRead.response.status !== 403 || ownerNativeRead.body.error?.code !== 'SCOPE_DENIED' || JSON.stringify(ownerNativeRead.body).includes('Harness tenant light') || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail('Property-role Native V1 OS read was not denied without private device bytes');
  const managerNativeRead = await fetchJson(`${base}/api/dinodia/v1/devices`, { headers: { authorization: `Bearer ${customerFixture.managerToken}` } });
  if (managerNativeRead.response.status !== 403 || managerNativeRead.body.error?.code !== 'SCOPE_DENIED' || /harness-tenant-device|Harness tenant light|tenantOwnerMembershipId/.test(JSON.stringify(managerNativeRead.body)) || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail('Manager cloud visibility became direct OS device-read authority or exposed tenant-private bytes');
  const managerNativeCommand = { ...nativeCommand, commandId: `command-${crypto.randomUUID()}`, homeMembershipId: customerFixture.managerMembershipId, idempotencyKey: `native-manager-denied-${crypto.randomUUID()}` };
  const deniedManagerCommand = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${customerFixture.managerToken}`, 'content-type': 'application/json', 'idempotency-key': managerNativeCommand.idempotencyKey }, body: JSON.stringify(managerNativeCommand) });
  if (deniedManagerCommand.response.status !== 403 || deniedManagerCommand.body.error?.code !== 'SCOPE_DENIED' || /harness-tenant-device|Harness tenant light|tenantOwnerMembershipId/.test(JSON.stringify(deniedManagerCommand.body)) || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail('Manager cloud visibility became direct OS command authority or caused a fake-device effect');
  const otherTenantEmail = `stage1-other-tenant-${crypto.randomUUID()}@invalid.test`;
  const otherTenantUsername = `stage1-other-${crypto.randomUUID().slice(0, 8)}`;
  const otherTenantAccount = await prisma.customerAccount.create({ data: { displayName: 'Stage 1 other tenant', username: otherTenantUsername, usernameNormalized: otherTenantUsername, email: otherTenantEmail, emailNormalized: otherTenantEmail, emailVerifiedAt: new Date(), passwordHash: 'harness-only-password-hash' } });
  const otherTenantMembership = await prisma.homeMembership.create({ data: { customerAccountId: otherTenantAccount.id, homeId: customerFixture.homeOneId, role: 'TENANT' } });
  const otherTenantPhone = keyPair();
  const otherTenantThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(otherTenantPhone.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  const otherTenantTrusted = await prisma.trustedDevice.create({ data: { customerAccountId: otherTenantAccount.id, deviceInstallationId: `harness-other-tenant-phone-${crypto.randomUUID()}`, publicKey: otherTenantPhone.publicKey, publicKeyThumbprint: otherTenantThumbprint, deviceName: 'Harness other tenant phone' } });
  const otherTenantRawSession = `harness-other-tenant-session-${crypto.randomUUID()}`;
  const otherTenantSession = await prisma.customerSession.create({ data: { customerAccountId: otherTenantAccount.id, trustedDeviceId: otherTenantTrusted.id, refreshTokenHash: sha256(otherTenantRawSession), securityVersion: otherTenantAccount.securityVersion, trustedDeviceSessionVersion: otherTenantTrusted.sessionVersion, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  const otherTenantHubSession = await fetchJson(`${platformBase}/api/v2/hub-sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-session': otherTenantRawSession }, body: JSON.stringify({ homeId: customerFixture.homeOneId }) });
  if (otherTenantHubSession.response.status !== 200 || !otherTenantHubSession.body.token) fail(`A second tenant could not receive its own selected-home fixture token (${otherTenantHubSession.response.status})`);
  const otherTenantChallengesBefore = await prisma.stepUpChallenge.count({ where: { customerSessionId: otherTenantSession.id, operationKind: 'device_sensitive_command' } });
  const ungrantedStepUp = await fetchJson(`${platformBase}/api/v2/security/step-up/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-app-token': otherTenantHubSession.body.token }, body: JSON.stringify(sensitiveChallengeRequest) });
  const otherTenantChallengesAfter = await prisma.stepUpChallenge.count({ where: { customerSessionId: otherTenantSession.id, operationKind: 'device_sensitive_command' } });
  if (ungrantedStepUp.response.status !== 403 || ungrantedStepUp.body.error?.code !== 'SCOPE_DENIED' || /harness-tenant-device|Harness tenant light|descriptorDigest|operationDigest/.test(JSON.stringify(ungrantedStepUp.body)) || otherTenantChallengesAfter !== otherTenantChallengesBefore || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail('A second tenant without the current area grant obtained a sensitive challenge or observed private device details');
  console.log('[stage2:integration] PASS: a second tenant without the selected device area grant cannot obtain a sensitive challenge, see private descriptor details, or cause a device effect');
  customerFixture.otherTenantAccountId = otherTenantAccount.id;
  customerFixture.otherTenantMembershipId = otherTenantMembership.id;
  customerFixture.otherTenantTrustedId = otherTenantTrusted.id;
  customerFixture.otherTenantSessionId = otherTenantSession.id;
  const otherTenantRead = await fetchJson(`${base}/api/dinodia/v1/devices`, { headers: { authorization: `Bearer ${otherTenantHubSession.body.token}` } });
  const otherTenantReadJson = JSON.stringify(otherTenantRead.body);
  if (otherTenantRead.response.status !== 200 || !nativeV1Contract.validateEnvelope(otherTenantRead.body, customerFixture.homeOneId) || otherTenantRead.body.data.some((device) => device.id === nativeTenantDevice.id) || /harness-tenant-device|Harness tenant light|tenantOwnerMembershipId/.test(otherTenantReadJson) || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail(`Another tenant received private device bytes or altered device state (${otherTenantRead.response.status})`);
  const otherTenantCommand = { ...nativeCommand, commandId: `command-${crypto.randomUUID()}`, homeMembershipId: otherTenantMembership.id, idempotencyKey: `native-other-tenant-${crypto.randomUUID()}` };
  const deniedOtherTenantCommand = await fetchJson(`${base}/api/dinodia/v1/commands`, { method: 'POST', headers: { authorization: `Bearer ${otherTenantHubSession.body.token}`, 'content-type': 'application/json', 'idempotency-key': otherTenantCommand.idempotencyKey }, body: JSON.stringify(otherTenantCommand) });
  if (deniedOtherTenantCommand.response.status !== 404 || deniedOtherTenantCommand.body.error?.code !== 'RESOURCE_NOT_FOUND' || /harness-tenant-device|Harness tenant light|tenantOwnerMembershipId/.test(JSON.stringify(deniedOtherTenantCommand.body)) || fakePhysicalCommandCount !== physicalBeforeNative + 1) fail('Another tenant command was not hidden and denied before any fake-device effect');
  console.log('[stage2:integration] PASS: selected-home tenant can read and command its own device; wrong-home, owner, manager, and different-tenant private-device read/command denials expose no private device identity and cause zero extra fake-device effects');
  for (const [role, token] of [['owner', customerFixture.propertyToken], ['property-manager', customerFixture.managerToken]]) {
    for (const suffix of ['capabilities', 'support-bundle']) {
      const privateRead = await fetchJson(`${base}/_dinodia/admin/api/devices/${encodeURIComponent('harness-tenant-device')}/${suffix}`, { headers: { authorization: `Bearer ${token}` } });
      const serialized = JSON.stringify(privateRead.body);
      if (privateRead.response.status !== 403 || privateRead.body.errorCode !== 'device_scope_denied' || /Harness tenant light|tenantOwnerMembershipId|harness-tenant-device/.test(serialized)) fail(`${role} read of tenant-private ${suffix} was not denied without device data (${privateRead.response.status}/${privateRead.body.errorCode || 'unknown'})`);
    }
  }
  for (const suffix of ['capabilities', 'support-bundle']) {
    const ownPrivateRead = await fetchJson(`${base}/_dinodia/admin/api/devices/${encodeURIComponent('harness-tenant-device')}/${suffix}`, { headers: { authorization: `Bearer ${customerFixture.tenantToken}` } });
    if (ownPrivateRead.response.status !== 200) fail(`Tenant could not read its own authorized device ${suffix} (${ownPrivateRead.response.status}/${ownPrivateRead.body.errorCode || 'unknown'})`);
  }
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
  const secureSetupPage = await fetchLoopback(`${base}/support-access`, { headers: remoteOsHeaders });
  updateCookieJar(browserA, secureSetupPage);
  const setupAttempt = await fetchJsonLoopback(`${base}/_dinodia/setup/operator-attempt`, {
    method: 'POST',
    headers: { ...remoteOsHeaders, cookie: cookieHeader(browserA), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(browserA, 'dinodia_setup_csrf')) },
  });
  if (setupAttempt.response.status !== 200 || setupAttempt.body.setupAttemptId !== decodeURIComponent(cookieValue(browserA, 'dinodia_operator_attempt'))) fail(`Hub-created operator browser attempt was not registered (${setupAttempt.response.status}/${setupAttempt.body.errorCode || setupAttempt.body.error || 'unknown'})`);
  const identityCheck = await prisma.hubManufacturingIdentity.findFirst({ where: { serialNumber: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration }, select: { status: true, serialNumber: true, identityGeneration: true } });
  if (!identityCheck || identityCheck.status !== 'ACTIVE') fail(`Operator fixture identity is not active before handoff (${JSON.stringify(identityCheck)})`);
  const hubIdentity = hub.store.getIdentity?.() || {};
  if (String(hubIdentity.serial || '') !== customerFixture.identityOneSerial) fail(`Disposable hub serial is not bound to the registered manufacturing serial (${String(hubIdentity.serial || '')}/${customerFixture.identityOneSerial})`);
  const wrongHomeLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeTwoId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: setupAttempt.body.setupAttemptId, accessMode: 'secure' }),
  });
  if (wrongHomeLaunch.response.status !== 403) fail(`Operator work was accepted for a different home (${wrongHomeLaunch.response.status})`);
  const wrongAttemptLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: crypto.randomBytes(32).toString('base64url'), accessMode: 'secure' }),
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
      body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: setupAttempt.body.setupAttemptId, accessMode: 'secure' }),
    });
    if (wrongEmployeeLaunch.response.status !== 403) fail(`A different active employee received an unassigned operator handoff (${wrongEmployeeLaunch.response.status})`);
  } finally {
    await prisma.employeeSession.deleteMany({ where: { employeeId: wrongEmployee.id } }).catch(() => {});
    await prisma.companyEmployeeAccount.delete({ where: { id: wrongEmployee.id } }).catch(() => {});
  }

  const expiredSetup = await fetchLoopback(`${base}/support-access`, { headers: remoteOsHeaders });
  const expiredBrowser = {};
  updateCookieJar(expiredBrowser, expiredSetup);
  const expiredRegistration = await fetchJsonLoopback(`${base}/_dinodia/setup/operator-attempt`, {
    method: 'POST',
    headers: { ...remoteOsHeaders, cookie: cookieHeader(expiredBrowser), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(expiredBrowser, 'dinodia_setup_csrf')) },
  });
  if (expiredRegistration.response.status !== 200 || !expiredRegistration.body.setupAttemptId) fail(`Could not register disposable attempt for expiry denial (${expiredRegistration.response.status})`);
  await prisma.operatorBrowserAttempt.update({ where: { attemptId: expiredRegistration.body.setupAttemptId }, data: { expiresAt: new Date(Date.now() - 1) } });
  const expiredAttemptLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: expiredRegistration.body.setupAttemptId, accessMode: 'secure' }),
  });
  if (expiredAttemptLaunch.response.status !== 403) fail(`An expired hub-created browser attempt received an operator handoff (${expiredAttemptLaunch.response.status})`);
  await prisma.employeeSession.update({ where: { id: customerFixture.operatorSessionId }, data: { recentAuthenticatedAt: new Date(Date.now() - 5 * 60 * 1000 - 1) } });
  // Keep issue times in distinct JWT seconds so this real-session test proves
  // that the OS deadline starts at handoff, not at Portal login.
  await sleep(1100);
  const launch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken },
    body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: setupAttempt.body.setupAttemptId, accessMode: 'secure' }),
  });
  if (launch.response.status !== 200 || !launch.body.handoffId || launch.body.handoffSecret || launch.body.operatorToken || launch.body.sessionGrant) fail(`Company Portal did not issue an opaque operator handoff (${launch.response.status})`);
  const handoffJson = JSON.stringify(launch.body);
  if (/dno1\.|osb_|handoffSecret|secret/i.test(handoffJson)) fail('Company Portal handoff response contained a reusable credential');
  const directPrepare = await machineRequest({ base: platformBase, path: '/api/hub-agent/operator-session/consume', machineSecret: customerFixture.machineSecret, body: { serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, handoffId: launch.body.handoffId, browserBinding: decodeURIComponent(cookieValue(browserA, 'dinodia_operator_binding')), setupAttemptId: setupAttempt.body.setupAttemptId, phase: 'prepare' } });
  if (directPrepare.response.status !== 200 || !directPrepare.body.handoffSecretEnvelope) fail(`Machine-authenticated handoff prepare failed before OS consumption (${directPrepare.response.status}/${directPrepare.body.errorCode || directPrepare.body.error || 'unknown'})`);
  const missingSecretConsume = await machineRequest({ base: platformBase, path: '/api/hub-agent/operator-session/consume', machineSecret: customerFixture.machineSecret, body: { serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, handoffId: launch.body.handoffId, browserBinding: decodeURIComponent(cookieValue(browserA, 'dinodia_operator_binding')), setupAttemptId: setupAttempt.body.setupAttemptId, phase: 'consume' } });
  if (missingSecretConsume.response.status !== 401 || missingSecretConsume.body.errorCode !== 'handoff_secret_required') fail(`A machine handoff was consumed without proof of its one-use secret (${missingSecretConsume.response.status}/${missingSecretConsume.body.errorCode || 'unknown'})`);

  const postHandoffStart = (jar, handoffId, originHeaders = remoteOsHeaders) => fetchJsonLoopback(`${base}/_dinodia/setup/operator-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...originHeaders, cookie: cookieHeader(jar), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(jar, 'dinodia_setup_csrf')) },
    body: JSON.stringify({ action: 'start', handoffId }),
  });
  const pollHandoff = async (jar, originHeaders = remoteOsHeaders, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let result;
    do {
      result = await fetchJsonLoopback(`${base}/_dinodia/setup/operator-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...originHeaders, cookie: cookieHeader(jar), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(jar, 'dinodia_setup_csrf')) },
        body: JSON.stringify({ action: 'status' }),
      });
      if (result.response.status !== 202) return result;
      await sleep(50);
    } while (Date.now() < deadline);
    fail(`OS operator handoff did not reach a terminal state (${result?.body?.handoffPhase || 'pending'})`);
  };
  const setupB = await fetchLoopback(`${base}/support-access`, { headers: remoteOsHeaders });
  const browserB = {};
  updateCookieJar(browserB, setupB);
  const copiedStart = await postHandoffStart(browserB, launch.body.handoffId, remoteOsHeaders);
  if (copiedStart.response.status !== 202 || copiedStart.body.state !== 'pending') fail(`The second browser did not receive an asynchronous, non-authoritative handoff result (${copiedStart.response.status})`);
  const copiedHandoff = await pollHandoff(browserB, remoteOsHeaders);
  if (![401, 403].includes(copiedHandoff.response.status) || copiedHandoff.body.handoffPhase !== 'prepare' || !/^[0-9a-f-]{36}$/i.test(String(copiedHandoff.body.correlationId || ''))) fail(`A second browser's copied handoff was not denied at prepare with safe correlation (${copiedHandoff.response.status}/${copiedHandoff.body.handoffPhase || 'no-phase'})`);

  // Attribute a genuine OS->Platform prepare rejection separately. The
  // browser cookie jar remains otherwise valid, but the setup attempt is
  // deliberately substituted; this must fail before the one-use secret is
  // fetched or consumed and must leave the real handoff usable.
  const prepareFailureJar = { ...browserA, dinodia_operator_attempt: `wrong-${crypto.randomUUID()}` };
  const prepareFailureStart = await postHandoffStart(prepareFailureJar, launch.body.handoffId);
  if (prepareFailureStart.response.status !== 202) fail(`OS did not accept a validly shaped attempt for asynchronous prepare attribution (${prepareFailureStart.response.status})`);
  const prepareFailure = await pollHandoff(prepareFailureJar);
  if (![401, 403].includes(prepareFailure.response.status) || prepareFailure.body.handoffPhase !== 'prepare' || !/^[a-z0-9_]{1,64}$/.test(String(prepareFailure.body.errorCode || ''))) fail(`OS did not safely attribute the rejected attempt to the prepare phase (${prepareFailure.response.status}/${prepareFailure.body.handoffPhase || 'no-phase'}/${prepareFailure.body.errorCode || 'no-code'})`);

  // Reproduce the live CloudURL condition: two sequential machine-authenticated
  // Platform phases take longer than the proxy's observed response window.
  // Duplicate Portal messages must attach to one in-memory job, while the
  // browser-facing start response stays short and status polling later returns
  // the same single-use result.
  const platformCallsBeforeSlowHandoff = operatorHandoffPlatformRequestCount;
  operatorHandoffFetchDelayMs = 2_750;
  let startElapsedMs = 0;
  let handoffElapsedMs = 0;
  let intendedHandoff;
  try {
    const startedAt = Date.now();
    const [firstStart, duplicateStart] = await Promise.all([
      postHandoffStart(browserA, launch.body.handoffId),
      postHandoffStart(browserA, launch.body.handoffId),
    ]);
    startElapsedMs = Date.now() - startedAt;
    if (firstStart.response.status !== 202 || duplicateStart.response.status !== 202 || firstStart.body.correlationId !== duplicateStart.body.correlationId || !/^[0-9a-f-]{36}$/i.test(String(firstStart.body.correlationId || '')) || startElapsedMs >= 1_500) fail(`Slow handoff start was not promptly idempotent across duplicate messages (${firstStart.response.status}/${duplicateStart.response.status}, ${startElapsedMs}ms)`);
    if (/handoffId|handoffSecret|operatorToken|sessionGrant|osb_/.test(JSON.stringify([firstStart.body, duplicateStart.body]))) fail('Pending browser responses contained handoff authority or a reusable credential');
    intendedHandoff = await pollHandoff(browserA);
    handoffElapsedMs = Date.now() - startedAt;
  } finally { operatorHandoffFetchDelayMs = 0; }
  const intendedBody = intendedHandoff.body;
  updateCookieJar(browserA, intendedHandoff.response);
  if (intendedHandoff.response.status !== 200 || intendedBody.ok !== true || intendedBody.state !== 'established') fail(`The originating browser could not complete the asynchronous operator handoff (${intendedHandoff.response.status}/${intendedBody.errorCode || intendedBody.error || 'unknown'})`);
  if (handoffElapsedMs < 5_000 || operatorHandoffPlatformRequestCount - platformCallsBeforeSlowHandoff !== 2) fail(`A handoff slower than the live proxy window did not converge to exactly one prepare and one consume request (${handoffElapsedMs}ms/${operatorHandoffPlatformRequestCount - platformCallsBeforeSlowHandoff} calls)`);
  const intendedSetCookies = typeof intendedHandoff.response.headers.getSetCookie === 'function' ? intendedHandoff.response.headers.getSetCookie().join(';') : String(intendedHandoff.response.headers.get('set-cookie') || '');
  if (!/dinodia_os_operator_session=[^;]+/.test(intendedSetCookies) || !/HttpOnly/i.test(intendedSetCookies)) fail('The originating browser did not receive an HttpOnly OS session cookie');
  const firstDeadline = Date.parse(intendedBody.expiresAt);
  const firstMaxAge = Number(intendedSetCookies.match(/Max-Age=(\d+)/i)?.[1]);
  const firstRemainingMs = firstDeadline - Date.now();
  if (!Number.isFinite(firstDeadline) || !Number.isInteger(firstMaxAge) || firstMaxAge < 86_380 || firstMaxAge > 86_400 || firstRemainingMs > 86_400_000 || firstRemainingMs < 86_380_000 || Math.abs(firstRemainingMs - firstMaxAge * 1000) > 1_500) fail('The OS browser handle/cookie did not share one bounded absolute 24-hour grant deadline');
  if (/dno1\.|operatorToken|handoffSecret|sessionGrant|DINODIA_ADMIN_TOKEN/i.test(JSON.stringify(intendedBody))) fail('Operator handoff response exposed an OS bearer or reusable secret');
  const persistedGrantAuthority = await prisma.operatorHandoff.findUnique({ where: { id: launch.body.handoffId }, select: { scope: true } });
  const authorityScope = persistedGrantAuthority?.scope && typeof persistedGrantAuthority.scope === 'object' ? persistedGrantAuthority.scope : {};
  const durableAuthorityOk = {
    jti: /^[A-Za-z0-9_-]{16,128}$/.test(String(authorityScope.operatorJti || '')),
    credentialVersion: Number.isSafeInteger(Number(authorityScope.credentialVersion)) && Number(authorityScope.credentialVersion) >= 0,
    generation: Number(authorityScope.identityGeneration) === customerFixture.identityOneGeneration,
    serial: authorityScope.serialNumber === customerFixture.identityOneSerial,
  };
  if (Object.values(durableAuthorityOk).some((value) => !value)) fail(`Consumed handoff did not durably bind grant authority (valid-jti=${durableAuthorityOk.jti}, expected-version=${durableAuthorityOk.credentialVersion}, generation-match=${durableAuthorityOk.generation}, certified-serial-match=${durableAuthorityOk.serial})`);
  const currentAuthority = await machineRequest({ base: platformBase, path: '/api/hub-agent/operator-session/revalidate', machineSecret: customerFixture.machineSecret, body: { serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, handoffId: launch.body.handoffId, jti: authorityScope.operatorJti, credentialVersion: authorityScope.credentialVersion } });
  if (currentAuthority.response.status !== 200 || currentAuthority.body.active !== true) fail(`Machine-authenticated operator revalidation rejected the exact consumed grant (${currentAuthority.response.status}/${currentAuthority.body.errorCode || 'unknown'})`);
  const substitutedJti = await machineRequest({ base: platformBase, path: '/api/hub-agent/operator-session/revalidate', machineSecret: customerFixture.machineSecret, body: { serial: customerFixture.identityOneSerial, identityGeneration: customerFixture.identityOneGeneration, handoffId: launch.body.handoffId, jti: `substitute-${crypto.randomUUID()}`, credentialVersion: authorityScope.credentialVersion } });
  if (substitutedJti.response.status !== 401) fail(`Machine operator revalidation accepted a substituted grant JTI (${substitutedJti.response.status})`);
  const intendedOsRead = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { ...remoteOsHeaders, cookie: cookieHeader(browserA) } });
  if (intendedOsRead.response.status !== 200 || !Array.isArray(intendedOsRead.body.devices)) fail(`The intended browser's HttpOnly handoff session did not authorize a real OS devices read (${intendedOsRead.response.status})`);
  const copiedSessionRead = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { ...remoteOsHeaders, cookie: cookieHeader(browserB) } });
  if (copiedSessionRead.response.status !== 401) fail(`A second browser obtained OS access without the originating browser session (${copiedSessionRead.response.status})`);
  const WebSocket = createRequire(import.meta.url)(path.join(osRoot, 'node_modules/ws'));
  const endSessionSocket = new WebSocket(`${base.replace('http', 'ws')}/api/websocket`, { headers: { ...remoteOsHeaders, cookie: cookieHeader(browserA) } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { endSessionSocket.terminate(); reject(new Error('operator WebSocket did not authenticate before End session')); }, 5000);
    endSessionSocket.on('message', (value) => { try { const message = JSON.parse(String(value)); if (message.type === 'auth_required') endSessionSocket.send(JSON.stringify({ type: 'auth', access_token: '' })); if (message.type === 'auth_ok') { clearTimeout(timer); resolve(); } } catch {} });
    endSessionSocket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const replayHandoff = await fetchJson(`${base}/_dinodia/setup/operator-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...remoteOsHeaders, cookie: cookieHeader(browserA), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(browserA, 'dinodia_setup_csrf')) },
    body: JSON.stringify({ handoffId: launch.body.handoffId }),
  });
  if (![400, 401, 403].includes(replayHandoff.response.status)) fail(`The operator handoff replay was accepted (${replayHandoff.response.status})`);

  const endSession = await fetchJsonLoopback(`${base}/_dinodia/operator-session/end`, { method: 'POST', headers: { ...remoteOsHeaders, cookie: cookieHeader(browserA) } });
  if (endSession.response.status !== 200 || endSession.body.ok !== true) fail(`The explicit Dinodia OS End session action did not revoke the active session (${endSession.response.status})`);
  const endedSocketCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { endSessionSocket.terminate(); reject(new Error('End session left the operator WebSocket active')); }, 2000);
    endSessionSocket.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  if (endedSocketCode !== 4401) fail(`End session closed the operator WebSocket with an unexpected code (${endedSocketCode})`);
  updateCookieJar(browserA, endSession.response);
  const afterEndSession = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { ...remoteOsHeaders, cookie: cookieHeader(browserA) } });
  if (afterEndSession.response.status !== 401) fail(`Protected OS read remained available after End session (${afterEndSession.response.status})`);

  // Exercise the same machine-created browser authority over the fresh local
  // BaseURL, even though the disposable OS listener is reached through a
  // loopback socket. The Host/Origin are the private endpoint recorded by the
  // signed heartbeat; no production route accepts loopback as a LAN report.
  const localSetupPage = await fetchLoopback(`${base}/support-access`, { headers: localOsHeaders });
  const localBrowser = {};
  updateCookieJar(localBrowser, localSetupPage);
  const localAttempt = await fetchJsonLoopback(`${base}/_dinodia/setup/operator-attempt`, { method: 'POST', headers: { ...localOsHeaders, cookie: cookieHeader(localBrowser), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(localBrowser, 'dinodia_setup_csrf')) } });
  if (localAttempt.response.status !== 200 || !localAttempt.body.setupAttemptId) fail(`Fresh local endpoint could not register a bound browser attempt (${localAttempt.response.status}/${localAttempt.body.errorCode || 'unknown'})`);
  const localLaunch = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken }, body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: localAttempt.body.setupAttemptId, accessMode: 'local' }) });
  if (localLaunch.response.status !== 200 || localLaunch.body.accessMode !== 'local' || new URL(localLaunch.body.operatorUrl).origin !== `http://${localHost}`) fail(`Portal did not issue the local handoff on the exact current BaseURL (${localLaunch.response.status})`);
  const localStart = await postHandoffStart(localBrowser, localLaunch.body.handoffId, localOsHeaders);
  if (localStart.response.status !== 202) fail(`Fresh local-origin handoff was not accepted (${localStart.response.status})`);
  const localHandoff = await pollHandoff(localBrowser, localOsHeaders);
  updateCookieJar(localBrowser, localHandoff.response);
  if (localHandoff.response.status !== 200 || localHandoff.body.state !== 'established') fail(`Fresh local-origin operator handoff did not establish (${localHandoff.response.status}/${localHandoff.body.errorCode || 'unknown'})`);
  const localProtectedRead = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { ...localOsHeaders, cookie: cookieHeader(localBrowser) } });
  if (localProtectedRead.response.status !== 200) fail(`Fresh BaseURL handoff did not authorize a protected OS read (${localProtectedRead.response.status})`);
  const localEnd = await fetchJsonLoopback(`${base}/_dinodia/operator-session/end`, { method: 'POST', headers: { ...localOsHeaders, cookie: cookieHeader(localBrowser) } });
  const localAfterEnd = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { ...localOsHeaders, cookie: cookieHeader(localBrowser) } });
  if (localEnd.response.status !== 200 || localAfterEnd.response.status !== 401) fail('Local BaseURL session did not revoke before expiry');
  simulatedLanAddress = '';
  await hub.pairing.requestImmediateHeartbeat();
  const unavailableEndpoint = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointState: true } });
  if (unavailableEndpoint.lanEndpointState !== 'UNAVAILABLE' || unavailableEndpoint.baseUrl !== 'http://192.168.0.112:8123') fail('An unavailable signed LAN observation erased history or remained advertised as current');
  const endpointWorkflowList = await fetchJson(`${platformBase}/api/installer/workflows`, { headers: { 'x-dinodia-employee-session': customerFixture.operatorToken } });
  const endpointWorkflow = endpointWorkflowList.body.workflows?.find((item) => item.id === customerFixture.operatorWorkId);
  if (endpointWorkflowList.response.status !== 200 || endpointWorkflow?.hubInstallation?.localUrl !== null || endpointWorkflow?.hubInstallation?.localState !== 'STALE' || endpointWorkflow?.hubInstallation?.secureVerified !== true) fail('Portal exposed an unavailable historic BaseURL or lost its independent verified CloudURL state');
  simulatedLanAddress = '192.168.0.112';
  await hub.pairing.requestImmediateHeartbeat();
  const recoveredEndpoint = await prisma.hubInstallation.findUniqueOrThrow({ where: { id: customerFixture.hubOneId }, select: { baseUrl: true, lanEndpointRevision: true, lanEndpointState: true } });
  if (recoveredEndpoint.lanEndpointState !== 'CURRENT' || recoveredEndpoint.lanEndpointRevision !== unavailableEndpoint.lanEndpointRevision + 1 || recoveredEndpoint.baseUrl !== 'http://192.168.0.112:8123') fail('Signed LAN endpoint did not recover with a new revision after interface availability returned');
  console.log('[stage1:integration] PASS: secure CloudURL and fresh LAN BaseURL each bind an originating browser, authorize protected reads, and support explicit session end');

  // Establish a second legitimate handoff in the independent browser so the
  // absolute-deadline test exercises a live server-held session after the
  // first browser has explicitly ended its session.
  const setupC = await fetchLoopback(`${base}/support-access`, { headers: remoteOsHeaders });
  const browserC = {};
  updateCookieJar(browserC, setupC);
  const attemptB = await fetchJsonLoopback(`${base}/_dinodia/setup/operator-attempt`, { method: 'POST', headers: { ...remoteOsHeaders, cookie: cookieHeader(browserC), 'x-dinodia-setup-csrf': decodeURIComponent(cookieValue(browserC, 'dinodia_setup_csrf')) } });
  if (attemptB.response.status !== 200 || !attemptB.body.setupAttemptId) fail(`Independent secure-origin browser could not create its own hub attempt (${attemptB.response.status}/${attemptB.body.error || attemptB.body.errorCode || 'unknown'}; browser=${Boolean(browserC.dinodia_setup_browser)}, csrf=${Boolean(browserC.dinodia_setup_csrf)}, binding=${Boolean(browserC.dinodia_operator_binding)}, attempt=${Boolean(browserC.dinodia_operator_attempt)})`);
  const launchB = await fetchJson(`${platformBase}/api/installer/home-support/homes/${encodeURIComponent(customerFixture.homeOneId)}/os-access/launch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dinodia-employee-session': customerFixture.operatorToken }, body: JSON.stringify({ workflowId: customerFixture.operatorWorkId, setupAttemptId: attemptB.body.setupAttemptId, accessMode: 'secure' }) });
  if (launchB.response.status !== 200 || !launchB.body.handoffId) fail(`A valid fresh handoff could not be issued for the independent browser (${launchB.response.status})`);
  operatorHandoffFetchDelayMs = 250;
  const platformCallsBeforeDuplicateB = operatorHandoffPlatformRequestCount;
  let consumeB;
  try {
    const duplicateStartsB = await Promise.all([0, 1].map(() => postHandoffStart(browserC, launchB.body.handoffId, remoteOsHeaders)));
    if (duplicateStartsB.some((entry) => entry.response.status !== 202 || entry.body.correlationId !== duplicateStartsB[0].body.correlationId)) fail('Concurrent duplicate Portal messages did not attach to the same secure-origin handoff job');
    consumeB = await pollHandoff(browserC, remoteOsHeaders);
  } finally { operatorHandoffFetchDelayMs = 0; }
  const consumeBBody = consumeB.body;
  updateCookieJar(browserC, consumeB.response);
  if (consumeB.response.status !== 200 || consumeBBody.ok !== true || consumeBBody.state !== 'established' || operatorHandoffPlatformRequestCount - platformCallsBeforeDuplicateB !== 2) fail(`The independent browser's duplicate handoff did not converge to exactly one prepare/consume pair and one OS session (${consumeB.response.status}/${operatorHandoffPlatformRequestCount - platformCallsBeforeDuplicateB})`);
  const secondDeadline = Date.parse(consumeBBody.expiresAt);
  if (!Number.isFinite(secondDeadline) || secondDeadline - Date.now() > 86_400_000 || secondDeadline - Date.now() < 86_390_000) fail('The second OS grant does not carry a single absolute 24-hour deadline');
  const remoteSetCookies = typeof consumeB.response.headers.getSetCookie === 'function' ? consumeB.response.headers.getSetCookie().join(';') : String(consumeB.response.headers.get('set-cookie') || '');
  if (!/dinodia_os_operator_session=[^;]+/.test(remoteSetCookies) || !/HttpOnly/i.test(remoteSetCookies) || !/Secure/i.test(remoteSetCookies) || !/SameSite=Strict/i.test(remoteSetCookies)) fail('Secure CloudURL handoff did not issue an HttpOnly/Secure/SameSite OS cookie');
  const secondRead = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { host: remoteHost, 'x-forwarded-proto': 'https', cookie: cookieHeader(browserC) } });
  if (secondRead.response.status !== 200) fail(`The second browser's own fresh handoff did not authorize a protected OS read (${secondRead.response.status})`);
  // The two absolute deadlines are independent: advance Platform past the
  // real Portal token/database deadline while the later-issued OS grant is
  // still live. Portal must deny while the already-established OS read works.
  const portalSession = await prisma.employeeSession.findUnique({ where: { id: customerFixture.operatorSessionId }, select: { expiresAt: true } });
  const portalDeadline = portalSession?.expiresAt.getTime() ?? 0;
  if (!(portalDeadline > Date.now() && portalDeadline < secondDeadline)) fail(`The fixture did not create independent Portal and later OS deadlines (portalRemaining=${portalDeadline - Date.now()}ms, osRemaining=${secondDeadline - Date.now()}ms)`);
  osHarnessNow = portalDeadline + 1;
  await stopPlatform();
  await startPlatform({ ...env, STAGE1_TEST_NOW_MS: String(portalDeadline + 1) });
  const expiredPortal = await fetchJson(`${platformBase}/api/company/auth/session`, { headers: { 'x-dinodia-employee-session': customerFixture.operatorToken } });
  if (expiredPortal.response.status !== 401) fail(`Portal login remained valid after its own 24-hour absolute deadline (${expiredPortal.response.status})`);
  await hub.syncOperatorBrowserSessions();
  const afterPortalExpiryRead = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { host: remoteHost, 'x-forwarded-proto': 'https', cookie: cookieHeader(browserC) } });
  if (afterPortalExpiryRead.response.status !== 200) fail(`Natural Portal expiry incorrectly ended the independent OS operator grant (${afterPortalExpiryRead.response.status})`);

  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/websocket`, { headers: { host: remoteHost, origin: `https://${remoteHost}`, 'x-forwarded-proto': 'https', cookie: cookieHeader(browserC) } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('valid operator WebSocket did not authenticate')); }, 5000);
    socket.on('message', (value) => { try { const message = JSON.parse(String(value)); if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: '' })); if (message.type === 'auth_ok') { clearTimeout(timer); resolve(); } } catch {} });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
  socket.send(JSON.stringify({ id: 41, type: 'get_states' }));
  const initialWsRead = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('authenticated operator WebSocket did not return its protected read')), 5000);
    socket.on('message', (value) => { try { const message = JSON.parse(String(value)); if (message.id === 41) { clearTimeout(timer); resolve(message); } } catch {} });
    socket.once('error', reject);
  });
  if (initialWsRead?.success !== true) fail('Intended-browser WebSocket could not perform a protected read before session expiry');
  osHarnessNow = secondDeadline - 1;
  await hub.syncOperatorBrowserSessions();
  const beforeOsExpiry = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { host: remoteHost, 'x-forwarded-proto': 'https', cookie: cookieHeader(browserC) } });
  if (beforeOsExpiry.response.status !== 200) fail(`OS protected HTTP read was denied immediately before 24-hour expiry (${beforeOsExpiry.response.status})`);
  osHarnessNow = secondDeadline;
  socket.send(JSON.stringify({ id: 42, type: 'get_states' }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operator WebSocket remained open at the exact 24-hour expiry')), 2000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
  const atOsExpiry = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { host: remoteHost, 'x-forwarded-proto': 'https', cookie: cookieHeader(browserC) } });
  osHarnessNow = secondDeadline + 1;
  const afterOsExpiry = await fetchJsonLoopback(`${base}/_dinodia/admin/api/devices`, { headers: { host: remoteHost, 'x-forwarded-proto': 'https', cookie: cookieHeader(browserC) } });
  if (atOsExpiry.response.status !== 401 || afterOsExpiry.response.status !== 401) fail(`OS protected HTTP authority did not end exactly at 24 hours (${atOsExpiry.response.status}/${afterOsExpiry.response.status})`);
  console.log('[stage1:integration] PASS: real consumed grant is durably JTI-bound; Portal and OS deadlines remain independent; intended and independently handed-off browsers read protected OS data; End session revokes HTTP and closes its WebSocket; HTTP and WebSocket authority stop at the exact 24-hour deadline without exposing bearer material');
  osHarnessNow = Date.now();
  await stopPlatform();
  await startPlatform(env);

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
    if (customerFixture.otherTenantSessionId) await prisma.customerSession.deleteMany({ where: { id: customerFixture.otherTenantSessionId } }).catch(() => {});
    if (customerFixture.otherTenantTrustedId) await prisma.trustedDevice.deleteMany({ where: { id: customerFixture.otherTenantTrustedId } }).catch(() => {});
    await prisma.homeMembership.deleteMany({ where: { id: customerFixture.managerMembershipId } }).catch(() => {});
    if (customerFixture.otherTenantMembershipId) await prisma.homeMembership.deleteMany({ where: { id: customerFixture.otherTenantMembershipId } }).catch(() => {});
    await prisma.tenantAreaGrant.deleteMany({ where: { membershipId: { in: [customerFixture.tenantMembershipId, customerFixture.ownerMembershipId] } } }).catch(() => {});
    await prisma.homeMembership.deleteMany({ where: { id: { in: [customerFixture.tenantMembershipId, customerFixture.ownerMembershipId] } } }).catch(() => {});
    await prisma.area.deleteMany({ where: { id: { in: [customerFixture.areaOneId, customerFixture.areaTwoId] } } }).catch(() => {});
    await prisma.hubInstallation.deleteMany({ where: { id: { in: [customerFixture.hubOneId, customerFixture.hubTwoId] } } }).catch(() => {});
    await prisma.hubManufacturingIdentity.deleteMany({ where: { id: { in: [customerFixture.identityOneId, customerFixture.identityTwoId] } } }).catch(() => {});
    await prisma.home.deleteMany({ where: { id: { in: [customerFixture.homeOneId, customerFixture.homeTwoId] } } }).catch(() => {});
    await prisma.customerAccount.deleteMany({ where: { id: customerFixture.accountId } }).catch(() => {});
    await prisma.customerAccount.deleteMany({ where: { id: customerFixture.propertyAccountId } }).catch(() => {});
    await prisma.customerAccount.deleteMany({ where: { id: customerFixture.managerAccountId } }).catch(() => {});
    if (customerFixture.otherTenantAccountId) await prisma.customerAccount.deleteMany({ where: { id: customerFixture.otherTenantAccountId } }).catch(() => {});
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
    config: { nodeEnv: 'production', v2Environment: 'test', stage1InternalOperatorDaySession: true, operatorPolicySyncIntervalMs: 60000, hubId: harnessHubInstallationId, haPort: 0, hubAgentPort: 0, dataDir, dataFile: path.join(dataDir, 'dinodia.json'), backupDir: path.join(dataDir, 'backups'), staticDir: path.join(osRoot, 'public'), operatorPublicKey, appPublicKeys: env.DINODIA_APP_PUBLIC_KEYS, platformApiUrl: 'https://dinodia-platform-v2.vercel.app', nativeAutomationsMode: 'off', hiveEnabled: false, googleNestEnabled: false, cloudflarePublicHostname: harnessCloudHostname },
    identityBroker: harnessIdentityBroker,
    logger: { error() {}, warn() {}, log() {} },
    clock: () => osHarnessNow,
    mqttBridge: { start() {}, close() {}, status() { return { configured: false, connected: false }; }, async command() { fakePhysicalCommandCount += 1; } },
    platformSync: { start() {}, stop() {}, status() { return { configured: false }; } },
    cloudflareTunnel: { start() {}, async stop() {}, status() { return { configured: false, connected: false, hostname: '' }; } },
  });
  hub.pairing.apiUrl = `http://127.0.0.1:${appPort}`;
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  await platformChecks();
  await employeeSessionPolicyChecks(env);
  await stopPlatform();
  await startFakeSes();
  const sesEndpoint = `http://127.0.0.1:${sesPort}`;
  assertLoopbackTestEndpoint(sesEndpoint);
  const deliveryEnv = { ...env, V2_ENVIRONMENT: 'test', COMPANY_PORTAL_INITIAL_CXO_EMAIL: 'niveditgupta@dinodiasmartliving.com', AWS_REGION: 'eu-north-1', SES_FROM_EMAIL: 'no-reply@dinodiasmartliving.com', AWS_ACCESS_KEY_ID: 'stage1-test-access-key', AWS_SECRET_ACCESS_KEY: 'stage1-test-secret', SES_TEST_ENDPOINT: sesEndpoint };
  await startPlatform(deliveryEnv);
  await bootstrapDeliveryChecks(deliveryEnv);
  await customerAuthorizationChecks(deliveryEnv);
  await osChecks();
  await operatorMutationChecks();
  const childTargets = verifyChildOutboundTargets();
  console.log(`[stage1:integration] PASS: live Platform routes, locked Dinodia OS HTTP, browser isolation, authenticated native WebSocket command authorization and denial exercised against disposable PostgreSQL; parent=${[...outboundTargets].sort().join(',')}; children=${childTargets.join(',')}`);
} finally {
  await cleanup();
}

function pathToFileURL(file) { return new URL(`file://${file.split(path.sep).map(encodeURIComponent).join('/')}`); }
