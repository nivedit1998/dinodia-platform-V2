// Architecture: Shared platform helper src/lib/hubStatusMarkers.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';

const HUB_OFFLINE_JITTER_SECONDS = 20 * 60;
const DEFAULT_SYNC_INTERVAL_MINUTES = 2;
const MARKER_ENTITY_ID = '__hub_status__';
const MARKER_UNIT = 'hub';

function normalizeSyncIntervalMinutes(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_SYNC_INTERVAL_MINUTES;
}

export function computeOfflineGraceSeconds(platformSyncIntervalMinutes: unknown): number {
  const mins = normalizeSyncIntervalMinutes(platformSyncIntervalMinutes);
  return mins * 60 + HUB_OFFLINE_JITTER_SECONDS;
}

export async function syncHubStatusMarkersForAllConnections(now = new Date()): Promise<{
  processed: number;
  wrote: number;
}> {
  const connections = await prisma.haConnection.findMany({
    select: {
      id: true,
      home: {
        select: {
          hubInstall: {
            select: {
              lastSeenAt: true,
              platformSyncIntervalMinutes: true,
            },
          },
        },
      },
    },
  });

  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  let processed = 0;
  let wrote = 0;

  for (const conn of connections) {
    const hubInstall = conn.home?.hubInstall ?? null;
    if (!hubInstall) continue;
    processed += 1;

    const offlineGraceSeconds = computeOfflineGraceSeconds(hubInstall.platformSyncIntervalMinutes);
    const lastSeenAt =
      hubInstall.lastSeenAt instanceof Date && Number.isFinite(hubInstall.lastSeenAt.getTime())
        ? hubInstall.lastSeenAt
        : null;

    const offlineStartAt = lastSeenAt
      ? new Date(lastSeenAt.getTime() + offlineGraceSeconds * 1000)
      : now;
    const desiredOnline = lastSeenAt ? now.getTime() <= offlineStartAt.getTime() : false;

    const latest = await prisma.monitoringReading.findFirst({
      where: { haConnectionId: conn.id, entityId: MARKER_ENTITY_ID, unit: MARKER_UNIT },
      orderBy: { capturedAt: 'desc' },
      select: { capturedAt: true, hubOnline: true, state: true },
    });

    const latestOnline = latest?.hubOnline === true;
    const latestOffline = latest?.hubOnline === false || (latest?.state ?? '').toLowerCase() === 'offline';

    if (!desiredOnline && !latestOffline) {
      await prisma.monitoringReading.create({
        data: {
          haConnectionId: conn.id,
          entityId: MARKER_ENTITY_ID,
          unit: MARKER_UNIT,
          state: 'offline',
          numericValue: 0,
          hubOnline: false,
          hubOfflineGraceSeconds: offlineGraceSeconds,
          hubStatusSource: lastSeenAt ? 'heartbeat' : 'missing_lastSeenAt',
          capturedAt: offlineStartAt,
        },
      });
      wrote += 1;
    } else if (desiredOnline && !latestOnline) {
      await prisma.monitoringReading.create({
        data: {
          haConnectionId: conn.id,
          entityId: MARKER_ENTITY_ID,
          unit: MARKER_UNIT,
          state: 'online',
          numericValue: 1,
          hubOnline: true,
          hubOfflineGraceSeconds: offlineGraceSeconds,
          hubStatusSource: lastSeenAt ? 'heartbeat' : 'missing_lastSeenAt',
          capturedAt: lastSeenAt ?? now,
        },
      });
      wrote += 1;
    }

    await prisma.monitoringReading.deleteMany({
      where: {
        haConnectionId: conn.id,
        entityId: MARKER_ENTITY_ID,
        unit: MARKER_UNIT,
        capturedAt: { lt: cutoff },
      },
    });
  }

  return { processed, wrote };
}
