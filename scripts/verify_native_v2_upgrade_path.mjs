import { spawnSync } from 'node:child_process';

const result = spawnSync('node', ['scripts/check_clean_clone.mjs'], { stdio: 'inherit', env: { CI: '1', NODE_ENV: 'test', PRISMA_TELEMETRY_DISABLED: '1', NEXT_TELEMETRY_DISABLED: '1', ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((name) => process.env[name]).map((name) => [name, process.env[name]]) ) } });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('[verify-native-v2-upgrade-path] PASS: two independent empty PostgreSQL applies/replays and exact-foundation upgrade/replay');
