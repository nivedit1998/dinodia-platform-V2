import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationBundleIdentity, STAGE6_CUSTOMER_MIGRATIONS, unexpectedPendingMigrations } from '../scripts/native_migration_bundle.mjs';

test('Stage 6 migration bundle identity is stable, ordered and requires every reviewed checksum', () => {
  const checksums = new Map(STAGE6_CUSTOMER_MIGRATIONS.map((name, index) => [name, String(index + 1).repeat(64)]));
  const first = migrationBundleIdentity(STAGE6_CUSTOMER_MIGRATIONS, checksums);
  const second = migrationBundleIdentity([...STAGE6_CUSTOMER_MIGRATIONS].reverse(), checksums);
  assert.deepEqual(first, second);
  assert.deepEqual(first.migrations.map(({ name }) => name), [...STAGE6_CUSTOMER_MIGRATIONS].sort());
  assert.equal(first.migrations.length, 4);
  assert.throws(() => migrationBundleIdentity(STAGE6_CUSTOMER_MIGRATIONS, new Map()), /missing reviewed checksum/);
});

test('Stage 6 migration target accepts its reviewed bundle and rejects unrelated pending migrations', () => {
  assert.deepEqual(unexpectedPendingMigrations(STAGE6_CUSTOMER_MIGRATIONS, STAGE6_CUSTOMER_MIGRATIONS), []);
  assert.deepEqual(unexpectedPendingMigrations([...STAGE6_CUSTOMER_MIGRATIONS, 'unreviewed-stage7-migration'], STAGE6_CUSTOMER_MIGRATIONS), ['unreviewed-stage7-migration']);
});
