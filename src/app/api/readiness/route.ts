import { REQUIRED_MIGRATION, REQUIRED_MODEL_COUNT, isCanonicalProductionOriginValid, isRuntimeTargetValid, safeBuildId } from '@/lib/foundation';
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
    const migration = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string }>>`SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`;
    const modelCount = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    const ready = migration[0]?.migration_name === REQUIRED_MIGRATION
      && migration[0]?.checksum === expectedMigrationChecksum
      && Number(modelCount[0]?.count ?? 0) === REQUIRED_MODEL_COUNT;
    return Response.json({ ok: ready, ready, service: 'dinodia-platform-v2', build: safeBuildId() }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, ready: false, service: 'dinodia-platform-v2' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
