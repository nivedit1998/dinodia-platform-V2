import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationBundleIdentity, STAGE6_CUSTOMER_MIGRATIONS, STAGE9_DEREGISTRATION_GUARD_MIGRATION, STAGE10_ANALYTICS_MAINTENANCE_MIGRATION, STAGE10_PARTIAL_USAGE_COVERAGE_MIGRATION, STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION, unexpectedPendingMigrations } from '../scripts/native_migration_bundle.mjs';

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

test('Stage 10 production migration bundle pins maintenance and partial-coverage migrations together', () => {
  const stage10Migrations = [STAGE10_ANALYTICS_MAINTENANCE_MIGRATION, STAGE10_PARTIAL_USAGE_COVERAGE_MIGRATION];
  const checksums = new Map(stage10Migrations.map((name, index) => [name, String(index + 4).repeat(64)]));
  const bundle = migrationBundleIdentity(stage10Migrations, checksums);
  assert.deepEqual(bundle.migrations.map(({ name }) => name), stage10Migrations);
  assert.equal(bundle.migrations.length, 2);
  assert.deepEqual(unexpectedPendingMigrations([STAGE10_PARTIAL_USAGE_COVERAGE_MIGRATION], stage10Migrations), []);
  assert.deepEqual(unexpectedPendingMigrations([...stage10Migrations, 'unreviewed-stage10-migration'], stage10Migrations), ['unreviewed-stage10-migration']);
  assert.throws(() => migrationBundleIdentity(stage10Migrations, new Map([[stage10Migrations[0], 'a'.repeat(64)]])), /missing reviewed checksum/);
});

test('Stage 11 additive automation action-order migration has one exact reviewed target', () => {
  const checksum = '4f0630406c83d5521a9921f9fab37d0b4d44798a8a5b43b9b61a79e8d956bee1';
  const bundle = migrationBundleIdentity([STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION], new Map([[STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION, checksum]]));
  assert.deepEqual(bundle.migrations, [{ name: STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION, sha256: checksum }]);
  assert.deepEqual(unexpectedPendingMigrations([STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION], [STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION]), []);
  assert.deepEqual(unexpectedPendingMigrations([STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION, 'unreviewed-stage12-migration'], [STAGE11_AUTOMATION_ACTION_ORDER_MIGRATION]), ['unreviewed-stage12-migration']);
});
