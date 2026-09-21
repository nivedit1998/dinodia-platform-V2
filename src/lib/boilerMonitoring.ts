// Architecture: Shared platform helper src/lib/boilerMonitoring.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { getGroupLabel } from '@/lib/deviceLabels';
import { getCurrentTemperature, getTargetTemperature } from '@/lib/deviceCapabilities';

const HEAT_LABELS = new Set(['Boiler', 'Radiator']);
const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MAX_SNAPSHOT_INTERVAL_SECONDS = 24 * 60 * 60;
const SNAPSHOT_TOLERANCE_SECONDS = 10 * 60;
const HUB_OFFLINE_JITTER_SECONDS = 20 * 60;
const MAX_ERROR_LENGTH = 300;

function clampSeconds(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

type ConnectionSnapshotFailure = {
  haConnectionId: number;
  error: string;
};

function normalizeErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : JSON.stringify(err);
  const compact = (raw || 'Unknown error').replace(/\s+/g, ' ').trim();
  return compact.length > MAX_ERROR_LENGTH
    ? `${compact.slice(0, MAX_ERROR_LENGTH)}...`
    : compact;
}

export async function captureBoilerTempSnapshotForConnection(haConnectionId: number, now = new Date()) {
  const [devices, haMeta] = await Promise.all([
    getDevicesForHaConnection(haConnectionId),
    prisma.haConnection.findUnique({
      where: { id: haConnectionId },
      select: {
        home: {
          select: {
            hubInstall: {
              select: { lastSeenAt: true, platformSyncIntervalMinutes: true },
            },
          },
        },
      },
    }),
  ]);
  const boilerDevices = devices.filter((d) => HEAT_LABELS.has(getGroupLabel(d)));

  const hubInstall = haMeta?.home?.hubInstall ?? null;
  const offlineDetectionEnabled = Boolean(hubInstall);
  const hubLastSeenAt = hubInstall?.lastSeenAt instanceof Date ? hubInstall.lastSeenAt : null;
  const syncIntervalRaw = hubInstall?.platformSyncIntervalMinutes;
  const platformSyncIntervalMinutes =
    typeof syncIntervalRaw === 'number' && Number.isFinite(syncIntervalRaw) && syncIntervalRaw > 0
      ? Math.floor(syncIntervalRaw)
      : 2;
  const offlineGraceSeconds = platformSyncIntervalMinutes * 60 + HUB_OFFLINE_JITTER_SECONDS;

  type HeatGroupLabel = 'Boiler' | 'Radiator';
  type SnapshotReading = {
    haConnectionId: number;
    entityId: string;
    groupLabel: HeatGroupLabel;
    numericValue: number;
    currentTemperature: number;
    targetTemperature: number | null;
    unit: string;
    capturedAt: Date;
  };

  const baseReadings = boilerDevices
    .map((d): SnapshotReading | null => {
      const groupLabelRaw = getGroupLabel(d);
      if (groupLabelRaw !== 'Boiler' && groupLabelRaw !== 'Radiator') return null;
      const groupLabel: HeatGroupLabel = groupLabelRaw;
      const attrs = d.attributes ?? {};
      const current = getCurrentTemperature(attrs);
      if (typeof current !== 'number' || !Number.isFinite(current)) return null;
      const state = String(d.state ?? '').trim().toLowerCase();
      const hvacMode = typeof attrs.hvac_mode === 'string' ? attrs.hvac_mode.trim().toLowerCase() : '';
      const isExplicitOff = state === 'off' || hvacMode === 'off';
      const rawTarget = isExplicitOff ? null : getTargetTemperature(attrs);
      const target = isExplicitOff
        ? 0
        : typeof rawTarget === 'number' && Number.isFinite(rawTarget) && rawTarget > 0
        ? rawTarget
        : null;
      return {
        haConnectionId,
        entityId: d.entityId,
        groupLabel,
        numericValue: current,
        currentTemperature: current,
        targetTemperature: typeof target === 'number' && Number.isFinite(target) ? target : null,
        unit: '°C',
        capturedAt: now,
      };
    })
    .filter((r): r is SnapshotReading => r !== null);

  if (baseReadings.length === 0) {
    return { haConnectionId, totalDevices: devices.length, boilerCount: 0, insertedCount: 0 };
  }

  const cutoff = new Date(now.getTime() - MIN_INTERVAL_MS);
  const recent = await prisma.boilerTemperatureReading.findMany({
    where: {
      haConnectionId,
      entityId: { in: baseReadings.map((r) => r.entityId) },
      capturedAt: { gte: cutoff },
    },
    select: { entityId: true },
  });
  const recentSet = new Set(recent.map((r) => r.entityId));
  const toInsert = baseReadings.filter((r) => !recentSet.has(r.entityId));

  const boilerEntityIds = toInsert.filter((r) => r.groupLabel === 'Boiler').map((r) => r.entityId);
  const radiatorEntityIds = toInsert.filter((r) => r.groupLabel === 'Radiator').map((r) => r.entityId);

  const boilerPowerOverrides = boilerEntityIds.length
    ? await prisma.device.findMany({
        where: { haConnectionId, entityId: { in: boilerEntityIds } },
        select: { entityId: true, boilerPowerKw: true },
      })
    : [];
  const boilerPowerOverrideByEntityId = new Map(boilerPowerOverrides.map((d) => [d.entityId, d.boilerPowerKw]));
  const defaultBoilerPowerKw = (() => {
    const raw = process.env.BOILER_POWER_KW;
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  const [boilerAccumulators, radiatorAccumulators] = await Promise.all([
    boilerEntityIds.length
      ? prisma.boilerUsageAccumulator.findMany({
          where: { haConnectionId, entityId: { in: boilerEntityIds } },
          select: {
            entityId: true,
            onSeconds: true,
            offSeconds: true,
            unknownSeconds: true,
            efficiencyWeightedOnSeconds: true,
            efficiencyOnSeconds: true,
            lastSnapshotOnSeconds: true,
            lastSnapshotOffSeconds: true,
            lastSnapshotUnknownSeconds: true,
            lastSnapshotEfficiencyWeightedOnSeconds: true,
            lastSnapshotEfficiencyOnSeconds: true,
            lastSnapshotAt: true,
          },
        })
      : Promise.resolve([]),
    radiatorEntityIds.length
      ? prisma.radiatorUsageAccumulator.findMany({
          where: { haConnectionId, entityId: { in: radiatorEntityIds } },
          select: {
            entityId: true,
            onSeconds: true,
            offSeconds: true,
            unknownSeconds: true,
            lastSnapshotOnSeconds: true,
            lastSnapshotOffSeconds: true,
            lastSnapshotUnknownSeconds: true,
            lastSnapshotAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const boilerAccMap = new Map(boilerAccumulators.map((a) => [a.entityId, a]));
  const radiatorAccMap = new Map(radiatorAccumulators.map((a) => [a.entityId, a]));

  const cursorUpdates: Array<{
    groupLabel: 'Boiler' | 'Radiator';
    entityId: string;
    onSeconds: number;
    offSeconds: number;
    unknownSeconds: number;
    efficiencyWeightedOnSeconds: number;
    efficiencyOnSeconds: number;
    onForSeconds: number | null;
    offForSeconds: number | null;
    unknownForSeconds: number | null;
    averageEfficiencyPercent: number | null;
    kwhOnEstimated: number | null;
  }> = [];

  const data = toInsert.map((reading) => {
    const acc = reading.groupLabel === 'Boiler' ? boilerAccMap.get(reading.entityId) : radiatorAccMap.get(reading.entityId);
    if (!acc) {
      return {
        haConnectionId: reading.haConnectionId,
        entityId: reading.entityId,
        numericValue: reading.numericValue,
        currentTemperature: reading.currentTemperature,
        targetTemperature: reading.targetTemperature,
        onForSeconds: null,
        offForSeconds: null,
        unknownForSeconds: null,
        averageEfficiencyPercent: null,
        kwhOnEstimated: null,
        unit: reading.unit,
        capturedAt: reading.capturedAt,
      };
    }

    const onSeconds = Math.max(0, Math.floor(Number(acc.onSeconds ?? 0)));
    const offSeconds = Math.max(0, Math.floor(Number(acc.offSeconds ?? 0)));
    const unknownSeconds = Math.max(0, Math.floor(Number(acc.unknownSeconds ?? 0)));
    const efficiencyWeightedOnSeconds =
      reading.groupLabel === 'Boiler' ? Math.max(0, Number((acc as { efficiencyWeightedOnSeconds?: unknown }).efficiencyWeightedOnSeconds ?? 0)) : 0;
    const efficiencyOnSeconds =
      reading.groupLabel === 'Boiler' ? Math.max(0, Math.floor(Number((acc as { efficiencyOnSeconds?: unknown }).efficiencyOnSeconds ?? 0))) : 0;
    const cursorOn = acc.lastSnapshotOnSeconds;
    const cursorOff = acc.lastSnapshotOffSeconds;
    const cursorUnknown = acc.lastSnapshotUnknownSeconds;
    const cursorEffWeighted =
      reading.groupLabel === 'Boiler'
        ? (acc as { lastSnapshotEfficiencyWeightedOnSeconds?: unknown }).lastSnapshotEfficiencyWeightedOnSeconds
        : null;
    const cursorEffOn =
      reading.groupLabel === 'Boiler'
        ? (acc as { lastSnapshotEfficiencyOnSeconds?: unknown }).lastSnapshotEfficiencyOnSeconds
        : null;

    const lastSnapshotAt = acc.lastSnapshotAt instanceof Date ? acc.lastSnapshotAt : null;
    const intervalSecondsRaw =
      lastSnapshotAt && Number.isFinite(lastSnapshotAt.getTime())
        ? Math.floor((now.getTime() - lastSnapshotAt.getTime()) / 1000)
        : null;
    const intervalSeconds = intervalSecondsRaw !== null ? Math.max(0, intervalSecondsRaw) : null;
    const intervalClamp =
      intervalSeconds !== null
        ? Math.min(MAX_SNAPSHOT_INTERVAL_SECONDS, intervalSeconds + SNAPSHOT_TOLERANCE_SECONDS)
        : MAX_SNAPSHOT_INTERVAL_SECONDS;

    const snapshotStartAt =
      lastSnapshotAt && Number.isFinite(lastSnapshotAt.getTime())
        ? lastSnapshotAt
        : new Date(now.getTime() - intervalClamp * 1000);

    let onForSeconds: number | null = null;
    let offForSeconds: number | null = null;
    let unknownForSeconds: number | null = null;
    let averageEfficiencyPercent: number | null = null;
    let kwhOnEstimated: number | null = null;

    if (typeof cursorOn === 'number' && Number.isFinite(cursorOn)) {
      const rawOn = onSeconds - cursorOn;
      if (rawOn >= 0) onForSeconds = Math.min(intervalClamp, Math.floor(rawOn));
    }

    if (typeof cursorOff === 'number' && Number.isFinite(cursorOff)) {
      const rawOff = offSeconds - cursorOff;
      if (rawOff >= 0) offForSeconds = Math.min(intervalClamp, Math.floor(rawOff));
    }

    if (typeof cursorUnknown === 'number' && Number.isFinite(cursorUnknown)) {
      const rawUnknown = unknownSeconds - cursorUnknown;
      if (rawUnknown >= 0) unknownForSeconds = Math.min(intervalClamp, Math.floor(rawUnknown));
    }

    if (
      typeof onForSeconds === 'number' &&
      typeof offForSeconds === 'number' &&
      typeof unknownForSeconds === 'number'
    ) {
      const total = onForSeconds + offForSeconds + unknownForSeconds;
      if (total > intervalClamp) {
        unknownForSeconds = Math.max(0, intervalClamp - onForSeconds - offForSeconds);
      }
    }

    // Phase 9: hub-offline attribution.
    // Remove "quiet period" UNKNOWN and instead attribute UNKNOWN only when the hub heartbeat is stale.
    if (offlineDetectionEnabled) {
      const unknownSecondsByHeartbeat = !hubLastSeenAt
        ? intervalClamp
        : clampSeconds(
            Math.floor(
              (now.getTime() -
                Math.max(
                  snapshotStartAt.getTime(),
                  hubLastSeenAt.getTime() + offlineGraceSeconds * 1000
                )) /
                1000
            ),
            0,
            intervalClamp
          );

      if (unknownSecondsByHeartbeat > 0) {
        const baseUnknown = typeof unknownForSeconds === 'number' ? unknownForSeconds : 0;
        unknownForSeconds = Math.max(baseUnknown, unknownSecondsByHeartbeat);

        const onVal = typeof onForSeconds === 'number' ? onForSeconds : 0;
        const offVal = typeof offForSeconds === 'number' ? offForSeconds : 0;
        const total = onVal + offVal + unknownForSeconds;
        if (total > intervalClamp) {
          unknownForSeconds = Math.max(0, intervalClamp - onVal - offVal);
        }
      }
    }

    if (reading.groupLabel === 'Boiler') {
      let deltaEffWeighted: number | null = null;
      let deltaEffOn: number | null = null;

      if (typeof cursorEffWeighted === 'number' && Number.isFinite(cursorEffWeighted)) {
        const raw = efficiencyWeightedOnSeconds - cursorEffWeighted;
        if (raw >= 0) deltaEffWeighted = Math.min(intervalClamp, raw);
      }

      if (typeof cursorEffOn === 'number' && Number.isFinite(cursorEffOn)) {
        const raw = efficiencyOnSeconds - cursorEffOn;
        if (raw >= 0) deltaEffOn = Math.min(intervalClamp, Math.floor(raw));
      }

      if (typeof deltaEffWeighted === 'number' && typeof deltaEffOn === 'number') {
        averageEfficiencyPercent =
          deltaEffOn > 0 ? (deltaEffWeighted / deltaEffOn) * 100 : null;

        const overrideKw = boilerPowerOverrideByEntityId.get(reading.entityId);
        const boilerPowerKw =
          typeof overrideKw === 'number' && Number.isFinite(overrideKw) && overrideKw > 0
            ? overrideKw
            : defaultBoilerPowerKw;
        kwhOnEstimated =
          boilerPowerKw != null ? boilerPowerKw * (deltaEffWeighted / 3600) : null;
      }
    }

    cursorUpdates.push({
      groupLabel: reading.groupLabel,
      entityId: reading.entityId,
      onSeconds,
      offSeconds,
      unknownSeconds,
      efficiencyWeightedOnSeconds,
      efficiencyOnSeconds,
      onForSeconds,
      offForSeconds,
      unknownForSeconds,
      averageEfficiencyPercent,
      kwhOnEstimated,
    });

    return {
      haConnectionId: reading.haConnectionId,
      entityId: reading.entityId,
      numericValue: reading.numericValue,
      currentTemperature: reading.currentTemperature,
      targetTemperature: reading.targetTemperature,
      onForSeconds,
      offForSeconds,
      unknownForSeconds,
      averageEfficiencyPercent,
      kwhOnEstimated,
      unit: reading.unit,
      capturedAt: reading.capturedAt,
    };
  });

  const inserted = data.length
    ? await prisma.$transaction(async (tx) => {
        const created = await tx.boilerTemperatureReading.createMany({ data });

        if (cursorUpdates.length > 0) {
          const boilerUpdates = cursorUpdates.filter((u) => u.groupLabel === 'Boiler');
          const radiatorUpdates = cursorUpdates.filter((u) => u.groupLabel === 'Radiator');

          for (const update of boilerUpdates) {
            await tx.boilerUsageAccumulator.update({
              where: { haConnectionId_entityId: { haConnectionId, entityId: update.entityId } },
              data: {
                lastSnapshotOnSeconds: update.onSeconds,
                lastSnapshotOffSeconds: update.offSeconds,
                lastSnapshotUnknownSeconds: update.unknownSeconds,
                lastSnapshotEfficiencyWeightedOnSeconds: update.efficiencyWeightedOnSeconds,
                lastSnapshotEfficiencyOnSeconds: update.efficiencyOnSeconds,
                lastSnapshotAt: now,
              },
            });
          }

          for (const update of radiatorUpdates) {
            await tx.radiatorUsageAccumulator.update({
              where: { haConnectionId_entityId: { haConnectionId, entityId: update.entityId } },
              data: {
                lastSnapshotOnSeconds: update.onSeconds,
                lastSnapshotOffSeconds: update.offSeconds,
                lastSnapshotUnknownSeconds: update.unknownSeconds,
                lastSnapshotAt: now,
              },
            });
          }
        }

        return created;
      })
    : { count: 0 };

  return {
    haConnectionId,
    totalDevices: devices.length,
    boilerCount: baseReadings.length,
    insertedCount: inserted.count,
  };
}

export async function captureBoilerTempSnapshotForAllConnections(now = new Date()) {
  const connections = await prisma.haConnection.findMany({
    select: { id: true },
  });

  let totalDevices = 0;
  let boilerCount = 0;
  let insertedCount = 0;
  const failures: ConnectionSnapshotFailure[] = [];

  for (const { id } of connections) {
    try {
      const summary = await captureBoilerTempSnapshotForConnection(id, now);
      totalDevices += summary.totalDevices;
      boilerCount += summary.boilerCount;
      insertedCount += summary.insertedCount;
    } catch (err) {
      const message = normalizeErrorMessage(err);
      failures.push({ haConnectionId: id, error: message });
      console.error('[boilerMonitoring] snapshot failed for connection', {
        haConnectionId: id,
        error: message,
      });
    }
  }

  return {
    connections: connections.length,
    totalDevices,
    boilerCount,
    insertedCount,
    failedConnections: failures.length,
    failures,
  };
}
