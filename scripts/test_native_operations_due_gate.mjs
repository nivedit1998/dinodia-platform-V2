// One disposable postgres:16-alpine, sequential checks, no .env reads, no external
// targets. cron/Vault/net are LOCAL STUBS. JS drains net's SQL queue asynchronously
// to a loopback HTTP recorder. This does NOT test real extension daemons.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { nativeOperationsDueGateFixture } from './native_operations_due_gate_fixture.mjs';
import { verifyNativeOperationsDueGateContract } from './native_operations_due_gate_contract.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--log-dir')) throw new Error('Usage: node scripts/test_native_operations_due_gate.mjs [--log-dir PATH]');
const logDir = args[1];
if (logDir) mkdirSync(logDir, { recursive: true });
const report = (message) => { console.log(message); if (logDir) appendFileSync(`${logDir}/sql-http.log`, `${message}\n`); };
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
const name = `dinodia-stage4-due-${process.pid}`;
// Pin the local daemon, independent of any operator's configured remote context.
const dockerHost = `unix://${process.platform === 'darwin' ? `${env.HOME}/.docker/run/docker.sock` : '/var/run/docker.sock'}`;
const password = randomBytes(24).toString('hex');
const migration = readFileSync('prisma/migrations/20261103010000_native_operations_due_gate/migration.sql', 'utf8');
const recovery = readFileSync('scripts/recover_native_operations_due_gate.sql', 'utf8');
const baseline = readFileSync('scripts/native_operations_due_gate_baseline.sql', 'utf8').trim().replace(/;$/, '');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
let started = false, server, checks = 0;
function docker(args, input, allowFailure = false) {
  const result = spawnSync('docker', ['--host', dockerHost, ...args], { env, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    // Never print SQL/URL/headers or inherited environment. Only synthetic test data exists here.
    const detail = (result.stderr || result.error?.message || '').replaceAll(password, '[redacted]').slice(0, 2000);
    throw new Error(`Disposable Docker command failed: ${detail}`);
  }
  return result;
}
function sql(statement, allowFailure = false) {
  const result = docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stage4'], statement, allowFailure);
  return allowFailure ? result : result.stdout.trim();
}
function check(label, actual, expected) { assert.equal(actual, expected, label); checks += 1; report(`PASS ${label}`); }
const tables = ['HubCredentialVersion', 'SupportSession', 'SupportAccessRequest', 'HomeClaimReservation', 'AlexaNativeLink', 'NativeDomainOutbox', 'NativeNotificationDeliveryReceipt'];
function clear() { sql(`TRUNCATE ${tables.map((table) => `public."${table}"`).join(',')};`); }
const gate = (at = '2026-11-03T12:00:00Z', prefix = '') => sql(`${prefix} SELECT public.native_operations_work_due(${quote(at)}::timestamptz);`);
function scenario(label, setup, expected, at, prefix) {
  clear(); if (setup) sql(setup); check(label, gate(at, prefix), expected ? 't' : 'f');
}
const insert = (table, fields) => `INSERT INTO public."${table}" (${Object.keys(fields).map((field) => `"${field}"`).join(',')}) VALUES (${Object.values(fields).map((value) => value === null ? 'NULL' : quote(value)).join(',')});`;
const outbox = (aggregateType, eventType, extra = {}) => insert('NativeDomainOutbox', { aggregateType, eventType, state: 'PENDING', ...extra });
const receipt = (extra = {}) => insert('NativeNotificationDeliveryReceipt', { family: 'OWNER_INSTALLATION_UPDATE', channel: 'EMAIL', status: 'PENDING', ...extra });
const now = '2026-11-03T12:00:00', future = '2026-11-03T12:00:00.001', past = '2026-11-03T11:59:59.999';
const expectedTasks = ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'];
function resetTasks() {
  sql('TRUNCATE public."NativeBackgroundTaskState";');
  for (const taskId of expectedTasks) sql(insert('NativeBackgroundTaskState', { taskId, dispatcher: 'OPERATIONS' }));
}
const received = [];
async function drain() {
  const rows = sql(`WITH drained AS (DELETE FROM net.stub_queue RETURNING *) SELECT row_to_json(drained) FROM drained;`);
  if (!rows) return;
  for (const line of rows.split('\n')) {
    const row = JSON.parse(line);
    // Stub worker is deliberately restricted to the recorder chosen below.
    assert.equal(row.url, recorderUrl);
    assert.deepEqual(row.headers, { 'content-type': 'application/json', authorization: 'Bearer synthetic-stage4-only' });
    assert.deepEqual(row.body, {}); assert.equal(row.timeout_milliseconds, 8000);
    const response = await fetch(row.url, { method: 'POST', headers: row.headers, body: JSON.stringify(row.body), signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 202);
  }
}
let recorderUrl;
try {
  verifyNativeOperationsDueGateContract();
  const start = spawnSync('docker', ['--host', dockerHost, 'run', '--pull=never', '-d', '--name', name, '--memory=256m', '--cpus=1', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=stage4_test_admin', '-e', 'POSTGRES_DB=stage4', 'postgres:16-alpine'],
    { env: { ...env, POSTGRES_PASSWORD: password }, encoding: 'utf8', timeout: 30_000 });
  if (start.status !== 0) throw new Error(`Disposable PostgreSQL unavailable: ${(start.stderr || '').replaceAll(password, '[redacted]').slice(0, 1000)}`);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (docker(['exec', name, 'psql', '-X', '-qAt', '-U', 'stage4_test_admin', '-d', 'stage4', '-c', 'SELECT 1'], undefined, true).stdout?.trim() === '1') { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'bounded PostgreSQL readiness');
  docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'stage4_test_admin', '-d', 'stage4'], 'CREATE ROLE postgres LOGIN SUPERUSER; ALTER DATABASE stage4 OWNER TO postgres;');
  sql(nativeOperationsDueGateFixture(readFileSync('prisma/schema.prisma', 'utf8')));
  sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  resetTasks();
  // Plain Postgres first: no cron/Vault/net schemas exist, functions still create.
  sql(migration);
  check('ordinary Postgres creates gate without installing extensions', gate(), 'f');
  check('no extensions installed by fixture or migration', sql("SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'"), '0');
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    received.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(202); response.end('{}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  recorderUrl = `http://127.0.0.1:${server.address().port}/native-operations`;
  sql(`CREATE SCHEMA cron; CREATE SCHEMA net; CREATE SCHEMA vault;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, username text, database text, active boolean);
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL, database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
RETURNS void LANGUAGE sql AS 'UPDATE cron.job SET command = COALESCE($3, command) WHERE jobid = $1';
CREATE TABLE net.stub_queue (url text, headers jsonb, body jsonb, timeout_milliseconds integer);
CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) RETURNS bigint LANGUAGE plpgsql AS $stub$
BEGIN INSERT INTO net.stub_queue VALUES (url, headers, body, timeout_milliseconds); RETURN 1; END $stub$;
CREATE TABLE vault.stub_reads (name text);
CREATE TABLE vault.stub_secrets (name text, value text);
CREATE FUNCTION vault.read_secret(secret_name text, secret_value text) RETURNS text LANGUAGE plpgsql VOLATILE AS $stub$
BEGIN INSERT INTO vault.stub_reads VALUES (secret_name); RETURN secret_value; END $stub$;
CREATE VIEW vault.decrypted_secrets AS SELECT name, vault.read_secret(name, value) AS decrypted_secret FROM vault.stub_secrets;
INSERT INTO vault.stub_secrets VALUES ('DINODIA_NATIVE_OPERATIONS_URL', ${quote(recorderUrl)}), ('DINODIA_NATIVE_OPERATIONS_CRON_SECRET', 'synthetic-stage4-only');
INSERT INTO cron.job VALUES (41, 'dinodia-native-operations', '*/2 * * * *', ${quote(baseline)}, 'postgres', 'stage4', false);`);
  // Execute the REAL baseline cron SQL before activating candidate, proving it sends when idle.
  sql(sql("SELECT command FROM cron.job WHERE jobid = 41"));
  check('baseline unconditional command enqueues while idle', sql('SELECT count(*) FROM net.stub_queue'), '1');
  await drain(); check('baseline reaches actual loopback HTTP recorder', received.length, 1);
  sql('TRUNCATE vault.stub_reads;');
  sql(migration); sql(migration);
  check('repeated migration preserves SAME cron job ID, schedule and inactive state', sql("SELECT jobid || '|' || schedule || '|' || active FROM cron.job"), '41|*/2 * * * *|false');
  const candidate = sql('SELECT command FROM cron.job WHERE jobid=41');
  sql(candidate); await drain();
  check('candidate idle tick skips HTTP', received.length, 1);
  check('candidate idle tick never reads Vault', sql('SELECT count(*) FROM vault.stub_reads'), '0');

  scenario('empty queues idle', '', false);
  scenario('future nextDueAt does not hide new support work', insert('SupportSession', { status: 'ACTIVE', expiresAt: now }) + `UPDATE public."NativeBackgroundTaskState" SET "nextDueAt"='2099-01-01';`, true);
  sql('UPDATE public."NativeBackgroundTaskState" SET "nextDueAt"=NULL;');
  for (const [time, due] of [[future, false], [now, true], [past, true]]) {
    scenario(`support session expiry ${time}`, insert('SupportSession', { status: 'ACTIVE', expiresAt: time }), due);
    scenario(`claim inclusive expiry ${time}`, insert('HomeClaimReservation', { state: 'ACTIVE', expiresAt: time }), due);
    for (const status of ['REQUESTED', 'APPROVED', 'ISSUED']) scenario(`support request ${status} ${time}`, insert('SupportAccessRequest', { status, codeExpiresAt: time }), due);
    scenario(`GRACE inclusive expiry ${time}`, insert('HubCredentialVersion', { state: 'GRACE', graceUntil: time }), due);
  }
  scenario('ended support does not dispatch', insert('SupportSession', { status: 'ENDED', expiresAt: now }), false);
  scenario('null support code expiry idle', insert('SupportAccessRequest', { status: 'ISSUED', codeExpiresAt: null }), false);
  scenario('rotation one millisecond before hourly boundary', insert('HubCredentialVersion', { state: 'ACTIVE', issuedAt: '2026-11-03T11:00:00.001' }), false);
  scenario('rotation at hourly boundary', insert('HubCredentialVersion', { state: 'ACTIVE', issuedAt: '2026-11-03T11:00:00' }), true);
  for (const state of ['PENDING', 'DELIVERED', 'ACKNOWLEDGED']) scenario(`rotation blocked by ${state} sibling`, insert('HubCredentialVersion', { state: 'ACTIVE', issuedAt: '2026-11-03T11:00:00' }) + insert('HubCredentialVersion', { state }), false);
  scenario('different hub sibling does not block rotation', insert('HubCredentialVersion', { state: 'ACTIVE', issuedAt: '2026-11-03T11:00:00' }) + insert('HubCredentialVersion', { state: 'PENDING', hubInstallationId: '22222222-2222-4222-8222-222222222222' }), true);
  scenario('different purpose sibling does not block rotation', insert('HubCredentialVersion', { state: 'ACTIVE', issuedAt: '2026-11-03T11:00:00' }) + insert('HubCredentialVersion', { state: 'PENDING', purpose: 'other' }), true);
  scenario('authentication expiry is not credential lifecycle due', insert('HubCredentialVersion', { state: 'ACTIVE', purpose: 'other', issuedAt: past }), false);
  scenario('GRACE without deadline idle', insert('HubCredentialVersion', { state: 'GRACE', graceUntil: null }), false);
  scenario('UTC comparison independent of session time zone', insert('SupportSession', { status: 'ACTIVE', expiresAt: now }), true, '2026-11-03T07:00:00-05:00', "SET TIME ZONE 'America/New_York';");
  scenario('future UTC comparison independent of session time zone', insert('SupportSession', { status: 'ACTIVE', expiresAt: future }), false, '2026-11-03T07:00:00-05:00', "SET TIME ZONE 'Pacific/Auckland';");
  for (const [extra, due, label] of [[{ autoScope: true }, true, 'active auto-scope'], [{ autoScope: false }, false, 'manual scope'], [{ autoScope: true, revokedAt: now }, false, 'revoked auto-scope']]) {
    scenario(`Alexa ${label}`, insert('AlexaNativeLink', { status: 'ACTIVE', ...extra }), due);
  }
  for (const eventType of ['INSTALLATION_REQUEST_EMAIL', 'INSTALLATION_REQUEST_COMPLETED']) {
    for (const [extra, due, label] of [[{}, true, 'due'], [{ nextAttemptAt: future }, false, 'future retry'], [{ expiresAt: now }, false, 'expired pending ignored'], [{ attempts: 12 }, false, 'exhausted pending ignored']]) {
      scenario(`installation ${eventType} ${label}`, outbox('PermanentDeviceInstallationRequest', eventType, extra), due);
    }
  }
  const notices = ['TENANT_ACCESS_REMOVAL_NOTICE', 'PROPERTY_MANAGER_ACCESS_REMOVAL_NOTICE', 'OWNERSHIP_TRANSFER_NOTICE', 'HOME_DEREGISTRATION_NOTICE', 'ROOM_ACCESS_REQUEST_NOTICE', 'ROOM_ACCESS_APPROVED_NOTICE', 'ROOM_ACCESS_DECLINED_NOTICE', 'ALEXA_LINKED_NOTICE', 'NEW_DEVICES_NOTICE', 'MFA_ENABLED_NOTICE', 'MFA_DISABLED_NOTICE', 'MEMBERSHIP_INVITATION_ACCEPTED_NOTICE', 'MEMBERSHIP_INVITATION_DECLINED_NOTICE'];
  for (const eventType of notices) {
    scenario(`access/account notice ${eventType}`, outbox('HomeownerAccessRemovalNotice', eventType), true);
    scenario(`access/account notice future ${eventType}`, outbox('HomeownerAccessRemovalNotice', eventType, { nextAttemptAt: future }), false);
    scenario(`access/account expiry ignores retry/exhaustion ${eventType}`, outbox('HomeownerAccessRemovalNotice', eventType, { nextAttemptAt: future, attempts: 8, expiresAt: now }), true);
  }
  scenario('retired access notice unconditionally suppressed', outbox('HomeownerAccessRemovalNotice', 'TENANT_AUTOMATION_MANAGEMENT_NOTICE', { nextAttemptAt: future, attempts: 100 }), true);
  for (const [aggregateType, eventType] of [['FullHomeDeregistrationAccountCleanup', 'FULL_HOME_ACCOUNT_CLEANUP'], ['AlexaAccountRemoval', 'ALEXA_ACCOUNT_REMOVAL_REPORT'], ['AlexaChangeReport', 'ALEXA_CHANGE_REPORT']]) {
    scenario(`${aggregateType} due`, outbox(aggregateType, eventType), true);
    scenario(`${aggregateType} future retry`, outbox(aggregateType, eventType, { nextAttemptAt: future }), false);
    scenario(`${aggregateType} expired future retry`, outbox(aggregateType, eventType, { expiresAt: now, nextAttemptAt: future }), aggregateType !== 'AlexaChangeReport');
    scenario(`${aggregateType} exhausted`, outbox(aggregateType, eventType, { attempts: 8 }), true);
  }
  scenario('full-home cleanup exhaustion overrides future retry', outbox('FullHomeDeregistrationAccountCleanup', 'FULL_HOME_ACCOUNT_CLEANUP', { attempts: 8, nextAttemptAt: future }), true);
  for (const aggregateType of ['PermanentDeviceInstallationRequest', 'HomeownerAccessRemovalNotice', 'FullHomeDeregistrationAccountCleanup', 'AlexaChangeReport', 'AlexaAccountRemoval', 'Unknown']) {
    scenario(`PROCESSING conservatively dispatches ${aggregateType}`, outbox(aggregateType, 'UNKNOWN', { state: 'PROCESSING', nextAttemptAt: future, updatedAt: now, attempts: 100, expiresAt: past }), true);
  }
  const passive = [['HomeClaimReference', 'installation_complete'], ['NativeDevice', 'PROPERTY_DEVICE_COMMISSIONED'], ['NativeDevice', 'PROPERTY_DEVICE_ADOPTED']];
  for (const [aggregateType, eventType] of passive) scenario(`known passive ${eventType}`, outbox(aggregateType, eventType), false);
  scenario('unknown aggregate fails open', outbox('Unknown', 'FUTURE'), true);
  scenario('unknown event in known aggregate fails open', outbox('HomeownerAccessRemovalNotice', 'FUTURE'), true);
  scenario('unknown NativeDevice event fails open', outbox('NativeDevice', 'TENANT_DEVICE_COMMISSIONED'), true);
  for (const channel of ['EMAIL', 'PUSH']) {
    for (const [extra, due, label] of [[{}, true, 'due'], [{ deliverAfter: future }, false, 'future retry'], [{ expiresAt: now }, false, 'expired'], [{ attemptCount: 8 }, false, 'exhausted']]) {
      scenario(`installation receipt ${channel} ${label}`, receipt({ channel, ...extra }), due);
    }
  }
  scenario('retired automation PUSH suppression ignores delivery time/expiry/exhaustion', receipt({ family: 'TENANT_AUTOMATION_FAILURE', channel: 'PUSH', deliverAfter: future, expiresAt: past, attemptCount: 100 }), true);
  scenario('unknown receipt family fails open even before delivery', receipt({ family: 'OWNER_HUB_AVAILABILITY', deliverAfter: future }), true);
  scenario('unknown receipt idempotency class fails open', receipt({ idempotencyKey: 'future-format' }), true);
  scenario('terminal receipt ignored', receipt({ status: 'SENT' }), false);
  scenario('terminal outbox ignored', outbox('Unknown', 'FUTURE', { state: 'DELIVERED' }), false);
  clear();
  for (const [label, setup] of [
    ['missing registry row', `DELETE FROM public."NativeBackgroundTaskState" WHERE "taskId"='claim_reservation_expiry'`],
    ['extra operations task', insert('NativeBackgroundTaskState', { taskId: 'new_task', dispatcher: 'OPERATIONS' })],
    ['misowned task', `UPDATE public."NativeBackgroundTaskState" SET "dispatcher"='MAINTENANCE' WHERE "taskId"='claim_reservation_expiry'`],
    ['prior failure counter', 'UPDATE public."NativeBackgroundTaskState" SET "consecutiveFailures"=1'],
    ['prior FAILED outcome', `UPDATE public."NativeBackgroundTaskState" SET "lastOutcome"='{"status":"FAILED"}'`],
    ['unknown outcome', `UPDATE public."NativeBackgroundTaskState" SET "lastOutcome"='{}'`],
  ]) { resetTasks(); sql(setup); check(label, gate(), 't'); }
  resetTasks();
  scenario('daily maintenance registry rows stay outside operations registry', insert('NativeBackgroundTaskState', { taskId: 'retentionCleanup', dispatcher: 'MAINTENANCE' }), false);
  sql(`DELETE FROM public."NativeBackgroundTaskState" WHERE "dispatcher"='MAINTENANCE';`);
  scenario('active endpoint lease does not suppress due gate', insert('SupportSession', { status: 'ACTIVE', expiresAt: now }) + `UPDATE public."NativeBackgroundTaskState" SET "leaseOwner"='synthetic', "leaseExpiresAt"='2099-01-01';`, true);
  sql('UPDATE public."NativeBackgroundTaskState" SET "leaseOwner"=NULL, "leaseExpiresAt"=NULL;');
  clear();
  check('missing table fails open', sql('BEGIN; ALTER TABLE public."SupportSession" RENAME TO "MissingSupport"; SELECT public.native_operations_work_due(); ROLLBACK;'), 't');
  check('missing column fails open', sql('BEGIN; ALTER TABLE public."SupportSession" RENAME COLUMN "expiresAt" TO "missing"; SELECT public.native_operations_work_due(); ROLLBACK;'), 't');
  check('predicate NULL clock fails open', sql('SELECT public.native_operations_work_due(NULL);'), 't');
  check('predicate infinite clock fails open', sql("SELECT public.native_operations_work_due('infinity');"), 't');
  clear();
  sql(`INSERT INTO public."NativeDomainOutbox" ("aggregateType","eventType","state") SELECT 'HomeClaimReference','installation_complete','PENDING' FROM generate_series(1,1000);`);
  check('1000 known passive rows can skip', gate(), 'f');
  sql(outbox('HomeClaimReference', 'installation_complete'));
  check('1001 outbox candidates conservatively dispatch', gate(), 't');
  clear();
  sql(`INSERT INTO public."NativeNotificationDeliveryReceipt" ("family","channel","status","deliverAfter") SELECT 'OWNER_INSTALLATION_UPDATE','EMAIL','PENDING','2099-01-01' FROM generate_series(1,1000);`);
  check('1000 future receipts can skip', gate(), 'f'); sql(receipt({ deliverAfter: '2099-01-01' }));
  check('1001 receipt candidates conservatively dispatch', gate(), 't');
  clear();
  sql(insert('HubCredentialVersion', { state: 'PENDING' }));
  sql(`INSERT INTO public."HubCredentialVersion" ("state", "issuedAt") SELECT 'ACTIVE','2026-11-03T11:00:00' FROM generate_series(1,1000);`);
  check('1000 rotation candidates with sibling can skip', gate(), 'f');
  sql(insert('HubCredentialVersion', { state: 'ACTIVE', issuedAt: '2026-11-03T11:00:00' }));
  check('1001 rotation candidates conservatively dispatch', gate(), 't');
  clear();
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const call of ['public.native_operations_work_due()', 'public.dispatch_native_operations_if_due()']) {
      const denied = sql(`SET ROLE ${role}; SELECT ${call};`, true);
      check(`${role} denied ${call}`, denied.status !== 0 && /permission denied for function/.test(denied.stderr), true);
    }
  }
  check('PUBLIC has no function execution privileges', sql(`SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) acl WHERE p.oid IN ('public.native_operations_work_due(timestamptz)'::regprocedure,'public.dispatch_native_operations_if_due()'::regprocedure) AND acl.grantee=0 AND acl.privilege_type='EXECUTE'`), '0');
  check('both functions INVOKER with fixed search_path', sql(`SELECT count(*) FROM pg_proc WHERE oid IN ('public.native_operations_work_due(timestamptz)'::regprocedure,'public.dispatch_native_operations_if_due()'::regprocedure) AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog']`), '2');
  check('only postgres owns/granted execute', sql(`SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) acl WHERE p.oid IN ('public.native_operations_work_due(timestamptz)'::regprocedure,'public.dispatch_native_operations_if_due()'::regprocedure) AND acl.grantee <> 'postgres'::regrole AND acl.privilege_type='EXECUTE'`), '0');
  sql('TRUNCATE vault.stub_reads;'); sql(candidate);
  check('work arriving after idle check waits for next tick', sql('SELECT count(*) FROM net.stub_queue'), '0');
  sql(insert('SupportSession', { status: 'ACTIVE', expiresAt: '2000-01-01' }));
  sql(candidate); await drain();
  check('next tick due work reaches actual HTTP recorder', received.length, 2);
  check('due tick reads exactly original two Vault names', sql('SELECT count(DISTINCT name) FROM vault.stub_reads'), '2');
  check('recorder sees synthetic Bearer only', received.every((row) => row.authorization === 'Bearer synthetic-stage4-only' && row.method === 'POST' && row.body === '{}'), true);
  // Guard failures rollback the entire migration; unrelated cron rows remain intact.
  for (const [label, mutation] of [
    ['duplicate job', `INSERT INTO cron.job SELECT 42,jobname,schedule,command,username,database,active FROM cron.job WHERE jobid=41`],
    ['unexpected schedule', "UPDATE cron.job SET schedule='* * * * *' WHERE jobid=41"],
    ['unexpected command', "UPDATE cron.job SET command='SELECT 1' WHERE jobid=41"],
    ['unexpected owner', "UPDATE cron.job SET username='service_role' WHERE jobid=41"],
    ['unexpected database', "UPDATE cron.job SET database='other' WHERE jobid=41"],
  ]) {
    for (const [kind, command] of [['activation', migration], ['recovery', recovery]]) {
      const result = sql(`BEGIN; ${mutation}; ${command.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '')} ROLLBACK;`, true);
      check(`${kind} rejects ${label}`, result.status !== 0 && /native operations/.test(result.stderr), true);
    }
  }
  sql("UPDATE cron.job SET active=true WHERE jobid=41;"); sql(migration);
  check('activation preserves active=true', sql('SELECT active FROM cron.job WHERE jobid=41'), 't');
  clear(); sql(recovery); sql(recovery);
  check('idempotent recovery restores EXACT former command', sql('SELECT command FROM cron.job WHERE jobid=41'), baseline);
  check('recovery preserves SAME job ID/schedule/active', sql("SELECT jobid || '|' || schedule || '|' || active FROM cron.job"), '41|*/2 * * * *|true');
  sql(sql('SELECT command FROM cron.job WHERE jobid=41')); await drain();
  check('recovered unconditional job sends while idle', received.length, 3);
  sql('DELETE FROM cron.job;'); sql(migration); sql(recovery);
  check('absent job is never created', sql('SELECT count(*) FROM cron.job'), '0');
  // Gate uncertainty must fall back even if the predicate itself is absent/NULL.
  clear(); resetTasks(); const beforeFallback = received.length;
  sql("CREATE OR REPLACE FUNCTION public.native_operations_work_due(p_now timestamptz DEFAULT statement_timestamp()) RETURNS boolean LANGUAGE sql AS 'SELECT NULL::boolean';");
  sql('SELECT public.dispatch_native_operations_if_due();'); await drain();
  check('NULL predicate result dispatches conservatively', received.length, beforeFallback + 1);
  sql('DROP FUNCTION public.native_operations_work_due(timestamptz);');
  sql('SELECT public.dispatch_native_operations_if_due();'); await drain();
  check('missing predicate dispatches conservatively', received.length, beforeFallback + 2);
  sql(migration);
  // Managed catalog topology: postgres owns application tables/functions but has
  // SELECT only on cron.job; extension API owns its privileged catalog update.
  sql(`INSERT INTO cron.job VALUES (41, 'dinodia-native-operations', '*/2 * * * *', ${quote(baseline)}, 'postgres', 'stage4', true);
CREATE ROLE stage4_catalog_owner;
ALTER TABLE cron.job OWNER TO stage4_catalog_owner;
GRANT SELECT ON cron.job TO postgres;
GRANT USAGE ON SCHEMA cron TO stage4_catalog_owner;
ALTER FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) SECURITY DEFINER;
ALTER FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) OWNER TO stage4_catalog_owner;
ALTER ROLE postgres NOSUPERUSER;`);
  check('managed cron catalog is SELECT-only for migration role', sql("SELECT has_table_privilege(current_user,'cron.job','UPDATE')"), 'f');
  sql(migration);
  check('supported API activation works without catalog UPDATE privilege', sql('SELECT command FROM cron.job WHERE jobid=41'), candidate);
  sql(recovery);
  check('supported API recovery works without catalog UPDATE privilege', sql('SELECT command FROM cron.job WHERE jobid=41'), baseline);
  docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'stage4_test_admin', '-d', 'stage4'], 'ALTER ROLE postgres SUPERUSER;');
  clear(); resetTasks();
  const explain = () => JSON.parse(sql("EXPLAIN (ANALYZE, FORMAT JSON) SELECT public.native_operations_work_due('2026-11-03T12:00:00Z'::timestamptz)"))[0]['Execution Time'];
  const emptyMs=explain();
  sql("INSERT INTO public.\"NativeDomainOutbox\" (\"aggregateType\",\"eventType\",state) SELECT 'NativeDevice','PROPERTY_DEVICE_ADOPTED','PENDING' FROM generate_series(1,500);");
  check('representative 500 retained passive signals remain idle', gate(), 'f');
  report('MEASUREMENT predicate PostgreSQL elapsed milliseconds: '+JSON.stringify({empty:emptyMs,passive500:explain()})+'; synthetic typed fixtures, not provider CPU or network attribution');
  report(`PASS ${checks} checks; PostgreSQL SQL executed; cron/Vault/net stubs and local async HTTP recorder only; no real extension daemons or domain workers tested.`);
} catch (error) {
  report(`FAIL after ${checks} checks: ${String(error.message).replaceAll(password, '[redacted]')}`);
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (started) docker(['rm', '-f', '-v', name]);
}
