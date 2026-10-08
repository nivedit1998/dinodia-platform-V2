import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const migrationPath = 'prisma/migrations/20261008130000_stage10_analytics_maintenance_tasks/migration.sql';
const migration = readFileSync(migrationPath);
const digest = createHash('sha256').update(migration).digest('hex');

test('Stage 9 runtime accepts only the reviewed additive Stage 10 migration for readiness', () => {
  const foundation = readFileSync('src/lib/foundation.ts', 'utf8');
  assert.equal(digest, '6c651d5b697c6ca295ed21dc9c646db7be2673bbb95e0a05fa29009123f4da2e');
  assert.match(foundation, /'20261008130000_stage10_analytics_maintenance_tasks':\s*'6c651d5b697c6ca295ed21dc9c646db7be2673bbb95e0a05fa29009123f4da2e'/);
});
