import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const migrationName = '20261003000000_native_v2_stage3_domain_schema';
const migrationDirectory = path.join(root, 'prisma', 'migrations', migrationName);
const invariantSqlPath = path.join(root, 'prisma', 'stage3_invariants.sql');
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-stage3-schema-diff-'));

function fail(message) {
  throw new Error(`[stage3:migration-generation] BLOCKED: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? safeEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const safeOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '<database-url-redacted>')
      .trim();
    throw new Error(`${command} failed with exit ${result.status ?? 1}${safeOutput ? `: ${safeOutput}` : ''}`);
  }
  return result.stdout.trim();
}

const safeEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR || os.tmpdir(),
  CI: '1',
  NODE_ENV: 'test',
  PRISMA_TELEMETRY_DISABLED: '1',
};

try {
  const args = process.argv.slice(2);
  const refreshExisting = args.length === 1 && args[0] === '--refresh-existing';
  if (args.length && !refreshExisting) fail('only the explicit --refresh-existing flag is supported; no database target or migration path is accepted');
  const migrationExists = fs.existsSync(migrationDirectory);
  if (migrationExists && !refreshExisting) fail('the planned migration path is already occupied; use --refresh-existing only after reviewing both schema and invariant source');
  if (!migrationExists && refreshExisting) fail('--refresh-existing requires the existing uncommitted candidate directory');
  const baseline = run('git', ['show', 'HEAD:prisma/schema.prisma']);
  if (!baseline.includes('model HubInstallation') || baseline.includes('model NativeAutomation {')) {
    fail('HEAD is not the verified pre-Stage-3 Prisma schema baseline');
  }
  const baselinePath = path.join(tempDirectory, 'baseline.prisma');
  fs.writeFileSync(baselinePath, baseline, { flag: 'wx' });
  if (!migrationExists) fs.mkdirSync(migrationDirectory, { recursive: false });
  const generatedPath = path.join(tempDirectory, 'generated.sql');

  run('npx', [
    'prisma', 'migrate', 'diff',
    '--from-schema-datamodel', baselinePath,
    '--to-schema-datamodel', 'prisma/schema.prisma',
    '--script',
    '--output', generatedPath,
  ]);
  if (!fs.existsSync(invariantSqlPath)) fail('reviewed Stage 3 invariant SQL template is missing');
  const migration = `${fs.readFileSync(generatedPath, 'utf8').trimEnd()}\n\n${fs.readFileSync(invariantSqlPath, 'utf8').trim()}\n`;
  if (/\b(?:DROP\s+TABLE|DROP\s+COLUMN|DROP\s+TYPE|TRUNCATE|DROP\s+SCHEMA)\b/i.test(migration)) {
    fail('generated SQL contains a destructive table/column/type/schema operation');
  }
  const droppedIndexes = [...migration.matchAll(/DROP\s+INDEX\s+(?:IF EXISTS\s+)?"([^"]+)"/gi)].map((item) => item[1]);
  if (droppedIndexes.some((name) => name !== 'HubInstallation_homeId_key')) {
    fail(`generated SQL drops indexes outside the reviewed hub-cardinality transition: ${droppedIndexes.join(', ')}`);
  }
  if (/\bDROP\s+CONSTRAINT\b/i.test(migration)) {
    fail('generated SQL drops a baseline database constraint; preserve it and author an explicit additive replacement');
  }
  fs.writeFileSync(path.join(migrationDirectory, 'migration.sql'), migration);
  console.log(JSON.stringify({
    ok: true,
    migrationName,
    generatedSqlBytes: Buffer.byteLength(migration),
    droppedIndexes,
    source: 'Prisma datamodel diff from committed Stage 2 head plus reviewed additive invariant SQL',
    noProductionConnection: true,
  }));
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
