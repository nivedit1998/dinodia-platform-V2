// Architecture: Shared platform helper src/lib/electricUsageCompaction.ts; compacts verified electric detail without double-counting on retries.
import { prisma } from '@/lib/prisma';
import { DETAIL_RETENTION_DAYS, localDateKey, normalizeTimeZone, readElectricUsageConfig, splitElectricUsageRowByLocalDay } from '@/lib/electricUsageConfig';

const BATCH_SIZE = 10_000;

type Aggregate = {
  haConnectionId: number;
  entityId: string;
  entityName: string | null;
  trackingEpoch: string;
  assignmentEpoch: string;
  sourceAreaId: string | null;
  sourceAreaName: string | null;
  localDate: string;
  timeZone: string;
  onForSeconds: number;
  offForSeconds: number;
  unknownForSeconds: number;
  estimatedKwh: number | null;
  estimatedCostGbp: number | null;
  averageWattsApplied: number | null;
  electricPricePerKwh: number | null;
  configurationMixed: boolean;
};

function addNullable(left: number | null, right: number | null) {
  return left == null || right == null ? null : left + right;
}

export async function compactElectricUsageDetail(now = new Date()) {
  const cutoff = new Date(now.getTime() - DETAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let compactedRows = 0;
  let rollupsWritten = 0;
  let deletedRows = 0;

  while (true) {
    const readings = await prisma.electricUsageReading.findMany({
      where: { windowEndedAt: { lt: cutoff } },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    if (!readings.length) break;
    const connectionIds = Array.from(new Set(readings.map((reading) => reading.haConnectionId)));
    const homes = await prisma.home.findMany({ where: { haConnectionId: { in: connectionIds } }, select: { haConnectionId: true, timeZone: true } });
    const timeZoneByConnection = new Map(homes.map((home) => [home.haConnectionId, normalizeTimeZone(home.timeZone)]));
    const groups = new Map<string, Aggregate>();
    for (const reading of readings) {
      const timeZone = timeZoneByConnection.get(reading.haConnectionId) || 'Europe/London';
      const segments = splitElectricUsageRowByLocalDay(reading, timeZone);
      for (const segment of segments) {
        const key = [reading.haConnectionId, reading.entityId, segment.localDate, reading.assignmentEpoch].join('|');
        const existing = groups.get(key);
        if (existing) {
          existing.onForSeconds += segment.onForSeconds;
          existing.offForSeconds += segment.offForSeconds;
          existing.unknownForSeconds += segment.unknownForSeconds;
          existing.estimatedKwh = addNullable(existing.estimatedKwh, segment.estimatedKwh);
          existing.estimatedCostGbp = addNullable(existing.estimatedCostGbp, segment.estimatedCostGbp);
          const sameWatts = existing.averageWattsApplied === reading.averageWattsApplied;
          const samePrice = existing.electricPricePerKwh === reading.electricPricePerKwh;
          existing.configurationMixed = existing.configurationMixed || !sameWatts || !samePrice;
          if (!sameWatts) existing.averageWattsApplied = null;
          if (!samePrice) existing.electricPricePerKwh = null;
        } else {
          groups.set(key, {
            haConnectionId: reading.haConnectionId,
            entityId: reading.entityId,
            entityName: reading.entityName,
            trackingEpoch: reading.trackingEpoch,
            assignmentEpoch: reading.assignmentEpoch,
            sourceAreaId: reading.sourceAreaId,
            sourceAreaName: reading.sourceAreaName,
            localDate: segment.localDate,
            timeZone,
            onForSeconds: segment.onForSeconds,
            offForSeconds: segment.offForSeconds,
            unknownForSeconds: segment.unknownForSeconds,
            estimatedKwh: segment.estimatedKwh,
            estimatedCostGbp: segment.estimatedCostGbp,
            averageWattsApplied: reading.averageWattsApplied,
            electricPricePerKwh: reading.electricPricePerKwh,
            configurationMixed: false,
          });
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const aggregate of groups.values()) {
        const existing = await tx.electricUsageDailyRollup.findUnique({
          where: {
            haConnectionId_entityId_localDate_assignmentEpoch: {
              haConnectionId: aggregate.haConnectionId,
              entityId: aggregate.entityId,
              localDate: aggregate.localDate,
              assignmentEpoch: aggregate.assignmentEpoch,
            },
          },
        });
        const sameWatts = existing && !existing.configurationMixed && !aggregate.configurationMixed && existing.averageWattsApplied === aggregate.averageWattsApplied;
        const samePrice = existing && !existing.configurationMixed && !aggregate.configurationMixed && existing.electricPricePerKwh === aggregate.electricPricePerKwh;
        const merged = existing ? {
          entityId: aggregate.entityId,
          assignmentEpoch: aggregate.assignmentEpoch,
          localDate: aggregate.localDate,
          timeZone: aggregate.timeZone,
          haConnection: { connect: { id: aggregate.haConnectionId } },
          entityName: aggregate.entityName || existing.entityName,
          trackingEpoch: aggregate.trackingEpoch,
          sourceAreaId: aggregate.sourceAreaId,
          sourceAreaName: aggregate.sourceAreaName,
          onForSeconds: existing.onForSeconds + aggregate.onForSeconds,
          offForSeconds: existing.offForSeconds + aggregate.offForSeconds,
          unknownForSeconds: existing.unknownForSeconds + aggregate.unknownForSeconds,
          estimatedKwh: addNullable(existing.estimatedKwh, aggregate.estimatedKwh),
          estimatedCostGbp: addNullable(existing.estimatedCostGbp, aggregate.estimatedCostGbp),
          averageWattsApplied: sameWatts ? aggregate.averageWattsApplied : null,
          electricPricePerKwh: samePrice ? aggregate.electricPricePerKwh : null,
          configurationMixed: Boolean(existing.configurationMixed || aggregate.configurationMixed || !sameWatts || !samePrice),
        } : aggregate;
        await tx.electricUsageDailyRollup.upsert({
          where: {
            haConnectionId_entityId_localDate_assignmentEpoch: {
              haConnectionId: aggregate.haConnectionId,
              entityId: aggregate.entityId,
              localDate: aggregate.localDate,
              assignmentEpoch: aggregate.assignmentEpoch,
            },
          },
          create: merged,
          update: merged,
        });
        rollupsWritten += 1;
      }
      const ids = readings.map((reading) => reading.id);
      const deleted = await tx.electricUsageReading.deleteMany({ where: { id: { in: ids }, windowEndedAt: { lt: cutoff } } });
      deletedRows += deleted.count;
    });
    compactedRows += readings.length;
    if (readings.length < BATCH_SIZE) break;
  }

  const dailyCutoff = new Date(now.getTime());
  dailyCutoff.setUTCFullYear(dailyCutoff.getUTCFullYear() - 7);
  const expiredDaily = await prisma.electricUsageDailyRollup.deleteMany({ where: { localDate: { lt: localDateKey(dailyCutoff, 'UTC') } } });
  return { cutoff: cutoff.toISOString(), compactedRows, rollupsWritten, deletedRows, expiredDailyRows: expiredDaily.count, config: readElectricUsageConfig() };
}
