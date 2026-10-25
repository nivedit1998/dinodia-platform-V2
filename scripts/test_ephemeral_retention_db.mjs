import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const name = `dinodia-retention-test-${process.pid}`;
const password = randomBytes(24).toString('hex');
let started = false;
try {
  execFileSync('docker', ['run', '-d', '--name', name, '--memory=256m', '--cpus=1',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=dinodia_retention_test',
    '-p', '127.0.0.1::5432', 'postgres:16-alpine'], {
    env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: 'pipe',
  });
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  const mapping = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim();
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error('Unexpected disposable port binding');
  const result = spawnSync(process.execPath, ['--test', 'test/ephemeral_retention.test.mjs'], {
    env: { ...process.env, DINODIA_RETENTION_TEST_DATABASE_URL: `postgresql://postgres:${password}@${mapping}/dinodia_retention_test` }, stdio: 'inherit',
  });
  if (result.status !== 0) process.exitCode = 1;
} catch { console.error('Disposable retention database check failed'); process.exitCode = 1;
} finally { if (started) execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); }
