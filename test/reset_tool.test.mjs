import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('remote reset refuses missing reset confirmation before opening the database', () => {
  const result = spawnSync(process.execPath, ['scripts/reset_rc_database.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      V2_ENVIRONMENT: 'rc',
      V2_ALLOW_REMOTE_MIGRATION: 'I_UNDERSTAND_NEW_V2_DATABASE',
      V2_RC_ARTIFACT_DIR: '/tmp/dinodia-v2-test-artifacts',
      V2_EXPECTED_SCHEMA_FINGERPRINT: 'placeholder',
      V2_EXPECTED_MIGRATION_SHA256: 'placeholder',
      DATABASE_URL: '',
      DIRECT_URL: '',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /V2_ALLOW_REMOTE_RESET/);
});
