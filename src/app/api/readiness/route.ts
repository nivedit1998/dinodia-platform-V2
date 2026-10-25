import { COMPATIBLE_ADDITIVE_MIGRATIONS, isCanonicalProductionOriginValid, isRuntimeTargetValid, isSchemaReady, safeBuildId } from '@/lib/foundation';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    if (!isRuntimeTargetValid() || !isCanonicalProductionOriginValid()) {
      return Response.json({ ok: false, ready: false, service: 'dinodia-platform-v2' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    await prisma.$queryRaw`SELECT 1`;
    const expectedMigrationChecksum = process.env.FOUNDATION_MIGRATION_CHECKSUM?.trim();
    if (!expectedMigrationChecksum) {
      return Response.json({ ok: false, ready: false, service: 'dinodia-platform-v2' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const migration = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string }>>`SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC`;
    const modelCount = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    const logicalMigration = '20261025010000_logical_device_parents';
    const logicalChecksum = COMPATIBLE_ADDITIVE_MIGRATIONS[logicalMigration];
    const logicalSchemaReady = migration.some(row => row.migration_name === logicalMigration && row.checksum === logicalChecksum);
    const calendarName = '20261025140000_calendar_daily_analytics';
    const calendarSchemaReady = migration.some(row => row.migration_name === calendarName && row.checksum === COMPATIBLE_ADDITIVE_MIGRATIONS[calendarName]);
    const ready = logicalSchemaReady && (process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED !== 'true' || calendarSchemaReady)
      && isSchemaReady(migration, Number(modelCount[0]?.count ?? 0), expectedMigrationChecksum);
    return Response.json({ ok: ready, ready, service: 'dinodia-platform-v2', build: safeBuildId(),
      logicalDevicesContractVersion: logicalSchemaReady ? 1 : null,
      logicalDevicesSchemaChecksum: logicalSchemaReady ? logicalChecksum : null,
      logicalDevicesEnabled: process.env.DINODIA_LOGICAL_DEVICES_ENABLED === 'true',
      analyticsHistoryContractVersion: calendarSchemaReady ? 1 : null,
      analyticsHistoryEnabled: process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED === 'true',
      analyticsUsagePolicyVersion: ready && migration.some(row => row.migration_name === '20261024103000_state_evidence_policy') ? 3
        : ready && migration.some(row => row.migration_name === '20261023110000_category_analytics_intervals') ? 2 : null,
    }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, ready: false, service: 'dinodia-platform-v2' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
