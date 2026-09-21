// Architecture: Shared platform helper src/lib/electricUsageMonitoring.ts; turns hub-side cumulative Light counters into bounded, idempotent history.
import { prisma } from '@/lib/prisma';
import {
  DETAIL_RETENTION_DAYS,
  estimateLightCostGbp,
  estimateLightKwh,
  localBucketKey,
  normalizeTimeZone,
  readElectricUsageConfig,
} from '@/lib/electricUsageConfig';

const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
const SNAPSHOT_TOLERANCE_SECONDS = 10 * 60;
const OFFLINE_GRACE_SECONDS = 5 * 60;

export type ElectricDelta = {
  onForSeconds: number;
  offForSeconds: number;
  unknownForSeconds: number;
};

function nonNegativeInt(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function normalizeElectricDelta(raw: ElectricDelta, intervalSeconds: number): ElectricDelta {
  const interval = Math.max(0, Math.floor(Number(intervalSeconds) || 0));
  const values = {
    onForSeconds: nonNegativeInt(raw.onForSeconds),
    offForSeconds: nonNegativeInt(raw.offForSeconds),
    unknownForSeconds: nonNegativeInt(raw.unknownForSeconds),
  };
  const total = values.onForSeconds + values.offForSeconds + values.unknownForSeconds;
  if (total <= interval) return values;
  if (interval === 0) return { onForSeconds: 0, offForSeconds: 0, unknownForSeconds: 0 };
  const scaled = [values.onForSeconds, values.offForSeconds, values.unknownForSeconds].map((value) => Math.floor((value * interval) / total));
  let remainder = interval - scaled.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < scaled.length && remainder > 0; i += 1, remainder -= 1) scaled[i] += 1;
  return { onForSeconds: scaled[0], offForSeconds: scaled[1], unknownForSeconds: scaled[2] };
}

function windowStartUtc(date: Date) {
  const ms = 2 * 60 * 60 * 1000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

function subtractCounter(current: unknown, previous: unknown) {
  const now = nonNegativeInt(current);
  const before = nonNegativeInt(previous);
  return now >= before ? now - before : null;
}

function applyOfflineGuard(delta: ElectricDelta, intervalSeconds: number, hubLastSeenAt: Date | null, now: Date): ElectricDelta {
  if (!hubLastSeenAt || !Number.isFinite(hubLastSeenAt.getTime())) return delta;
  const offlineSeconds = Math.max(0, Math.min(intervalSeconds, Math.floor((now.getTime() - hubLastSeenAt.getTime()) / 1000) - OFFLINE_GRACE_SECONDS));
  if (!offlineSeconds) return delta;
  const known = delta.onForSeconds + delta.offForSeconds;
  const removeOn = known ? Math.min(delta.onForSeconds, Math.floor((delta.onForSeconds / known) * offlineSeconds)) : 0;
  const removeOff = known ? Math.min(delta.offForSeconds, offlineSeconds - removeOn) : 0;
  return {
    onForSeconds: Math.max(0, delta.onForSeconds - removeOn),
    offForSeconds: Math.max(0, delta.offForSeconds - removeOff),
    unknownForSeconds: Math.min(intervalSeconds, delta.unknownForSeconds + removeOn + removeOff),
  };
}

function safeIso(value: Date | null | undefined) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

export async function captureElectricUsageSnapshotForConnection(haConnectionId: number, now = new Date()) {
  const capturedAt = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const [connection, accumulators] = await Promise.all([
    prisma.haConnection.findUnique({
      where: { id: haConnectionId },
      select: { id: true, home: { select: { timeZone: true, hubInstall: { select: { lastSeenAt: true } } } } },
    }),
    prisma.electricUsageAccumulator.findMany({
      where: { haConnectionId, retiredAt: null },
      orderBy: [{ entityId: 'asc' }],
    }),
  ]);
  if (!connection) return { haConnectionId, trackedCount: 0, insertedCount: 0 };

  const config = readElectricUsageConfig();
  const timeZone = normalizeTimeZone(connection.home?.timeZone);
  let insertedCount = 0;
  let skippedCount = 0;

  for (const accumulator of accumulators) {
    const currentOn = nonNegativeInt(accumulator.onSeconds);
    const currentOff = nonNegativeInt(accumulator.offSeconds);
    const currentUnknown = nonNegativeInt(accumulator.unknownSeconds);
    const hasCursor = accumulator.lastSnapshotAt instanceof Date &&
      accumulator.lastSnapshotOnSeconds != null && accumulator.lastSnapshotOffSeconds != null && accumulator.lastSnapshotUnknownSeconds != null;

    if (!hasCursor && !accumulator.trackingStartedAt) {
      await prisma.electricUsageAccumulator.update({
        where: { id: accumulator.id },
        data: { lastSnapshotOnSeconds: currentOn, lastSnapshotOffSeconds: currentOff, lastSnapshotUnknownSeconds: currentUnknown, lastSnapshotAt: capturedAt },
      });
      skippedCount += 1;
      continue;
    }

    const startAt = accumulator.lastSnapshotAt instanceof Date && Number.isFinite(accumulator.lastSnapshotAt.getTime())
      ? accumulator.lastSnapshotAt
      : accumulator.trackingStartedAt ?? new Date(capturedAt.getTime() - MAX_INTERVAL_SECONDS * 1000);
    const elapsed = Math.max(0, Math.floor((capturedAt.getTime() - startAt.getTime()) / 1000));
    const intervalSeconds = Math.min(MAX_INTERVAL_SECONDS + SNAPSHOT_TOLERANCE_SECONDS, elapsed);
    const rawOn = hasCursor ? subtractCounter(currentOn, accumulator.lastSnapshotOnSeconds) : currentOn;
    const rawOff = hasCursor ? subtractCounter(currentOff, accumulator.lastSnapshotOffSeconds) : currentOff;
    const rawUnknown = hasCursor ? subtractCounter(currentUnknown, accumulator.lastSnapshotUnknownSeconds) : currentUnknown;

    if (rawOn === null || rawOff === null || rawUnknown === null) {
      await prisma.electricUsageAccumulator.update({
        where: { id: accumulator.id },
        data: { lastSnapshotOnSeconds: currentOn, lastSnapshotOffSeconds: currentOff, lastSnapshotUnknownSeconds: currentUnknown, lastSnapshotAt: capturedAt },
      });
      skippedCount += 1;
      continue;
    }

    const delta = applyOfflineGuard(normalizeElectricDelta({ onForSeconds: rawOn, offForSeconds: rawOff, unknownForSeconds: rawUnknown }, intervalSeconds), intervalSeconds, connection.home?.hubInstall?.lastSeenAt ?? null, capturedAt);
    const windowStartedAt = windowStartUtc(startAt);
    const estimatedKwh = estimateLightKwh(config.averageWatts, delta.onForSeconds);
    const estimatedCostGbp = estimateLightCostGbp(estimatedKwh, config.electricPricePerKwh);

    if (delta.onForSeconds + delta.offForSeconds + delta.unknownForSeconds > 0) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.electricUsageReading.create({
            data: {
              haConnectionId,
              entityId: accumulator.entityId,
              entityName: accumulator.entityName,
              trackingEpoch: accumulator.trackingEpoch,
              assignmentEpoch: accumulator.assignmentEpoch,
              sourceAreaId: accumulator.sourceAreaId,
              sourceAreaName: accumulator.sourceAreaName,
              windowStartedAt,
              windowEndedAt: capturedAt,
              onForSeconds: delta.onForSeconds,
              offForSeconds: delta.offForSeconds,
              unknownForSeconds: delta.unknownForSeconds,
              averageWattsApplied: config.averageWatts,
              electricPricePerKwh: config.electricPricePerKwh,
              estimatedKwh,
              estimatedCostGbp,
            },
          });
          await tx.electricUsageAccumulator.update({
            where: { id: accumulator.id },
            data: { lastSnapshotOnSeconds: currentOn, lastSnapshotOffSeconds: currentOff, lastSnapshotUnknownSeconds: currentUnknown, lastSnapshotAt: capturedAt },
          });
        });
        insertedCount += 1;
      } catch (error: unknown) {
        if ((error as { code?: string })?.code === 'P2002') skippedCount += 1;
        else throw error;
      }
    } else {
      await prisma.electricUsageAccumulator.update({
        where: { id: accumulator.id },
        data: { lastSnapshotOnSeconds: currentOn, lastSnapshotOffSeconds: currentOff, lastSnapshotUnknownSeconds: currentUnknown, lastSnapshotAt: capturedAt },
      });
      skippedCount += 1;
    }
  }

  return { haConnectionId, trackedCount: accumulators.length, insertedCount, skippedCount, timeZone, oldestDetailCutoff: safeIso(new Date(capturedAt.getTime() - DETAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000)) };
}

export async function captureElectricUsageSnapshotForAllConnections(now = new Date()) {
  const connections = await prisma.haConnection.findMany({ select: { id: true } });
  const failures: Array<{ haConnectionId: number; error: string }> = [];
  let insertedCount = 0;
  let trackedCount = 0;
  for (const connection of connections) {
    try {
      const result = await captureElectricUsageSnapshotForConnection(connection.id, now);
      insertedCount += result.insertedCount;
      trackedCount += result.trackedCount;
    } catch (error) {
      failures.push({ haConnectionId: connection.id, error: error instanceof Error ? error.message : 'Snapshot failed.' });
    }
  }
  return { connections: connections.length, trackedCount, insertedCount, failedConnections: failures.length, failures };
}

export function readingLocalBucketKey(reading: { windowStartedAt: Date }, bucket: 'daily' | 'weekly' | 'monthly', timeZone: string) {
  return localBucketKey(reading.windowStartedAt, bucket, timeZone);
}
