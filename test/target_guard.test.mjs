import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const script = 'scripts/assert_v2_target.mjs';
const base = {
  ...process.env,
  V2_ENVIRONMENT: 'rc',
  V2_ALLOW_REMOTE_MIGRATION: 'I_UNDERSTAND_NEW_V2_DATABASE',
  SUPABASE_PROJECT_REF: 'fppzzesvukjbsfmxmfxe',
  VERCEL_PROJECT_ID: 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y',
  DATABASE_URL: 'postgresql://postgres.fppzzesvukjbsfmxmfxe:placeholder@aws-0-eu-west-2.pooler.supabase.com:6543/postgres',
  DIRECT_URL: 'postgresql://postgres:placeholder@db.fppzzesvukjbsfmxmfxe.supabase.co:5432/postgres',
};

function run(env) {
  return spawnSync(process.execPath, [script, '--mode', 'rc'], { cwd, env, encoding: 'utf8' });
}

test('target guard accepts the approved V2 pair without running Prisma', () => {
  const result = run(base);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fppzzesvukjbsfmxmfxe/);
});

test('target guard rejects a wrong pooler tenant before Prisma', () => {
  const result = run({ ...base, DATABASE_URL: base.DATABASE_URL.replace('postgres.fppzzesvukjbsfmxmfxe', 'postgres.aaaaaaaaaaaaaaaaaaaa') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same Supabase project|approved V2/i);
});

test('target guard rejects mismatched database names before Prisma', () => {
  const result = run({ ...base, DIRECT_URL: base.DIRECT_URL.replace(/\/postgres$/, '/wrong_database') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same database/i);
});

test('target guard rejects remote work without explicit V2 project metadata', () => {
  const result = run({ ...base, SUPABASE_PROJECT_REF: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_PROJECT_REF/i);
});

test('target guard rejects production mode before Prisma', () => {
  const result = run({ ...base, NODE_ENV: 'production', V2_ENVIRONMENT: 'production' });
  assert.notEqual(result.status, 0);
});
