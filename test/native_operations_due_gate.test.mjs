import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dueGateContract, verifyNativeOperationsDueGateContract } from '../scripts/native_operations_due_gate_contract.mjs';
const read = (file) => readFileSync(file, 'utf8');
const migration = read(`prisma/migrations/${dueGateContract.migration}/migration.sql`);
const baseline = read('scripts/native_operations_due_gate_baseline.sql').trim().replace(/;$/, '');
const recovery = read('scripts/recover_native_operations_due_gate.sql');

test('build/release contract fingerprints match gate-sensitive dispatcher and nested callees', () => {
  assert.equal(verifyNativeOperationsDueGateContract(), 25);
});
test('any fingerprint drift rejects release, including nested tasks and notice types', () => {
  for (const file of Object.keys(dueGateContract.sha256)) {
    assert.throws(() => verifyNativeOperationsDueGateContract((path) => read(path) + (path === file ? '\n// drift' : '')), /compatibility review required/);
  }
});
test('baseline fixture is exactly the original unconditional Vault/net command; candidate and recovery embed it', () => {
  const original = read('prisma/migrations/20260922000000_stage1_security_authorities/migration.sql');
  assert.ok(original.includes(`$$${baseline}$$`));
  assert.ok(migration.includes(baseline.replace('SELECT net.http_post', 'PERFORM net.http_post')));
  assert.ok(migration.includes(`$former$${baseline}$former$`));
  assert.ok(recovery.includes(`$former$${baseline}$former$`));
});
test('additive foundation registration uses the exact SQL checksum', () => {
  const checksum = createHash('sha256').update(migration).digest('hex');
  assert.ok(read('src/lib/foundation.ts').includes(`'${dueGateContract.migration}': '${checksum}'`));
});
test('activation and recovery share the same exact cron guards and preserve job identity', () => {
  const block = (sql) => sql.slice(sql.indexOf('DO $schedule$'), sql.indexOf('END $schedule$;') + 'END $schedule$;'.length);
  assert.equal(block(migration).replace('command := candidate', 'command := former'), block(recovery));
  for (const sql of [migration, recovery]) {
    assert.doesNotMatch(sql, /CREATE EXTENSION|cron\.(?:schedule|unschedule)\(/i);
    assert.match(sql, /cron\.alter_job\(j\.jobid, command := (?:candidate|former)\)/);
    assert.match(sql, /j\.schedule IS DISTINCT FROM '\*\/2 \* \* \* \*'/);
  }
});

test('minimum SQL fixture derives actual enum, varchar, uuid and UTC timestamp(3) column types', async () => {
  const { nativeOperationsDueGateFixture, dueGateFixtureColumns } = await import('../scripts/native_operations_due_gate_fixture.mjs');
  const fixture = nativeOperationsDueGateFixture(read('prisma/schema.prisma'));
  assert.equal(Object.keys(dueGateFixtureColumns).length, 8);
  assert.match(fixture, /"taskId" varchar\(80\) NOT NULL PRIMARY KEY/);
  assert.match(fixture, /"hubInstallationId" uuid NOT NULL/);
  assert.match(fixture, /"codeExpiresAt" timestamp\(3\) without time zone/);
  assert.match(fixture, /"family" public\."NativeNotificationFamily" NOT NULL/);
  assert.doesNotMatch(fixture, /CREATE EXTENSION/i);
});
test('candidate readiness accepts due-gate checksum with unchanged model inventory and rejects checksum drift', async () => {
  const { default: ts } = await import('typescript');
  const module = { exports: {} };
  const compiled = ts.transpileModule(read('src/lib/foundation.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', 'require', compiled)(module, module.exports, (name) => {
    if (name === './runtimeTarget.mjs') return { runtimeTargetIsValid: () => true };
    if (name === './buildIdentity.mjs') return { safeBuildId: () => 'synthetic' };
    throw new Error(`Unexpected foundation dependency ${name}`);
  });
  const { isSchemaReady, REQUIRED_MIGRATION, REQUIRED_MODEL_COUNT } = module.exports;
  const baseChecksum = 'a'.repeat(64);
  const baseline = { migration_name: REQUIRED_MIGRATION, checksum: baseChecksum };
  const addition = { migration_name: dueGateContract.migration, checksum: createHash('sha256').update(migration).digest('hex') };
  assert.equal(isSchemaReady([addition, baseline], REQUIRED_MODEL_COUNT, baseChecksum), true);
  assert.equal(isSchemaReady([{ ...addition, checksum: '0'.repeat(64) }, baseline], REQUIRED_MODEL_COUNT, baseChecksum), false);
  assert.equal(isSchemaReady([addition, baseline], REQUIRED_MODEL_COUNT + 1, baseChecksum), false);
});
