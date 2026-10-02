import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { databaseProjectRef, localTopology, summarizeHubRuntime, validateReadOnlyProductionTargets, collectReadOnlyInventory } from "../scripts/read_only_production_inventory.mjs";

const target = {
  supabaseProjectRef: "fppzzesvukjbsfmxmfxe",
  supabaseDatabaseHosts: ["db.fppzzesvukjbsfmxmfxe.supabase.co", "aws-0-eu-west-2.pooler.supabase.com"],
};

test("read-only inventory accepts only TLS connections bound to the approved V2 project and database", () => {
  const direct = "postgresql://postgres:private@db.fppzzesvukjbsfmxmfxe.supabase.co:5432/postgres?sslmode=require";
  const pooled = "postgresql://postgres.fppzzesvukjbsfmxmfxe:private@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";
  assert.equal(databaseProjectRef(direct, target), target.supabaseProjectRef);
  assert.equal(databaseProjectRef(pooled, target), target.supabaseProjectRef);
  assert.equal(validateReadOnlyProductionTargets({ databaseUrl: direct, directUrl: pooled, target }).hostname, "aws-0-eu-west-2.pooler.supabase.com");
  for (const rejected of [
    ["postgresql://postgres:private@db.otherproject0000000000.supabase.co:5432/postgres?sslmode=require", pooled],
    [direct, "postgresql://postgres.otherproject0000000000:private@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require"],
    [direct.replace("?sslmode=require", ""), pooled],
    [direct.replace("/postgres?", "/different?"), pooled],
    ["https://db.fppzzesvukjbsfmxmfxe.supabase.co/postgres", pooled],
  ]) assert.throws(() => validateReadOnlyProductionTargets({ databaseUrl: rejected[0], directUrl: rejected[1], target }));
});

test("read-only inventory opens an explicitly read-only transaction and never selects secret values", async (t) => {
  const sourceRoot = path.resolve(".");
  const workerFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-stage2-worker-config-"));
  t.after(() => fs.rmSync(workerFixtureRoot, { recursive: true, force: true }));
  const edgeWorkerConfigPath = path.join(workerFixtureRoot, "wrangler.toml");
  fs.writeFileSync(edgeWorkerConfigPath, 'name = "fixture-worker"\n');
  const statements = [];
  const fakeTx = {
    async $executeRawUnsafe(sql) { statements.push(sql); return 0; },
    async $queryRawUnsafe(sql) {
      statements.push(sql);
      if (sql.includes("_prisma_migrations")) return [];
      if (sql.includes("to_regclass('cron.job')")) return [{ available: false }];
      if (sql.includes("to_regclass('vault.secrets')")) return [{ secrets_available: false, decrypted_view_available: false }];
      if (sql.includes("information_schema.tables")) return [{ count: 44 }];
      return [];
    },
  };
  const fakeClient = { async $transaction(callback) { return callback(fakeTx); } };
  const result = await collectReadOnlyInventory(fakeClient, { sourceRoot, target, edgeWorkerConfigPath });
  assert.equal(statements[0], "SET TRANSACTION READ ONLY");
  assert.equal(result.targetProjectRef, target.supabaseProjectRef);
  assert.equal(result.schema.publicBaseTableCount, 44);
  assert.ok(statements.every((sql) => !/SELECT\s+[^;]*decrypted_secret\b/i.test(sql)));
  assert.ok(statements.every((sql) => !/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i.test(sql)));
});

test("local scheduler evidence requires one daily Vercel maintenance schedule and no Worker cron", (t) => {
  const workerFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dinodia-stage2-worker-config-"));
  t.after(() => fs.rmSync(workerFixtureRoot, { recursive: true, force: true }));
  const edgeWorkerConfigPath = path.join(workerFixtureRoot, "wrangler.toml");
  fs.writeFileSync(edgeWorkerConfigPath, 'name = "fixture-worker"\n');
  const result = localTopology(path.resolve("."), { edgeWorkerConfigPath });
  assert.equal(result.vercelCronCount, 1);
  assert.equal(result.vercelDailyMaintenance, true);
  assert.equal(result.edgeCronConfigured, false);
});

test("hub runtime evidence separates the package version from build IDs and redacts unknown values", () => {
  const rows = summarizeHubRuntime([
    { state: "ACTIVE", lan_endpoint_state: "CURRENT", runtime_version: "0.1.0", cloud_url_verified: true, count: 1, max_lan_revision: 3, latest_heartbeat: new Date() },
    { state: "PROVISIONED", lan_endpoint_state: "CURRENT", runtime_version: "unrecognized-private-value", cloud_url_verified: true, count: 1, max_lan_revision: 5, latest_heartbeat: new Date() },
  ]);
  assert.equal(rows[0].reportedPackageVersion, "0.1.0");
  assert.equal(rows[0].unrecognizedRuntimeVersionPresent, false);
  assert.equal(rows[1].reportedPackageVersion, null);
  assert.equal(rows[1].unrecognizedRuntimeVersionPresent, true);
  assert.equal(rows[1].runtimeVersionFingerprint.length, 16);
  assert.equal(JSON.stringify(rows).includes("unrecognized-private-value"), false);
});
