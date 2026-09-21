import { execFileSync } from 'node:child_process';

const name = process.env.V2_DOCKER_NAME || 'dinodia-v2-foundation-check';
const port = process.env.V2_DOCKER_PORT || '55487';
const password = process.env.V2_LOCAL_DB_PASSWORD;
const action = process.argv[2] || 'up';
function run(args) { return execFileSync('docker', args, { encoding: 'utf8', stdio: 'inherit' }); }
if (action === 'up') {
  if (!password) throw new Error('V2_LOCAL_DB_PASSWORD must be supplied in the calling shell; it is never generated or persisted by this script');
  try { run(['rm', '-f', name]); } catch {}
  run(['run', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=dinodia_v2_foundation', '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine']);
  console.log(`Docker PostgreSQL started: ${name} on 127.0.0.1:${port}`);
} else if (action === 'reset') {
  run(['exec', name, 'psql', '-U', 'postgres', '-d', 'dinodia_v2_foundation', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
} else if (action === 'down') {
  run(['rm', '-f', name]);
} else throw new Error(`unknown local database action: ${action}`);
