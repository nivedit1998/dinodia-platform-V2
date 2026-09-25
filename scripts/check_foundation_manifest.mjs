import { execFileSync } from 'node:child_process';

const root = process.cwd();
const statusOutput = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8' });
const entries = statusOutput.split('\0').filter(Boolean).map((entry) => ({
  status: entry.slice(0, 2),
  file: entry.slice(3),
}));

const modifiedFiles = new Set([
  '.gitignore', '.env.example', 'README.md', 'SECURITY_CHECKLIST.md', 'phase8-acceptance.md', 'docs/STAGE1_DEPENDENCY_ADVISORIES.md', 'docs/V2_ENVIRONMENT_INVENTORY.md',
  'docs/V2_FOUNDATION_STATUS.md', 'next.config.ts', 'package-lock.json', 'package.json', 'prisma.config.ts',
  'prisma/schema.prisma', 'scripts/assert_v2_target.mjs', 'scripts/check_no_unsafe_logs.mjs',
  'scripts/check_clean_clone.mjs', 'scripts/check_foundation.mjs', 'scripts/check_foundation_manifest.mjs', 'scripts/foundation_db_checks.mjs', 'scripts/reset_rc_database.mjs',
  'scripts/check_security_headers.mjs', 'scripts/stage1_integration_harness.mjs', 'src/app/error.tsx', 'src/app/globals.css', 'src/app/layout.tsx',
  'src/app/loading.tsx', 'src/app/not-found.tsx', 'src/app/page.tsx', 'src/lib/prisma.ts', 'supabase/config.toml',
  'tsconfig.json', 'src/app/api/readiness/route.ts', 'src/app/api/company/auth/bootstrap/complete/route.ts', 'src/app/api/company/auth/session/route.ts',
  'src/app/api/company/auth/bootstrap/route.ts', 'src/app/api/hub-agent/support/v2/redeem/route.ts', 'src/app/api/hub-agent/support/v2/revocation/route.ts',
  'src/app/api/installer/workflows/route.ts', 'src/app/api/installer/hubs/provision/route.ts', 'src/app/api/hub-agent/v2/pairing/challenge/route.ts', 'src/app/api/v2/auth/session/route.ts', 'src/app/api/v2/hub-sessions/route.ts', 'src/app/api/v2/support/tickets/[ticketId]/route.ts', 'src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/approve/route.ts', 'src/app/api/v2/support/tickets/[ticketId]/access-requests/[requestId]/issue/route.ts', 'src/app/api/v2/security/step-up/challenge/route.ts', 'src/app/api/v2/security/step-up/consume/route.ts', 'src/app/api/v2/trusted-devices/[trustedDeviceId]/route.ts', 'src/app/installer/page.tsx', 'src/app/installer/provision/page.tsx', 'src/app/installer/home-support/page.tsx', 'src/lib/foundation.ts', 'src/lib/stage1Auth.ts',
  'src/lib/hubOperatorCredentials.ts', 'src/lib/nativeOperations.ts', 'src/lib/sensitiveOperationStepUp.ts', 'src/lib/stage1ClaimContract.ts', 'src/lib/stage1Operator.ts', 'test/foundation_contracts.test.mjs',
  'test/stage1_security.test.mjs', 'vercel.json',
]);

const addedFiles = [
  /^\.env\.example$/,
  /^(SECURITY_CHECKLIST|phase8-acceptance)\.md$/,
  /^docs\/(FOUNDATION_INTENDED_FILE_MANIFEST|NATIVE_V2_SCHEMA_OWNERSHIP)\.md$/,
  /^prisma\/migrations\/\d+_[^/]+\//,
  /^scripts\/(check_clean_clone|check_foundation|check_foundation_manifest|check_stage1_security|enrol_manufactured_hub|foundation_db_checks|foundation_invariants|local_database|reset_rc_database|schema_fingerprint|stage1_db_checks|stage1_integration_harness)\.mjs$/,
  /^src\/app\/api\/(health|readiness)(?:\/|$)/,
  /^src\/app\/api\/(company|cron|hub-agent|installer|internal|v2)(?:\/|$)/,
  /^src\/app\/(company|installer)(?:\/|$)/,
  /^src\/lib\/(foundation|foundationContracts|initialCxoInvitation|manufacturingEnrollment|runtimeDatabaseUrl|runtimeTarget|hubOperatorCredentials|nativeOperations|passwords|rateLimit|sensitiveOperationStepUp|stage1Auth|stage1ClaimContract|stage1Crypto|stage1HubAuth|stage1Operator|supportNotifications)\.(mjs|ts)$/,
  /^test(?:\/|$)/,
  /^vercel\.json$/,
];

const replacedDocumentation = new Set(['SECURITY_CHECKLIST.md', 'phase8-acceptance.md']);

const intentionallyDeleted = (file) => file === 'prisma/migrations/00000000000000_native_v2_foundation/migration.sql'
  || file.startsWith('src/')
  || file.startsWith('src/types/')
  || [
    'scripts/backfillEncryptedSecrets.mjs', 'scripts/checkEmailUniqueness.mjs', 'scripts/check_stage1_security.mjs',
    'scripts/generate_surface_inventory.mjs', 'scripts/labelRegistry.js', 'scripts/supabase_privacy_hardening.sql',
    'scripts/test_stage1_contracts.mjs', 'scripts/verifyBackfill.mjs',
  ].includes(file);

const classified = entries.map(({ status, file }) => {
  if (status.includes('D')) {
    if (replacedDocumentation.has(file)) return { status, file, classification: 'REPLACED_DOCUMENT' };
    if (!intentionallyDeleted(file)) throw new Error(`unclassified deletion: ${file}`);
    return { status, file, classification: 'INTENTIONAL_DELETE' };
  }
  if (status === ' M' || status === 'M ' || status === 'MM') {
    if (!modifiedFiles.has(file)) throw new Error(`unclassified modification: ${file}`);
    return { status, file, classification: 'KEEP_MODIFIED' };
  }
  if (status === '??') {
    if (replacedDocumentation.has(file)) return { status, file, classification: 'REPLACED_DOCUMENT' };
    if (!addedFiles.some((pattern) => pattern.test(file))) throw new Error(`unclassified addition: ${file}`);
    return { status, file, classification: 'INTENDED_ADD' };
  }
  throw new Error(`unsupported worktree status ${status} for ${file}`);
});

const counts = classified.reduce((result, item) => {
  result[item.classification] = (result[item.classification] || 0) + 1;
  return result;
}, {});

console.log(JSON.stringify({ ok: true, counts, files: classified }, null, 2));
