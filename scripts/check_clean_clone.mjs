import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const sourceRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dinodia-v2-clean-source-'));
const dockerName = `dinodia-v2-clean-${process.pid}`;
const dockerPort = process.env.V2_CLEAN_CLONE_PORT || String(55488 + (process.pid % 100));
const databasePassword = 'local-clean-clone-only';
const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${dockerPort}/dinodia_v2_foundation`;
let dockerStarted = false;

function safeProcessEnvironment() {
  const safe = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']) {
    if (process.env[name]) safe[name] = process.env[name];
  }
  return safe;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? sourceRoot, env: options.env ?? safeProcessEnvironment(), stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 1}`);
}

function git(args) {
  return execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
}

function sourceFiles() {
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const statusEntries = git(['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean);
  const deleted = new Set();
  for (const entry of statusEntries) {
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.includes('D')) deleted.add(file);
  }
  const files = new Set(tracked.filter((file) => !deleted.has(file)));
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const file of untracked) files.add(file);

  const forbidden = [];
  const allowed = [];
  for (const file of [...files].sort()) {
    if (file === '.git' || file.startsWith('.git/') || file.startsWith('node_modules/') || file.startsWith('.next/')) continue;
    if (file === '.env.local' || file === '.env.preview' || file === '.env.production' || file.startsWith('.vercel/') || file.startsWith('.supabase/') || /\.(pem|key|p12|pfx|dump|sql\.gz)$/i.test(file)) {
      forbidden.push(file);
      continue;
    }
    const absolute = path.join(sourceRoot, file);
    if (!fs.existsSync(absolute)) continue;
    allowed.push(file);
  }
  if (forbidden.length) throw new Error(`clean source contains forbidden local/secret files: ${forbidden.join(', ')}`);
  return allowed;
}

function copyPreservingLink(relativeFile) {
  const source = path.join(sourceRoot, relativeFile);
  const destination = path.join(tempRoot, relativeFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
  else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, stat.mode & 0o777);
}

function copyCrossRepositoryFixture(source, destination, files) {
  if (!fs.existsSync(source)) throw new Error(`required cross-repository source is missing: ${source}`);
  for (const file of files) {
    const from = path.join(source, file);
    if (!fs.existsSync(from)) throw new Error(`required cross-repository contract file is missing: ${from}`);
    const to = path.join(destination, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function copyCrossRepositoryTree(source, destination, relativeDirectories) {
  if (!fs.existsSync(source)) throw new Error(`required cross-repository source is missing: ${source}`);
  for (const relativeDirectory of relativeDirectories) {
    const from = path.join(source, relativeDirectory);
    if (!fs.existsSync(from)) throw new Error(`required cross-repository directory is missing: ${from}`);
    const to = path.join(destination, relativeDirectory);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, {
      recursive: true,
      filter: (entry) => {
        const relative = path.relative(source, entry);
        return !relative.startsWith('node_modules') && !relative.startsWith('.git') && !relative.startsWith('.env.local');
      },
    });
  }
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('docker', ['exec', dockerName, 'pg_isready', '-U', 'postgres', '-d', 'dinodia_v2_foundation'], { encoding: 'utf8' });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('temporary PostgreSQL did not become ready');
}

function cleanup() {
  if (dockerStarted) spawnSync('docker', ['rm', '-f', dockerName], { stdio: 'ignore' });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

try {
  const files = sourceFiles();
  for (const file of files) copyPreservingLink(file);
  // The clean-source proof must exercise the real cross-repository security
  // contracts. Copy only the reviewed contract surfaces into an isolated
  // fixture; no dependency or local/secret material is imported.
  const crossRoot = path.join(tempRoot, '.cross-repository');
  const osFixture = path.join(crossRoot, 'Dinodia OS');
  const edgeFixture = path.join(crossRoot, 'dinodia-edge-worker-V2');
  copyCrossRepositoryTree(path.resolve(sourceRoot, '../Dinodia OS'), osFixture, ['src', 'public']);
  copyCrossRepositoryFixture(path.resolve(sourceRoot, '../Dinodia OS'), osFixture, [
    'package.json', 'package-lock.json', '.env.example',
  ]);
  copyCrossRepositoryFixture(path.resolve(sourceRoot, '../dinodia-edge-worker-V2'), edgeFixture, ['wrangler.toml', 'src/index.ts']);
  if (!fs.existsSync(path.join(tempRoot, '.env.example'))) throw new Error('.env.example is missing from the clean source snapshot');
  const example = fs.readFileSync(path.join(tempRoot, '.env.example'), 'utf8');
  if (/postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/i.test(example.replaceAll('USER:PASSWORD', 'PLACEHOLDER'))) throw new Error('.env.example appears to contain a real database credential');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(example)) throw new Error('.env.example contains a private key');

  // Deployment metadata is deliberately excluded from the source snapshot.
  // The target-guard integration tests still need to exercise the approved
  // Vercel identity, so create a temporary value-free link from the checked-in
  // public target manifest. It is removed with the temporary source tree.
  const target = JSON.parse(fs.readFileSync(path.join(tempRoot, 'scripts', 'v2-target.json'), 'utf8'));
  const temporaryVercelDirectory = path.join(tempRoot, '.vercel');
  fs.mkdirSync(temporaryVercelDirectory, { recursive: true });
  fs.writeFileSync(path.join(temporaryVercelDirectory, 'project.json'), JSON.stringify({ projectId: target.vercelProjectId, orgId: target.vercelOrgId }));

  run('npm', ['ci'], { cwd: tempRoot, env: { ...safeProcessEnvironment(), CI: '1', NODE_ENV: 'test' } });
  run('docker', ['run', '-d', '--name', dockerName, '-e', `POSTGRES_PASSWORD=${databasePassword}`, '-e', 'POSTGRES_DB=dinodia_v2_foundation', '-p', `127.0.0.1:${dockerPort}:5432`, 'postgres:16-alpine']);
  dockerStarted = true;
  waitForPostgres();

  const localEnv = {
    ...safeProcessEnvironment(),
    CI: '1',
    NODE_ENV: 'test',
    NEXT_TELEMETRY_DISABLED: '1',
    PRISMA_TELEMETRY_DISABLED: '1',
    CHECKPOINT_DISABLE: '1',
    V2_ENVIRONMENT: 'local',
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    DINODIA_OS_ROOT: osFixture,
    DINODIA_EDGE_ROOT: edgeFixture,
  };
  run('npx', ['prisma', 'validate'], { cwd: tempRoot, env: localEnv });
  run('npx', ['prisma', 'generate'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/assert_v2_target.mjs', '--mode', 'local', '--run-prisma'], { cwd: tempRoot, env: localEnv });
  // The second guarded deployment is part of the clean-source proof: a
  // release candidate must be safe to restart after an interrupted deploy.
  run('node', ['scripts/assert_v2_target.mjs', '--mode', 'local', '--run-prisma'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'check:stage1'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/foundation_db_checks.mjs'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/foundation_invariants.mjs'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'test:stage1:db'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'lint'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'typecheck'], { cwd: tempRoot, env: localEnv });
  run('npm', ['test'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'build'], { cwd: tempRoot, env: localEnv });
  run('npm', ['run', 'test:stage1'], { cwd: tempRoot, env: localEnv });
  run('node', ['scripts/schema_fingerprint.mjs'], { cwd: tempRoot, env: localEnv });
  console.log(`[clean-clone:check] OK: reconstructed ${files.length} intended files, installed, migrated, tested and built in ${tempRoot}`);
} finally {
  cleanup();
}
