import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeTargetIsValid } from '../src/lib/runtimeTarget.mjs';

const base = {
  V2_ENVIRONMENT: 'rc',
  SUPABASE_PROJECT_REF: 'fppzzesvukjbsfmxmfxe',
  VERCEL_PROJECT_ID: 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y',
  NEXT_PUBLIC_SUPABASE_URL: 'https://fppzzesvukjbsfmxmfxe.supabase.co',
  DATABASE_URL: 'postgresql://postgres.fppzzesvukjbsfmxmfxe:placeholder@aws-0-eu-west-2.pooler.supabase.com:6543/postgres',
  DIRECT_URL: 'postgresql://postgres:placeholder@db.fppzzesvukjbsfmxmfxe.supabase.co:5432/postgres',
};

test('runtime target accepts the approved V2 pooler/direct pair', () => {
  assert.equal(runtimeTargetIsValid(base), true);
});

test('runtime target rejects the wrong project even with a valid Supabase-shaped URL', () => {
  assert.equal(runtimeTargetIsValid({ ...base, SUPABASE_PROJECT_REF: 'aaaaaaaaaaaaaaaaaaaa', NEXT_PUBLIC_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co' }), false);
});

test('runtime target rejects database-name mismatch', () => {
  assert.equal(runtimeTargetIsValid({ ...base, DIRECT_URL: base.DIRECT_URL.replace(/\/postgres$/, '/other') }), false);
});

test('runtime target accepts loopback only for local/test modes', () => {
  const local = {
    V2_ENVIRONMENT: 'local',
    DATABASE_URL: 'postgresql://postgres:placeholder@127.0.0.1:55487/dinodia_v2_foundation',
    DIRECT_URL: 'postgresql://postgres:placeholder@127.0.0.1:55487/dinodia_v2_foundation',
  };
  assert.equal(runtimeTargetIsValid(local), true);
  assert.equal(runtimeTargetIsValid({ ...local, V2_ENVIRONMENT: 'rc' }), false);
});
