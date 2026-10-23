// Read-only production data prerequisite (RB4). Never prints IDs or credentials.
import fs from 'node:fs';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { validateReadOnlyProductionTargets } from './read_only_production_inventory.mjs';
const args = process.argv.slice(2);
const envPath = args.find(value => value.startsWith('--env-file='))?.slice(11);
if (!envPath || !args.includes('--confirm-project=fppzzesvukjbsfmxmfxe')) throw new Error('Explicit approved project and maintained environment file required');
const env = dotenv.parse(fs.readFileSync(envPath));
const target = JSON.parse(fs.readFileSync(new URL('./v2-target.json', import.meta.url)));
validateReadOnlyProductionTargets({ databaseUrl: env.DATABASE_URL, directUrl: env.DIRECT_URL, target });
const client = new PrismaClient({ datasourceUrl: env.DIRECT_URL });
try {
  const result = await client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15000ms'");
    const overlap = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count FROM (
      SELECT a."deviceId", a."bucketStart" FROM "NativeDeviceUsageBucket" a
      JOIN "NativeDeviceUsageBucket" b ON a."deviceId" = b."deviceId" AND a.id < b.id
        AND a."sourceGeneration" = b."sourceGeneration"
        AND a."coverageStartAt" < b."coverageEndAt" AND a."coverageEndAt" > b."coverageStartAt"
      GROUP BY 1, 2) overlapping`);
    const migration = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "_prisma_migrations"
      WHERE migration_name = '20261023110000_category_analytics_intervals' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    return { readOnly: true, overlapDeviceHours: overlap[0].count, candidateMigrationApplied: migration[0].count === 1 };
  }, { timeout: 20000 });
  console.log(JSON.stringify(result));
  if (result.overlapDeviceHours) process.exitCode = 2;
} catch { console.error('Analytics preflight failed; inspect authorized database access privately. No credentials emitted.'); process.exitCode = 1; }
finally { await client.$disconnect(); }
