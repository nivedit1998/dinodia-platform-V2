// Architecture: Repository maintenance or verification script scripts/check_no_unsafe_logs.mjs; supports parity, generation, security, logging or operational checks outside request-time runtime code.
import { execFileSync } from 'node:child_process';

function runRg(args) {
  return execFileSync('rg', args, { encoding: 'utf8' });
}

const checks = [
  {
    name: 'direct console.* in API routes',
    args: [
      '-n',
      '--glob',
      '!.next/**',
      '--glob',
      '!node_modules/**',
      String.raw`console\.(log|error|warn|info)\(`,
      'src/app/api',
    ],
  },
  {
    name: 'raw console error/warn object in shared libraries',
    args: [
      '-n',
      '--glob',
      '!.next/**',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!src/lib/safeLogger.ts',
      '--glob',
      '!src/lib/requestLog.ts',
      '--glob',
      '!src/lib/logout.ts',
      '--glob',
      '!src/lib/refreshBus.ts',
      String.raw`console\.(error|warn)\([^;\n]*\b(err|error|restErr)\b[^;\n]*\);`,
      'src/lib',
    ],
  },
  {
    name: 'alexaEvents must not read raw response text',
    args: ['-n', String.raw`res\.text\(`, 'src/lib/alexaEvents.ts'],
    allowNoMatches: true,
  },
];

let failed = false;

for (const check of checks) {
  try {
    const out = runRg(check.args);
    if (out.trim()) {
      // If we got matches, this check fails unless allowNoMatches is set (it is not).
      failed = true;
      process.stdout.write(`\n[check:logs] FAIL: ${check.name}\n`);
      process.stdout.write(out);
    }
  } catch (err) {
    // rg exits with code 1 when there are no matches (that's success for most checks here).
    // For allowNoMatches=false, "no matches" is success.
    const code = err && typeof err === 'object' && 'status' in err ? err.status : null;
    if (code === 1) {
      // no matches
      continue;
    }
    if (check.allowNoMatches) {
      continue;
    }
    failed = true;
    process.stdout.write(`\n[check:logs] ERROR running check: ${check.name}\n`);
    process.stdout.write(String(err));
  }
}

if (failed) {
  process.exit(1);
}

process.stdout.write('[check:logs] OK\n');
