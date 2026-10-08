import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationBundleIdentity, STAGE6_CUSTOMER_MIGRATIONS, STAGE9_DEREGISTRATION_GUARD_MIGRATION, unexpectedPendingMigrations } from '../scripts/native_migration_bundle.mjs';

test('Stage 6 migration bundle identity is stable, ordered and requires every reviewed checksum', () => {
  const checksums = new Map(STAGE6_CUSTOMER_MIGRATIONS.map((name, index) => [name, String(index + 1).repeat(64)]));
  const first = migrationBundleIdentity(STAGE6_CUSTOMER_MIGRATIONS, checksums);
  const second = migrationBundleIdentity([...STAGE6_CUSTOMER_MIGRATIONS].reverse(), checksums);
  assert.deepEqual(first, second);
  assert.deepEqual(first.migrations.map(({ name }) => name), [...STAGE6_CUSTOMER_MIGRATIONS].sort());
  assert.equal(first.migrations.length, 6);
  assert.throws(() => migrationBundleIdentity(STAGE6_CUSTOMER_MIGRATIONS, new Map()), /missing reviewed checksum/);
});

test('Stage 6 migration target accepts its reviewed bundle and rejects unrelated pending migrations', () => {
  assert.deepEqual(unexpectedPendingMigrations(STAGE6_CUSTOMER_MIGRATIONS, STAGE6_CUSTOMER_MIGRATIONS), []);
  assert.deepEqual(unexpectedPendingMigrations([...STAGE6_CUSTOMER_MIGRATIONS, 'unreviewed-stage7-migration'], STAGE6_CUSTOMER_MIGRATIONS), ['unreviewed-stage7-migration']);
});

test('Stage 9 support-guard migration is a single reviewed additive target', () => {
  const checksums = new Map([[STAGE9_DEREGISTRATION_GUARD_MIGRATION, 'a'.repeat(64)]]);
  const bundle = migrationBundleIdentity([STAGE9_DEREGISTRATION_GUARD_MIGRATION], checksums);
  assert.equal(bundle.migrations.length, 1);
  assert.equal(bundle.migrations[0].name, STAGE9_DEREGISTRATION_GUARD_MIGRATION);
  assert.deepEqual(unexpectedPendingMigrations([STAGE9_DEREGISTRATION_GUARD_MIGRATION], [STAGE9_DEREGISTRATION_GUARD_MIGRATION]), []);
  assert.deepEqual(unexpectedPendingMigrations([STAGE9_DEREGISTRATION_GUARD_MIGRATION, 'unreviewed'], [STAGE9_DEREGISTRATION_GUARD_MIGRATION]), ['unreviewed']);
});
