#!/usr/bin/env node
// Guarded, reviewed-migration applier for the Production Platform database.
//   node scripts/apply_additive_migration.mjs check   <PLATFORM_WORKTREE> <MIGRATION_NAME> [--env-file PATH]
//   node scripts/apply_additive_migration.mjs migrate <PLATFORM_WORKTREE> <MIGRATION_NAME> --bridge-build dpl_... [--env-file PATH] --expect-columns Table.col,Table.col
// `check` is read-only. `migrate` runs `prisma migrate deploy` ONLY when exactly the named migration is pending, its checksum is
// registered in src/lib/foundation.ts, the live deployment is the compatibility bridge, and household counts are unchanged afterwards.
// Credentials come from the private env file and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const [mode, rootArg, name] = args;
const option = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
if (!['check', 'migrate'].includes(mode) || !rootArg || !/^[0-9]{14}_[a-z0-9_]+$/.test(name ?? '')) throw new Error('usage: check|migrate PLATFORM_WORKTREE MIGRATION_NAME [--bridge-build dpl_...] [--expect-columns Table.col,...] [--env-file PATH]');
const root = fs.realpathSync(rootArg);
const envFile = option('--env-file') ?? '/Users/niveditgupta/Documents/Dinodia Smart Living/Tech Stack V2/dinodia-platform-V2/.env.local';
const require = createRequire(path.join(root, 'package.json'));
const dotenv = require('dotenv');
const { PrismaClient } = require(path.join(root, 'src/generated/prisma'));
const { validateReadOnlyProductionTargets } = await import(pathToFileURL(path.join(root, 'scripts/read_only_production_inventory.mjs')));
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
if (git('remote', 'get-url', 'origin') !== 'https://github.com/nivedit1998/dinodia-platform-V2.git' || git('status', '--porcelain', '--untracked-files=no')) throw new Error('Exact clean Platform source required');
const migrationsRoot = path.join(root, 'prisma/migrations');
const checksumOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const checksum = checksumOf(path.join(migrationsRoot, name, 'migration.sql'));
if (!fs.readFileSync(path.join(root, 'src/lib/foundation.ts'), 'utf8').includes(`'${name}': '${checksum}'`)) throw new Error('Migration checksum is not registered in src/lib/foundation.ts');
const credentials = dotenv.parse(fs.readFileSync(envFile));
validateReadOnlyProductionTargets({ databaseUrl: credentials.DATABASE_URL, directUrl: credentials.DIRECT_URL, target: JSON.parse(fs.readFileSync(path.join(root, 'scripts/v2-target.json'))) });
const expected = (option('--expect-columns') ?? '').split(',').filter(Boolean).map((item) => item.split('.'));
const db = new PrismaClient({ datasourceUrl: credentials.DIRECT_URL });
const snapshot = () => db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const migrations = await tx.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at`;
  const counts = (await tx.$queryRaw`SELECT (SELECT count(*)::int FROM "Home") AS homes, (SELECT count(*)::int FROM "Area") AS areas, (SELECT count(*)::int FROM "NativeDevice") AS devices, (SELECT count(*)::int FROM "HomeMembership") AS memberships, (SELECT count(*)::int FROM "TenantAreaGrant") AS grants, (SELECT count(*)::int FROM "CustomerAccount") AS accounts, (SELECT count(*)::int FROM "AlexaNativeLink") AS "alexaLinks"`)[0];
  const present = [];
  for (const [table, column] of expected) {
    const rows = await tx.$queryRaw`SELECT 1 AS ok FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}`;
    present.push(`${table}.${column}=${rows.length === 1}`);
  }
  return { migrations, counts, present };
});
try {
  const before = await snapshot();
  const applied = new Map(before.migrations.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => [row.migration_name, row.checksum]));
  if (before.migrations.some((row) => !row.finished_at && !row.rolled_back_at)) throw new Error('An unresolved migration exists');
  const names = fs.readdirSync(migrationsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const [migration, recorded] of applied) {
    if (!names.includes(migration) || checksumOf(path.join(migrationsRoot, migration, 'migration.sql')) !== recorded) throw new Error(`Existing migration drift: ${migration}`);
  }
  const pending = names.filter((entry) => !applied.has(entry));
  console.log(JSON.stringify({ mode, commit, pending, counts: before.counts, columns: before.present }));
  if (pending.length > 1 || (pending.length === 1 && pending[0] !== name)) throw new Error('Unexpected pending migration');
  if (mode === 'migrate' && pending.length === 1) {
    const bridge = option('--bridge-build');
    const ready = await (await fetch('https://dinodia-platform-v2.vercel.app/api/readiness', { cache: 'no-store' })).json();
    if (!bridge || ready.ready !== true || ready.build !== bridge) throw new Error('Live deployment is not the named compatibility bridge');
    const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    const result = spawnSync('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], { cwd: root, env: { ...childEnv, DATABASE_URL: credentials.DATABASE_URL, DIRECT_URL: credentials.DIRECT_URL }, encoding: 'utf8' });
    const logRoot = path.join(os.homedir(), '.config/dinodia/release-logs');
    fs.mkdirSync(logRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(logRoot, `${name}-${Date.now()}.log`), `${result.stdout || ''}\n${result.stderr || ''}`, { mode: 0o600, flag: 'wx' });
    if (result.status !== 0) throw new Error('Migration failed; inspect the private log without exposing credentials');
    const after = await snapshot();
    if (JSON.stringify(before.counts) !== JSON.stringify(after.counts)) throw new Error('Household counts changed during migration');
    if (!after.migrations.some((row) => row.migration_name === name && row.checksum === checksum && row.finished_at && !row.rolled_back_at) || after.present.some((item) => item.endsWith('=false'))) throw new Error('Postflight check failed');
    console.log(JSON.stringify({ migrated: true, countsPreserved: true, columns: after.present }));
  }
} catch (error) { console.error('FAILED:', error.message); process.exitCode = 1; } finally { await db.$disconnect(); }
