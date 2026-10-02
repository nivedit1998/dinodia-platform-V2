import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRef = "fppzzesvukjbsfmxmfxe";

export function databaseProjectRef(raw, target) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) return null;
  const direct = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)?.[1];
  if (direct) return direct.toLowerCase();
  if (!target.supabaseDatabaseHosts.includes(url.hostname.toLowerCase())) return null;
  if (!/\.pooler\.supabase\.com$/i.test(url.hostname)) return null;
  const username = decodeURIComponent(url.username || "");
  return username.match(/^(?:postgres\.)?([a-z0-9]{20})$/i)?.[1]?.toLowerCase() ?? null;
}

export function validateReadOnlyProductionTargets({ databaseUrl, directUrl, target }) {
  if (target.supabaseProjectRef !== projectRef) throw new Error("approved project manifest mismatch");
  const urls = [databaseUrl, directUrl].map((raw, index) => {
    const label = index === 0 ? "DATABASE_URL" : "DIRECT_URL";
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`${label} is missing or invalid`);
    }
    if (!target.supabaseDatabaseHosts.includes(parsed.hostname.toLowerCase())) {
      throw new Error(`${label} is not on an approved V2 database host`);
    }
    if (databaseProjectRef(raw, target) !== projectRef) {
      throw new Error(`${label} does not identify the approved V2 project`);
    }
    if (!["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode"))) {
      throw new Error(`${label} must require TLS`);
    }
    return parsed;
  });
  const databaseNames = urls.map((url) => decodeURIComponent(url.pathname.replace(/^\/+/, "")));
  if (!databaseNames[0] || databaseNames[0] !== databaseNames[1]) {
    throw new Error("DATABASE_URL and DIRECT_URL must target the same database");
  }
  return urls[1];
}

export function localTopology(sourceRoot, { edgeWorkerConfigPath = path.resolve(sourceRoot, "../dinodia-edge-worker-V2/wrangler.toml") } = {}) {
  const vercel = JSON.parse(fs.readFileSync(path.join(sourceRoot, "vercel.json"), "utf8"));
  const crons = Array.isArray(vercel.crons) ? vercel.crons : [];
  const expectedDaily = crons.length === 1
    && crons[0].schedule === "0 3 * * *"
    && crons[0].path === "/api/cron/native-maintenance";
  const workerConfig = fs.readFileSync(edgeWorkerConfigPath, "utf8");
  const hasEdgeCron = /^\s*crons\s*=|^\s*\[triggers\]/m.test(workerConfig);
  return {
    vercelCronCount: crons.length,
    vercelDailyMaintenance: expectedDaily,
    edgeCronConfigured: hasEdgeCron,
    vercelSchedules: crons.map(({ path: route, schedule }) => ({ path: route, schedule })),
  };
}

export function summarizeHubRuntime(rows) {
  return rows.map((row) => {
    const packageVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(row.runtime_version ?? "");
    return {
      state: row.state,
      lanEndpointState: row.lan_endpoint_state,
      reportedPackageVersion: packageVersion ? row.runtime_version : null,
      unrecognizedRuntimeVersionPresent: row.runtime_version != null && !packageVersion,
      runtimeVersionFingerprint: row.runtime_version != null && !packageVersion
        ? crypto.createHash("sha256").update(row.runtime_version).digest("hex").slice(0, 16)
        : null,
      cloudUrlVerified: row.cloud_url_verified === true,
      count: row.count,
      maxLanRevision: row.max_lan_revision,
      latestHeartbeatAgeSeconds: row.latest_heartbeat == null ? null : Math.max(0, Math.floor((Date.now() - new Date(row.latest_heartbeat).getTime()) / 1000)),
    };
  });
}

async function optionalRead(tx, savepoint, query) {
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  try {
    const value = await query();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return { readable: true, value };
  } catch {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return { readable: false, value: null };
  }
}

function migrationSourceChecksums(sourceRoot) {
  const directory = path.join(sourceRoot, "prisma/migrations");
  return new Map(fs.readdirSync(directory).filter((name) => /^\d/.test(name)).sort().map((name) => {
    const sql = fs.readFileSync(path.join(directory, name, "migration.sql"));
    return [name, crypto.createHash("sha256").update(sql).digest("hex")];
  }));
}

export async function collectReadOnlyInventory(client, { sourceRoot, target, edgeWorkerConfigPath }) {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

    const migrations = await tx.$queryRawUnsafe(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM public."_prisma_migrations"',
    );
    const expectedChecksums = migrationSourceChecksums(sourceRoot);
    const applied = migrations.filter((row) => row.finished_at && !row.rolled_back_at);
    const migrationMismatches = applied
      .filter((row) => expectedChecksums.get(row.migration_name) !== row.checksum)
      .map((row) => row.migration_name);
    const missingMigrations = [...expectedChecksums.keys()].filter((name) => !applied.some((row) => row.migration_name === name));
    const checksumLedger = applied.map((row) => `${row.migration_name}:${row.checksum}`).sort().join("\n");

    const [homeStates, hubStates, identityStates, credentialStates, anonymousGrants] = await Promise.all([
      tx.$queryRawUnsafe('SELECT lifecycle::text AS lifecycle, "installationStatus"::text AS installation_status, count(*)::int AS count FROM public."Home" GROUP BY lifecycle, "installationStatus" ORDER BY lifecycle, "installationStatus"'),
      tx.$queryRawUnsafe('SELECT state::text AS state, "lanEndpointState" AS lan_endpoint_state, "runtimeVersion" AS runtime_version, bool_or("cloudUrlVerifiedAt" IS NOT NULL) AS cloud_url_verified, count(*)::int AS count, max("lanEndpointRevision")::int AS max_lan_revision, max("lastSeenAt") AS latest_heartbeat FROM public."HubInstallation" GROUP BY state, "lanEndpointState", "runtimeVersion" ORDER BY state, "lanEndpointState", "runtimeVersion"'),
      tx.$queryRawUnsafe('SELECT status::text AS status, "identityGeneration" AS generation, count(*)::int AS count FROM public."HubManufacturingIdentity" GROUP BY status, "identityGeneration" ORDER BY status, "identityGeneration"'),
      tx.$queryRawUnsafe('SELECT purpose, state::text AS state, count(*)::int AS count FROM public."HubCredentialVersion" GROUP BY purpose, state ORDER BY purpose, state'),
      tx.$queryRawUnsafe("SELECT grantee, privilege_type, count(*)::int AS count FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC') GROUP BY grantee, privilege_type ORDER BY grantee, privilege_type"),
    ]);

    const cronAvailability = await tx.$queryRawUnsafe("SELECT to_regclass('cron.job') IS NOT NULL AS available");
    let cron = { readable: false, value: null };
    if (cronAvailability[0]?.available) {
      cron = await optionalRead(tx, "safe_cron_inventory", () => tx.$queryRawUnsafe(
        "SELECT count(*) FILTER (WHERE active)::int AS active_jobs, count(*) FILTER (WHERE active AND schedule = '*/2 * * * *')::int AS active_two_minute_jobs, count(*) FILTER (WHERE active AND jobname = 'dinodia-native-operations' AND schedule = '*/2 * * * *')::int AS expected_dispatch_jobs, count(*) FILTER (WHERE active AND jobname = 'dinodia-native-operations' AND schedule = '*/2 * * * *' AND position('DINODIA_NATIVE_OPERATIONS_URL' in command) > 0 AND position('DINODIA_NATIVE_OPERATIONS_CRON_SECRET' in command) > 0)::int AS correctly_referenced_dispatch_jobs FROM cron.job",
      ));
    }

    const vaultAvailability = await tx.$queryRawUnsafe("SELECT to_regclass('vault.secrets') IS NOT NULL AS secrets_available, to_regclass('vault.decrypted_secrets') IS NOT NULL AS decrypted_view_available");
    const vault = { readable: false, value: null };
    if (vaultAvailability[0]?.secrets_available && vaultAvailability[0]?.decrypted_view_available) {
      const result = await optionalRead(tx, "safe_vault_reference_inventory", () => tx.$queryRawUnsafe(
        "SELECT count(*) FILTER (WHERE name = 'DINODIA_NATIVE_OPERATIONS_URL')::int AS url_reference_present, count(*) FILTER (WHERE name = 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')::int AS secret_reference_present FROM vault.secrets WHERE name IN ('DINODIA_NATIVE_OPERATIONS_URL', 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')",
      ));
      const decryptedRefs = await optionalRead(tx, "safe_vault_decrypted_reference_inventory", () => tx.$queryRawUnsafe(
        "SELECT count(*) FILTER (WHERE name = 'DINODIA_NATIVE_OPERATIONS_URL')::int AS url_reference_present, count(*) FILTER (WHERE name = 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')::int AS secret_reference_present FROM vault.decrypted_secrets WHERE name IN ('DINODIA_NATIVE_OPERATIONS_URL', 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')",
      ));
      vault.readable = result.readable && decryptedRefs.readable;
      if (vault.readable) vault.value = { stored: result.value[0], decryptedViewReferences: decryptedRefs.value[0] };
    }

    const local = localTopology(sourceRoot, { edgeWorkerConfigPath });
    const productionOperation = cron.value?.[0] ?? null;
    const vaultRefs = vault.value?.stored;
    const decryptedRefs = vault.value?.decryptedViewReferences;
    const safeHubStates = summarizeHubRuntime(hubStates);
    const safeIdentities = identityStates.map((row) => ({ status: row.status, generation: row.generation, count: row.count }));

    return {
      targetProjectRef: target.supabaseProjectRef,
      localTopology: local,
      schema: {
        publicBaseTableCount: Number((await tx.$queryRawUnsafe("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"))[0].count),
        migrationCount: applied.length,
        localMigrationCount: expectedChecksums.size,
        migrationMismatches,
        missingMigrations,
        appliedMigrationLedgerSha256: crypto.createHash("sha256").update(checksumLedger).digest("hex"),
      },
      grants: anonymousGrants.map((row) => ({ grantee: row.grantee, privilege: row.privilege_type, count: row.count })),
      installation: {
        homesByLifecycle: homeStates.map((row) => ({ lifecycle: row.lifecycle, installationStatus: row.installation_status, count: row.count })),
        hubsByState: safeHubStates,
        identitiesByStateAndGeneration: safeIdentities,
        credentialPurposeStates: credentialStates.map((row) => ({ purpose: row.purpose, state: row.state, count: row.count })),
      },
      scheduler: {
        cronCatalogAvailable: Boolean(cronAvailability[0]?.available),
        cronInventoryReadable: cron.readable,
        activeJobs: productionOperation?.active_jobs ?? null,
        activeTwoMinuteJobs: productionOperation?.active_two_minute_jobs ?? null,
        expectedOperationsDispatchJobs: productionOperation?.expected_dispatch_jobs ?? null,
        dispatchReferencesMatch: productionOperation?.correctly_referenced_dispatch_jobs === 1,
        vaultCatalogAvailable: Boolean(vaultAvailability[0]?.secrets_available && vaultAvailability[0]?.decrypted_view_available),
        vaultReferenceInventoryReadable: vault.readable,
        vaultUrlReferencePresent: vaultRefs ? Number(vaultRefs.url_reference_present) > 0 : null,
        vaultSecretReferencePresent: vaultRefs ? Number(vaultRefs.secret_reference_present) > 0 : null,
        decryptedUrlReferencePresent: decryptedRefs ? Number(decryptedRefs.url_reference_present) > 0 : null,
        decryptedSecretReferencePresent: decryptedRefs ? Number(decryptedRefs.secret_reference_present) > 0 : null,
      },
    };
  }, { maxWait: 10000, timeout: 30000 });
}

async function main() {
  const args = process.argv.slice(2);
  const confirmationArgs = args.filter((arg) => arg.startsWith("--confirm-project="));
  if (args.length !== 1 || confirmationArgs.length !== 1 || confirmationArgs[0] !== `--confirm-project=${projectRef}`) {
    throw new Error(`read-only inventory requires --confirm-project=${projectRef}`);
  }
  const target = JSON.parse(fs.readFileSync(path.join(root, "scripts/v2-target.json"), "utf8"));
  if (target.supabaseProjectRef !== projectRef) throw new Error("approved project manifest mismatch");
  const localEnvPath = path.join(root, ".env.local");
  if (!fs.existsSync(localEnvPath)) throw new Error("project-local environment file is unavailable");
  const fileEnv = dotenv.parse(fs.readFileSync(localEnvPath));
  const databaseUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
  const directUrl = process.env.DIRECT_URL || fileEnv.DIRECT_URL;
  const safeUrl = validateReadOnlyProductionTargets({ databaseUrl, directUrl, target });
  const client = new PrismaClient({ datasourceUrl: safeUrl.toString(), log: [] });
  try {
    const inventory = await collectReadOnlyInventory(client, { sourceRoot: root, target });
    console.log(JSON.stringify(inventory, null, 2));
    if (inventory.schema.migrationMismatches.length || inventory.schema.missingMigrations.length
      || !inventory.localTopology.vercelDailyMaintenance || inventory.localTopology.edgeCronConfigured
      || !inventory.scheduler.cronInventoryReadable || inventory.scheduler.activeJobs !== 1 || inventory.scheduler.activeTwoMinuteJobs !== 1
      || inventory.scheduler.expectedOperationsDispatchJobs !== 1 || !inventory.scheduler.dispatchReferencesMatch
      || !inventory.scheduler.vaultReferenceInventoryReadable || !inventory.scheduler.vaultUrlReferencePresent
      || !inventory.scheduler.vaultSecretReferencePresent || !inventory.scheduler.decryptedUrlReferencePresent
      || !inventory.scheduler.decryptedSecretReferencePresent) process.exitCode = 2;
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safeCode = typeof error?.code === "string" ? error.code : "READ_ONLY_INVENTORY_FAILED";
    console.error(JSON.stringify({ ok: false, errorCode: safeCode }));
    process.exitCode = 1;
  });
}
