import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { assertMigrationDoesNotReferenceVolatileRuntimeTables, compareExistingTablePreservation } from './native_migration_preservation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRef = 'fppzzesvukjbsfmxmfxe';
const target = JSON.parse(fs.readFileSync(path.join(root, 'scripts/v2-target.json'), 'utf8'));
const envFile = dotenv.parse(fs.readFileSync(path.join(root, '.env.local')));
const databaseUrl = process.env.DATABASE_URL || envFile.DATABASE_URL || '';
const directUrl = process.env.DIRECT_URL || envFile.DIRECT_URL || '';
const flags = new Set(process.argv.slice(2));
const stage4LanTls = flags.has('--stage4-lan-tls');
const stage5Sync = flags.has('--stage5-sync');
const stage5IncidentDeadlines = flags.has('--stage5-incident-deadlines');
const stage5Target = stage5Sync || stage5IncidentDeadlines;
const migrationName = stage5IncidentDeadlines
  ? '20261005070000_stage5_hub_incident_deadline'
  : stage5Sync ? '20261004150000_stage5_hub_sync_v2'
  : stage4LanTls ? '20261004050000_stage4_customer_lan_tls_identity' : '20261003000000_native_v2_stage3_domain_schema';
const migrationPath = path.join(root, 'prisma/migrations', migrationName, 'migration.sql');
const confirm = `--confirm-project=${projectRef}`;
const expectedShaFlag = process.argv.slice(2).find((value) => value.startsWith('--expected-migration-sha256='));
const apply = flags.has('--apply');
const authorizedApply = flags.has('--confirm-additive-forward-migration');

function fail(reason) { throw new Error(`[stage${stage5Target ? '5' : stage4LanTls ? '4' : '3'}:target] BLOCKED: ${reason}`); }
function safeError(value) { return String(value).replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, '<database-url-redacted>'); }
function parseUrl(raw, label) {
  let url;
  try { url = new URL(raw); } catch { fail(`${label} is missing or invalid`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail(`${label} is not PostgreSQL`);
  if (!target.supabaseDatabaseHosts.includes(url.hostname.toLowerCase())) fail(`${label} is not on an approved V2 database host`);
  if (!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) fail(`${label} must require TLS`);
  const direct = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)?.[1]?.toLowerCase();
  const pooled = /\.pooler\.supabase\.com$/i.test(url.hostname)
    ? decodeURIComponent(url.username || '').match(/^(?:postgres\.)?([a-z0-9]{20})$/i)?.[1]?.toLowerCase()
    : null;
  if ((direct || pooled) !== projectRef) fail(`${label} does not resolve to the exact approved V2 project`);
  return url;
}
function migrationChecksums() {
  const directory = path.join(root, 'prisma/migrations');
  return new Map(fs.readdirSync(directory).filter((name) => /^\d/.test(name)).sort().map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name, 'migration.sql'))).digest('hex')]));
}
function runFingerprint(env) {
  const result = spawnSync('node', ['scripts/schema_fingerprint.mjs'], { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) fail(`schema fingerprint failed: ${safeError(result.stderr || result.stdout)}`);
  try { return JSON.parse(result.stdout.trim()).fingerprint; } catch { fail('schema fingerprint output is invalid'); }
}

async function inventory(client, baselineColumns = undefined) {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const tables = await tx.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name");
    const rowCounts = {};
    const rowContentDigests = {};
    const columnContentDigests = {};
    const columnsByTable = {};
    for (const { table_name } of tables) {
      const identifier = `"${String(table_name).replaceAll('"', '""')}"`;
      const rows = await tx.$queryRawUnsafe(`SELECT count(*)::text AS count FROM public.${identifier}`);
      rowCounts[table_name] = rows[0].count;
      const describedColumns = await tx.$queryRawUnsafe('SELECT column_name FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = $1 ORDER BY ordinal_position', table_name);
      const columns = baselineColumns?.[table_name] ?? describedColumns.map((row) => row.column_name);
      columnsByTable[table_name] = columns;
      // Build the projected row from to_jsonb(record), rather than passing two
      // arguments per column to jsonb_build_object. HubInstallation is now
      // wide enough to exceed PostgreSQL's 100-function-argument limit.
      const columnNames = columns.map((column) => `'${String(column).replaceAll("'", "''")}'`).join(',');
      const rowJson = `(SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each(to_jsonb(row_record)) WHERE key IN (${columnNames}))`;
      const content = await tx.$queryRawUnsafe(`SELECT md5(COALESCE(string_agg((${rowJson})::text, E'\\n' ORDER BY (${rowJson})::text), '')) AS digest FROM public.${identifier} AS row_record`);
      rowContentDigests[table_name] = content[0].digest;
      const columnDigestExpressions = columns.map((column) => {
        const jsonKey = String(column).replaceAll("'", "''");
        const alias = String(column).replaceAll('"', '""');
        const jsonValue = `to_jsonb(row_record)->'${jsonKey}'`;
        return `md5(COALESCE(jsonb_agg(${jsonValue} ORDER BY (${jsonValue})::text)::text, '[]')) AS "${alias}"`;
      });
      const columnContent = await tx.$queryRawUnsafe(`SELECT ${columnDigestExpressions.join(',')} FROM public.${identifier} AS row_record`);
      columnContentDigests[table_name] = columnContent[0];
    }
    const [labels, ownerCardinality, tenantOwners, activeAssignments, migrations, mismatchedDeviceHubs, mismatchedTenantGrants, mismatchedInvitationAreas, mismatchedRoomRequests, duplicateActiveRoomQrs, mismatchedClaimHubs, mismatchedClaimChallenges, mismatchedPendingSetups, mismatchedSupportMemberships, mismatchedSupportRequests, mismatchedSupportSessions, mismatchedSupportNotifications] = await Promise.all([
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."NativeDevice" WHERE "customerLabel" IS NOT NULL AND char_length("customerLabel") > 40'),
      tx.$queryRawUnsafe("SELECT count(*)::int AS count FROM public.\"Home\" h WHERE h.\"lifecycle\" = 'ACTIVE' AND (SELECT count(*) FROM public.\"HomeMembership\" m WHERE m.\"homeId\" = h.\"id\" AND m.\"role\" = 'OWNER' AND m.\"status\" = 'ACTIVE') <> 1"),
      tx.$queryRawUnsafe("SELECT count(*)::int AS count FROM public.\"NativeDevice\" d LEFT JOIN public.\"HomeMembership\" m ON m.\"id\" = d.\"ownerMembershipId\" AND m.\"homeId\" = d.\"homeId\" WHERE (d.\"managementClass\" = 'PROPERTY_DEVICE' AND d.\"ownerMembershipId\" IS NOT NULL) OR (d.\"managementClass\" = 'TENANT_DEVICE' AND (m.\"id\" IS NULL OR m.\"role\" <> 'TENANT' OR m.\"status\" <> 'ACTIVE'))"),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM (SELECT "deviceId" FROM public."DeviceAreaAssignment" WHERE "validUntil" IS NULL GROUP BY "deviceId" HAVING count(*) > 1) duplicates'),
      tx.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."NativeDevice" d LEFT JOIN public."HubInstallation" h ON h."id" = d."hubInstallationId" AND h."homeId" = d."homeId" WHERE h."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."TenantAreaGrant" g LEFT JOIN public."HomeMembership" m ON m."id" = g."membershipId" AND m."homeId" = g."homeId" LEFT JOIN public."Area" a ON a."id" = g."areaId" AND a."homeId" = g."homeId" WHERE m."id" IS NULL OR a."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."MembershipInvitationArea" x LEFT JOIN public."MembershipInvitation" i ON i."id" = x."invitationId" AND i."homeId" = x."homeId" LEFT JOIN public."Area" a ON a."id" = x."areaId" AND a."homeId" = x."homeId" WHERE i."id" IS NULL OR a."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."AreaAccessRequest" r LEFT JOIN public."Area" a ON a."id" = r."areaId" AND a."homeId" = r."homeId" LEFT JOIN public."AreaQrCredential" q ON q."id" = r."areaQrCredentialId" AND q."areaId" = r."areaId" WHERE a."id" IS NULL OR q."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM (SELECT "areaId" FROM public."AreaQrCredential" WHERE "status" = \'ACTIVE\' GROUP BY "areaId" HAVING count(*) > 1) duplicates'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."HomeClaimReference" c LEFT JOIN public."HubInstallation" h ON h."id" = c."hubInstallationId" AND h."homeId" = c."homeId" WHERE h."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."HomeClaimChallenge" c LEFT JOIN public."HomeClaimReference" r ON r."id" = c."claimReferenceId" AND r."hubInstallationId" = c."hubInstallationId" WHERE r."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."PendingHomeSetup" p LEFT JOIN public."HomeClaimReservation" r ON r."id" = p."reservationId" AND r."claimReferenceId" = p."claimReferenceId" AND r."customerAccountId" = p."customerAccountId" WHERE r."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."SupportTicket" t LEFT JOIN public."HomeMembership" m ON m."id" = t."selectedMembershipId" AND m."homeId" = t."homeId" AND m."customerAccountId" = t."customerAccountId" WHERE t."selectedMembershipId" IS NOT NULL AND m."id" IS NULL'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."SupportAccessRequest" r LEFT JOIN public."SupportTicket" t ON t."id" = r."ticketId" AND t."homeId" = r."homeId" LEFT JOIN public."HubInstallation" h ON h."id" = r."hubInstallationId" AND h."homeId" = r."homeId" LEFT JOIN public."HomeMembership" target ON target."id" = r."targetMembershipId" AND target."homeId" = r."homeId" LEFT JOIN public."HomeMembership" approver ON approver."id" = r."approvedByMembershipId" AND approver."homeId" = r."homeId" WHERE t."id" IS NULL OR h."id" IS NULL OR (r."targetMembershipId" IS NOT NULL AND target."id" IS NULL) OR (r."approvedByMembershipId" IS NOT NULL AND approver."id" IS NULL)'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."SupportSession" s LEFT JOIN public."SupportAccessRequest" r ON r."id" = s."accessRequestId" AND r."homeId" = s."homeId" LEFT JOIN public."SupportTicket" t ON t."id" = s."ticketId" AND t."homeId" = s."homeId" LEFT JOIN public."HubInstallation" h ON h."id" = s."hubInstallationId" AND h."homeId" = s."homeId" LEFT JOIN public."HomeMembership" m ON m."id" = s."targetMembershipId" AND m."homeId" = s."homeId" WHERE r."id" IS NULL OR t."id" IS NULL OR h."id" IS NULL OR (s."targetMembershipId" IS NOT NULL AND m."id" IS NULL)'),
      tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."SupportAccessNotification" n LEFT JOIN public."SupportTicket" t ON t."id" = n."ticketId" AND t."homeId" = n."homeId" LEFT JOIN public."SupportAccessRequest" r ON r."id" = n."accessRequestId" AND r."homeId" = n."homeId" LEFT JOIN public."SupportSession" s ON s."id" = n."sessionId" AND s."homeId" = n."homeId" WHERE t."id" IS NULL OR r."id" IS NULL OR (n."sessionId" IS NOT NULL AND s."id" IS NULL)'),
    ]);
    const dataPreflight = {
      customerLabelsOver40: labels[0].count,
      activeHomesWithoutExactlyOneOwner: ownerCardinality[0].count,
      invalidTenantDeviceOwners: tenantOwners[0].count,
      devicesWithMultipleOpenAreaAssignments: activeAssignments[0].count,
      deviceHubHomeMismatches: mismatchedDeviceHubs[0].count,
      tenantGrantHomeMismatches: mismatchedTenantGrants[0].count,
      invitationAreaHomeMismatches: mismatchedInvitationAreas[0].count,
      roomRequestAreaOrQrMismatches: mismatchedRoomRequests[0].count,
      duplicateActiveRoomQrCredentials: duplicateActiveRoomQrs[0].count,
      claimReferenceHubHomeMismatches: mismatchedClaimHubs[0].count,
      claimChallengeReferenceHubMismatches: mismatchedClaimChallenges[0].count,
      pendingSetupReservationMismatches: mismatchedPendingSetups[0].count,
      supportTicketSelectedMembershipMismatches: mismatchedSupportMemberships[0].count,
      supportRequestHomeMismatches: mismatchedSupportRequests[0].count,
      supportSessionHomeMismatches: mismatchedSupportSessions[0].count,
      supportNotificationHomeMismatches: mismatchedSupportNotifications[0].count,
    };
    return { rowCounts, rowContentDigests, columnContentDigests, columnsByTable, migrationRows: migrations, dataPreflight };
  }, { maxWait: 10000, timeout: 120000 });
}

let client;
try {
  const args = process.argv.slice(2);
  if ([stage4LanTls, stage5Sync, stage5IncidentDeadlines, flags.has('--stage3-domain-schema')].filter(Boolean).length > 1) fail('select exactly one reviewed migration target');
  if (!args.includes(confirm) || args.some((arg) => ![confirm, '--apply', '--confirm-additive-forward-migration', '--stage4-lan-tls', '--stage5-sync', '--stage5-incident-deadlines', '--stage3-domain-schema'].includes(arg) && !arg.startsWith('--expected-migration-sha256='))) fail(`pass ${confirm}; apply additionally requires the explicit additive-forward-migration confirmation`);
  if (target.supabaseProjectRef !== projectRef) fail('checked-in V2 target manifest does not match the authorized project');
  if (envFile.SUPABASE_PROJECT_REF !== projectRef || envFile.VERCEL_PROJECT_ID !== target.vercelProjectId) fail('project-local environment identity does not match the authorized V2 Production target');
  const db = parseUrl(databaseUrl, 'DATABASE_URL');
  const direct = parseUrl(directUrl, 'DIRECT_URL');
  if (decodeURIComponent(db.pathname) !== decodeURIComponent(direct.pathname)) fail('DATABASE_URL and DIRECT_URL target different databases');
  const migrationSha = crypto.createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
  assertMigrationDoesNotReferenceVolatileRuntimeTables(fs.readFileSync(migrationPath, 'utf8'));
  if (apply && (!authorizedApply || !expectedShaFlag || expectedShaFlag.slice('--expected-migration-sha256='.length) !== migrationSha)) fail('apply requires explicit authorization and the exact reviewed migration SHA-256');
  const projectFile = JSON.parse(fs.readFileSync(path.join(root, '.vercel/project.json'), 'utf8'));
  if (projectFile.projectId !== target.vercelProjectId || projectFile.orgId !== target.vercelOrgId) fail('linked Vercel project does not match the approved V2 target');
  if (apply) {
    const status = spawnSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
    if (status.status !== 0 || status.stdout.trim()) fail('Production apply requires the reviewed candidate committed with a clean worktree');
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', `prisma/migrations/${migrationName}/migration.sql`], { cwd: root, encoding: 'utf8' });
    if (tracked.status !== 0) fail('the exact migration artifact is not committed');
  }

  const connectionEnv = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl, PRISMA_TELEMETRY_DISABLED: '1' };
  client = new PrismaClient({ datasourceUrl: direct.toString(), log: [] });
  const beforeFingerprint = runFingerprint(connectionEnv);
  const before = await inventory(client);
  const checksums = migrationChecksums();
  const applied = before.migrationRows.filter((row) => row.finished_at && !row.rolled_back_at);
  const mismatched = applied.filter((row) => checksums.get(row.migration_name) !== row.checksum).map((row) => row.migration_name);
  const pending = [...checksums.keys()].filter((name) => !applied.some((row) => row.migration_name === name));
  if (mismatched.length) fail(`applied migration checksums disagree with reviewed source (${mismatched.length} mismatch(es))`);
  if (pending.some((name) => name !== migrationName)) fail(`unexpected pending migrations: ${pending.join(', ')}`);
  const unsafe = Object.values(before.dataPreflight).some((count) => Number(count) > 0);
  if (unsafe) fail(`existing Production data violates the native schema integrity preflight (${Object.entries(before.dataPreflight).filter(([, count]) => Number(count) > 0).map(([name]) => name).join(', ')})`);
  const rowCountDigest = crypto.createHash('sha256').update(JSON.stringify(Object.entries(before.rowCounts).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const rowContentPreservationDigest = crypto.createHash('sha256').update(JSON.stringify(Object.entries(before.rowContentDigests).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  console.log(JSON.stringify({
    ok: true,
    stage: stage5Target ? 5 : stage4LanTls ? 4 : 3,
    mode: apply ? 'production-additive-apply' : 'read-only-production-preflight',
    targetProjectRef: projectRef,
    databaseHostClass: db.hostname === direct.hostname ? 'same-approved-host' : 'approved-pooler-and-direct-hosts',
    migrationName,
    migrationSha256: migrationSha,
    pendingMigrationCount: pending.length,
    onlySelectedMigrationPending: pending.length === 0 || (pending.length === 1 && pending[0] === migrationName),
    priorSchemaFingerprint: beforeFingerprint,
    preMigrationBaseTableCount: Object.keys(before.rowCounts).length,
    preMigrationRowCountDigest: rowCountDigest,
    preMigrationRowContentDigest: rowContentPreservationDigest,
    preflightCounts: before.dataPreflight,
    rollback: 'application rollback to previous schema-compatible V2 deployment; migration is additive/forward-only; no reverse DROP migration',
  }, null, 2));

  if (apply && pending.length) {
    const migrationRun = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: root, env: connectionEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const output = safeError(`${migrationRun.stdout ?? ''}\n${migrationRun.stderr ?? ''}`).trim();
    if (output) console.log(output);
    if (migrationRun.status !== 0) fail(`Prisma migrate deploy failed with exit ${migrationRun.status ?? 1}; do not resolve migration state manually`);
  } else if (apply) {
    const replay = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: root, env: connectionEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const output = safeError(`${replay.stdout ?? ''}\n${replay.stderr ?? ''}`).trim();
    if (output) console.log(output);
    if (replay.status !== 0) fail(`idempotent migration replay failed with exit ${replay.status ?? 1}`);
  }

  if (apply) {
    const afterFingerprint = runFingerprint(connectionEnv);
    const after = await inventory(client, before.columnsByTable);
    let preservation;
    try { preservation = compareExistingTablePreservation(before, after); }
    catch (error) { fail(error instanceof Error ? error.message : 'existing Production rows changed'); }
    const { volatileChanges } = preservation;
    const appliedNow = after.migrationRows.filter((row) => row.finished_at && !row.rolled_back_at && row.migration_name === migrationName);
    const checksumMatch = appliedNow.length === 1 && appliedNow[0].checksum === migrationSha;
    if (!checksumMatch) fail('Production migration ledger does not contain the exact reviewed migration checksum');
    const postflightViolations = Object.entries(after.dataPreflight).filter(([, count]) => Number(count) > 0).map(([name]) => name);
    if (postflightViolations.length) fail(`post-migration integrity checks found violations (${postflightViolations.join(', ')})`);
    console.log(JSON.stringify({
      ok: true,
      stage: stage5Target ? 5 : stage4LanTls ? 4 : 3,
      migrationApplied: true,
      targetProjectRef: projectRef,
      migrationName,
      migrationSha256: migrationSha,
      priorSchemaFingerprint: beforeFingerprint,
      productionSchemaFingerprint: afterFingerprint,
      nonvolatileExistingTableRowCountsPreserved: true,
      volatileRuntimeTableChanges: volatileChanges,
      existingBaseTableCount: Object.keys(before.rowCounts).length,
      postMigrationBaseTableCount: Object.keys(after.rowCounts).length,
      migrationLedgerMatchesReviewedChecksum: checksumMatch,
      nonvolatileExistingRowContentPreserved: true,
      postMigrationRowContentDigest: crypto.createHash('sha256').update(JSON.stringify(Object.entries(after.rowContentDigests).sort(([a], [b]) => a.localeCompare(b)))).digest('hex'),
      postMigrationPreflightCounts: after.dataPreflight,
      rollback: 'Keep the additive schema and roll back application deployment to the recorded prior V2 release; do not issue destructive reverse SQL',
    }, null, 2));
  }
} catch (error) {
  console.error(safeError(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}
