import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, PRISMA_TELEMETRY_DISABLED: '1' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npx', ['prisma', 'validate']);
run('npx', ['prisma', 'generate']);
run('node', ['scripts/audit_native_schema.mjs']);
console.log('[verify-native-schema] PASS: Prisma schema/client and model/SQL classification checks');
