import { prisma } from './prisma';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { reconcileCredentialLifecycle } from './hubOperatorCredentials';
import { releaseExpiredClaim } from './stage1ClaimContract';
import { createPropertySupportNotifications } from './supportNotifications';
import { dispatchInstallationRequestNotifications } from './installationRequestDelivery';
import { resumeHomeDeregistrationAccountCleanup, type HomeDeregistrationCleanupResult } from './homeDeregistrationCleanup';
import { dispatchNativeAlexaChangeReports } from './nativeAlexaEvents';
import { cleanEphemeralRecords } from './nativeEphemeralRetention';

export const NATIVE_OPERATION_BATCH_LIMIT = 100;
export const NATIVE_DISPATCH_LEASE_MS = 120_000;

export const nativeTaskRegistry = Object.freeze([
  { taskId: 'operator_credential_lifecycle', owner: 'supabase_pg_cron_two_minute' },
  { taskId: 'support_expiry_and_revocation', owner: 'supabase_pg_cron_two_minute' },
  { taskId: 'claim_reservation_expiry', owner: 'supabase_pg_cron_two_minute' },
  { taskId: 'expired_dispatch_lease_cleanup', owner: 'vercel_hobby_daily' },
  { taskId: 'retentionCleanup', owner: 'vercel_hobby_daily' },
  { taskId: 'analyticsAndStorageMaintenance', owner: 'vercel_hobby_daily' },
] as const);

const nativeTaskOwnerById = new Map<string, string>([
  ['operator_credential_lifecycle', 'supabase_pg_cron_two_minute'],
  ['support_expiry_and_revocation', 'supabase_pg_cron_two_minute'],
  ['claim_reservation_expiry', 'supabase_pg_cron_two_minute'],
  ['expired_dispatch_lease_cleanup', 'vercel_hobby_daily'],
  ['retentionCleanup', 'vercel_hobby_daily'],
  ['analyticsAndStorageMaintenance', 'vercel_hobby_daily'],
]);

export function validateNativeTaskRegistry(registry: readonly { taskId: string; owner: string }[] = nativeTaskRegistry): true {
  const seen = new Set<string>();
  for (const task of registry) {
    if (seen.has(task.taskId) || nativeTaskOwnerById.get(task.taskId) !== task.owner) {
      throw new Error('Native task registry contains an unregistered, duplicate, or misowned task');
    }
    seen.add(task.taskId);
  }
  if (seen.size !== nativeTaskOwnerById.size || [...nativeTaskOwnerById.keys()].some((taskId) => !seen.has(taskId))) {
    throw new Error('Native task registry is incomplete');
  }
  return true;
}

function assertTaskRegistryOwner(taskIds: string[], owner: (typeof nativeTaskRegistry)[number]['owner']) {
  validateNativeTaskRegistry();
  const actual = nativeTaskRegistry.filter((task) => taskIds.includes(task.taskId));
  if (actual.length !== taskIds.length || actual.some((task) => task.owner !== owner)) {
    throw new Error('Native task registry ownership mismatch');
  }
}

export async function runNativeOperations(now = new Date()) {
  const taskIds = ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'];
  assertTaskRegistryOwner(taskIds, 'supabase_pg_cron_two_minute');
  let expiredSupportCount = 0;
  let expiredRequestCount = 0;
  let releasedClaims = 0;
  let installationDelivery = { operationsAccepted: 0, operationsDeferred: 0, operationsFailed: 0,
    completionAccepted: 0, completionDeferred: 0, completionSuppressed: 0, pushAccepted: 0, pushDeferred: 0,
    pushFailed: 0, pushSuppressed: 0, accessRemovalAccepted: 0, accessRemovalDeferred: 0,
    accessRemovalFailed: 0, accessRemovalSuppressed: 0, accessRemovalExpired: 0 };
  let homeDeregistrationAccountCleanup: HomeDeregistrationCleanupResult = { evaluated: 0, deferred: 0, failed: 0, pending: 0 };
  let alexaChangeReports = { enabled: false, scanned: 0, delivered: 0, cancelled: 0, expired: 0, retried: 0, failed: 0 };
  const failures: string[] = [];
  const isolate = async (taskId: string, run: () => Promise<void>) => {
    try { await run(); } catch { if (!failures.includes(taskId)) failures.push(taskId); }
  };
  await isolate('operator_credential_lifecycle', async () => { await reconcileCredentialLifecycle(now); });
  await isolate('support_expiry_and_revocation', async () => {
    const expiredSupportRows = await prisma.supportSession.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: NATIVE_OPERATION_BATCH_LIMIT, select: { id: true, homeId: true, ticketId: true, accessRequestId: true } });
    for (const session of expiredSupportRows) {
      await prisma.$transaction(async (tx) => {
        const expired = await tx.supportSession.updateMany({ where: { id: session.id, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED', endedAt: now, desiredRevokedAt: now } });
        if (expired.count !== 1) return;
        expiredSupportCount += 1;
        await createPropertySupportNotifications(tx, { homeId: session.homeId, ticketId: session.ticketId, accessRequestId: session.accessRequestId, sessionId: session.id, eventType: 'EXPIRED' });
        await tx.auditEvent.create({ data: { homeId: session.homeId, actorType: 'SYSTEM', actorId: null, category: 'SECURITY', action: 'support_access_expired', targetType: 'SupportSession', targetId: session.id, metadata: { outcome: 'expired', hubAcknowledgementPending: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      });
    }
    const expiredRequests = await prisma.supportAccessRequest.findMany({ where: { status: { in: ['REQUESTED', 'APPROVED', 'ISSUED'] }, codeExpiresAt: { lte: now } }, orderBy: { codeExpiresAt: 'asc' }, take: NATIVE_OPERATION_BATCH_LIMIT, select: { id: true } });
    for (const request of expiredRequests) {
      const expired = await prisma.supportAccessRequest.updateMany({ where: { id: request.id, status: { in: ['REQUESTED', 'APPROVED', 'ISSUED'] }, codeExpiresAt: { lte: now } }, data: { status: 'EXPIRED', revision: { increment: 1 } } });
      expiredRequestCount += expired.count;
    }
    installationDelivery = await dispatchInstallationRequestNotifications(now);
    alexaChangeReports = await dispatchNativeAlexaChangeReports(now);
  });
  // Resume full-home cleanup under the existing two-minute operations task;
  // this introduces no additional cron or scheduler and remains isolated from
  // the independent support-email dispatcher above.
  await isolate('support_expiry_and_revocation', async () => {
    homeDeregistrationAccountCleanup = await resumeHomeDeregistrationAccountCleanup(now, { limit: 24 });
  });
  await isolate('claim_reservation_expiry', async () => {
    const claims = await prisma.homeClaimReservation.findMany({ where: { state: 'ACTIVE', expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: NATIVE_OPERATION_BATCH_LIMIT, select: { id: true } });
    for (const claim of claims) if ((await releaseExpiredClaim(claim.id, {}, now)).released) releasedClaims += 1;
  });
  return { tasks: taskIds, expiredSupport: expiredSupportCount, expiredRequests: expiredRequestCount, releasedClaims,
    homeDeregistrationAccountCleanup, installationDelivery, alexaChangeReports, failedTasks: failures };
}

export async function inspectNativeAnalyticsIntegrity(now = new Date()) {
  const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const [rows, temperatureRows] = await Promise.all([
    prisma.$queryRaw<Array<{ scanned: bigint; invalidPartitions: bigint; onSeconds: bigint; offSeconds: bigint; unknownSeconds: bigint }>>`
      WITH bounded_usage AS (
        SELECT *, COALESCE("coverageStartAt", CASE WHEN "closedAt" IS NOT NULL
            THEN "closedAt" - ("onSeconds" + "offSeconds" + "unknownSeconds") * INTERVAL '1 second'
            ELSE "bucketStart" END) AS "effectiveCoverageStartAt",
          COALESCE("coverageEndAt", "closedAt", "bucketStart" + ("onSeconds" + "offSeconds" + "unknownSeconds") * INTERVAL '1 second') AS "effectiveCoverageEndAt"
        FROM (SELECT "onSeconds", "offSeconds", "unknownSeconds", "coverageStartAt", "coverageEndAt", "closedAt", "bucketStart"
          FROM "NativeDeviceUsageBucket" WHERE "bucketStart" >= ${cutoff} AND "bucketStart" <= ${now}
          ORDER BY "bucketStart" DESC LIMIT 10000) AS recent_usage
      )
      SELECT COUNT(*)::bigint AS scanned,
        COUNT(*) FILTER (WHERE "onSeconds" < 0 OR "offSeconds" < 0 OR "unknownSeconds" < 0
          OR "onSeconds" + "offSeconds" + "unknownSeconds" > 3600
          OR EXTRACT(EPOCH FROM "bucketStart")::bigint % 3600 <> 0
          OR (("coverageStartAt" IS NULL) <> ("coverageEndAt" IS NULL))
          OR "effectiveCoverageStartAt" < "bucketStart"
          OR "effectiveCoverageEndAt" > "bucketStart" + INTERVAL '1 hour'
          OR "effectiveCoverageEndAt" <= "effectiveCoverageStartAt"
          OR EXTRACT(EPOCH FROM ("effectiveCoverageEndAt" - "effectiveCoverageStartAt"))
              <> "onSeconds" + "offSeconds" + "unknownSeconds"
          OR ("closedAt" IS NOT NULL AND ("closedAt" <> "bucketStart" + INTERVAL '1 hour' OR "effectiveCoverageEndAt" <> "closedAt"))
          OR ("closedAt" IS NULL AND "onSeconds" + "offSeconds" + "unknownSeconds" >= 3600))::bigint AS "invalidPartitions",
        COALESCE(SUM("onSeconds"), 0)::bigint AS "onSeconds",
        COALESCE(SUM("offSeconds"), 0)::bigint AS "offSeconds",
        COALESCE(SUM("unknownSeconds"), 0)::bigint AS "unknownSeconds"
      FROM bounded_usage`,
    prisma.nativeTemperatureSample.count({ where: { sourceObservedAt: { gte: cutoff, lte: now }, purgeAt: { gt: now },
      device: { is: { managementClass: 'PROPERTY_DEVICE', analyticsCategory: 'RADIATOR' } } } }),
  ]);
  const zero = BigInt(0);
  const row = rows[0] ?? { scanned: zero, invalidPartitions: zero, onSeconds: zero, offSeconds: zero, unknownSeconds: zero };
  return { checkedThrough: now.toISOString(), lookbackDays: 14, sampleLimit: 10000,
    usageRowsScanned: Number(row.scanned), invalidUsagePartitions: Number(row.invalidPartitions),
    sourceOnSeconds: Number(row.onSeconds), sourceOffSeconds: Number(row.offSeconds), sourceUnknownSeconds: Number(row.unknownSeconds),
    temperatureSamplesInWindow: temperatureRows, aggregationMode: 'query_time_no_persisted_rollup',
    status: Number(row.invalidPartitions) === 0 ? 'OK' : 'FAILED' };
}

export async function runNativeMaintenance(now = new Date()) {
  const taskIds = ['expired_dispatch_lease_cleanup', 'retentionCleanup', 'analyticsAndStorageMaintenance'];
  assertTaskRegistryOwner(taskIds, 'vercel_hobby_daily');
  const failedTasks: string[] = [];
  const result: Record<string, unknown> = { tasks: taskIds, failedTasks };
  const isolate = async (taskId: string, run: () => Promise<void>) => {
    try { await run(); } catch { failedTasks.push(taskId); }
  };
  await isolate('expired_dispatch_lease_cleanup', async () => {
    const leases = await prisma.nativeBackgroundTaskState.updateMany({
      where: { taskId: { not: 'expired_dispatch_lease_cleanup' }, leaseExpiresAt: { lte: now } },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
    const receipts = await prisma.hubSyncReceipt.deleteMany({ where: { expiresAt: { lte: now } } });
    const deregistrationCleanup = await prisma.nativeDomainOutbox.deleteMany({ where: {
      aggregateType: 'FullHomeDeregistrationAccountCleanup', eventType: 'FULL_HOME_ACCOUNT_CLEANUP',
      state: { in: ['DELIVERED', 'FAILED', 'CANCELLED'] }, expiresAt: { lte: now },
    } });
    Object.assign(result, { expiredDispatcherLeases: leases.count, expiredSyncReceipts: receipts.count,
      expiredDeregistrationCleanupReceipts: deregistrationCleanup.count });
  });

  await isolate('retentionCleanup', async () => {
    const batchSize = 1000; const maxBatchesPerTable = 8;
    let usageDeleted = 0; let temperatureDeleted = 0; let automationTombstonesDeleted = 0; let unallocatedDeleted = 0;
    for (let batch = 0; batch < maxBatchesPerTable; batch += 1) {
      const deleted = await prisma.$executeRaw`
        WITH doomed AS (
          SELECT "id" FROM "NativeAnalyticsUnallocated" WHERE "purgeAt" <= ${now}
          ORDER BY "purgeAt", "id" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "NativeAnalyticsUnallocated" AS target USING doomed WHERE target."id" = doomed."id"`;
      unallocatedDeleted += Number(deleted);
      if (Number(deleted) < batchSize) break;
    }
    for (let batch = 0; batch < maxBatchesPerTable; batch += 1) {
      const deleted = await prisma.$executeRaw`
        WITH doomed AS (
          SELECT "id" FROM "NativeDeviceUsageBucket" WHERE "purgeAt" <= ${now}
          ORDER BY "purgeAt", "id" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "NativeDeviceUsageBucket" AS target USING doomed WHERE target."id" = doomed."id"`;
      usageDeleted += Number(deleted);
      if (Number(deleted) < batchSize) break;
    }
    for (let batch = 0; batch < maxBatchesPerTable; batch += 1) {
      const deleted = await prisma.$executeRaw`
        WITH doomed AS (
          SELECT "id" FROM "NativeTemperatureSample" WHERE "purgeAt" <= ${now}
          ORDER BY "purgeAt", "id" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "NativeTemperatureSample" AS target USING doomed WHERE target."id" = doomed."id"`;
      temperatureDeleted += Number(deleted);
      if (Number(deleted) < batchSize) break;
    }
    // Retain only the minimal automation tombstone for 12 months, then purge
    // it (and its bounded execution receipts) only after the current hub has
    // acknowledged a full configuration which excludes the retired rule.
    for (let batch = 0; batch < maxBatchesPerTable; batch += 1) {
      const deleted = await prisma.$executeRaw`
        WITH doomed AS (
          SELECT automation."id" FROM "NativeAutomation" automation
          JOIN "Home" home ON home."id" = automation."homeId"
          JOIN "HubInstallation" hub ON hub."id" = home."activeHubInstallationId"
          WHERE automation."status" = 'RETIRED' AND automation."purgeAt" <= ${now}
            AND hub."acknowledgedCloudRevision" >= hub."cloudConfigurationRevision"
          ORDER BY automation."purgeAt", automation."id"
          LIMIT ${batchSize} FOR UPDATE OF automation SKIP LOCKED
        )
        DELETE FROM "NativeAutomation" automation USING doomed
        WHERE automation."id" = doomed."id"`;
      automationTombstonesDeleted += Number(deleted);
      if (Number(deleted) < batchSize) break;
    }
    const [usageRemainder, temperatureRemainder, unallocatedRemainder] = await Promise.all([
      prisma.nativeDeviceUsageBucket.findFirst({ where: { purgeAt: { lte: now } }, select: { id: true } }),
      prisma.nativeTemperatureSample.findFirst({ where: { purgeAt: { lte: now } }, select: { id: true } }),
      prisma.nativeAnalyticsUnallocated.findFirst({ where: { purgeAt: { lte: now } }, select: { id: true } }),
    ]);
    const ephemeral = await cleanEphemeralRecords(prisma, now);
    const calendarAnalytics = process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED === 'true'
      ? await (await import('./dailyAnalyticsMaintenance')).maintainDailyAnalytics(prisma, now) : { enabled: false };
    const checkpoint = { through: now.toISOString(), usageDeleted, temperatureDeleted, automationTombstonesDeleted, unallocatedDeleted,
      ephemeral, calendarAnalytics, backlogRemains: Boolean(usageRemainder || temperatureRemainder || unallocatedRemainder
        || ephemeral.replayBacklogRemains || ephemeral.cronBacklogRemains), batchLimitPerTable: batchSize * maxBatchesPerTable };
    result.retentionCleanup = checkpoint;
    (result as { taskCursors?: Record<string, unknown> }).taskCursors = {
      ...((result as { taskCursors?: Record<string, unknown> }).taskCursors ?? {}), retentionCleanup: checkpoint,
    };
  });

  await isolate('analyticsAndStorageMaintenance', async () => {
    const report = await inspectNativeAnalyticsIntegrity(now);
    if (report.invalidUsagePartitions !== 0) throw new Error('Native usage duration integrity check failed');
    result.analyticsAndStorageMaintenance = report;
    (result as { taskCursors?: Record<string, unknown> }).taskCursors = {
      ...((result as { taskCursors?: Record<string, unknown> }).taskCursors ?? {}), analyticsAndStorageMaintenance: report,
    };
  });
  return result;
}

const taskIdsByDispatcher = {
  'native-operations': { owner: 'OPERATIONS' as const, taskIds: ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'] },
  'native-maintenance': { owner: 'MAINTENANCE' as const, taskIds: ['expired_dispatch_lease_cleanup', 'retentionCleanup', 'analyticsAndStorageMaintenance'] },
};

export type NativeDispatcherLease = { owner: string; taskIds: string[] };

export async function acquireOperationsLease(name: string, now = new Date()): Promise<NativeDispatcherLease | null> {
  const dispatcher = taskIdsByDispatcher[name as keyof typeof taskIdsByDispatcher];
  if (!dispatcher || !Number.isFinite(now.getTime())) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      const owner = randomUUID();
      const result = await tx.nativeBackgroundTaskState.updateMany({
        where: {
          taskId: { in: dispatcher.taskIds }, dispatcher: dispatcher.owner,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + NATIVE_DISPATCH_LEASE_MS), lastStartedAt: now },
      });
      if (result.count !== dispatcher.taskIds.length) throw new Error('dispatcher lease unavailable');
      return { owner, taskIds: dispatcher.taskIds };
    }, { isolationLevel: 'Serializable' });
  } catch { return null; }
}

export async function completeOperationsLease(name: string, lease: NativeDispatcherLease, outcome: {
  failedTasks?: string[]; expiredSupport?: number; expiredRequests?: number; releasedClaims?: number; expiredDispatcherLeases?: number; expiredSyncReceipts?: number; taskCursors?: Record<string, unknown>;
}, now = new Date()): Promise<boolean> {
  const dispatcher = taskIdsByDispatcher[name as keyof typeof taskIdsByDispatcher];
  if (!dispatcher || !lease || !Number.isFinite(now.getTime()) || lease.taskIds.length !== dispatcher.taskIds.length || dispatcher.taskIds.some((id) => !lease.taskIds.includes(id))) return false;
  const failedTasks = new Set((outcome.failedTasks ?? []).filter((id) => dispatcher.taskIds.includes(id)));
  const summary = Object.fromEntries(['expiredSupport', 'expiredRequests', 'releasedClaims', 'expiredDispatcherLeases', 'expiredSyncReceipts']
    .filter((key) => Number.isSafeInteger(outcome[key as keyof typeof outcome]) && Number(outcome[key as keyof typeof outcome]) >= 0)
    .map((key) => [key, Number(outcome[key as keyof typeof outcome])]));
  const completed = await prisma.$transaction(async (tx) => {
    let updated = 0;
    for (const taskId of dispatcher.taskIds) {
      const failed = failedTasks.has(taskId);
      const result = await tx.nativeBackgroundTaskState.updateMany({
        where: { taskId, dispatcher: dispatcher.owner, leaseOwner: lease.owner },
        data: {
          leaseOwner: null,
          leaseExpiresAt: null,
          lastCompletedAt: now,
          nextDueAt: new Date(now.getTime() + (dispatcher.owner === 'OPERATIONS' ? NATIVE_DISPATCH_LEASE_MS : 24 * 60 * 60 * 1000)),
          ...(outcome.taskCursors?.[taskId] ? { cursor: outcome.taskCursors[taskId] as Prisma.InputJsonValue } : {}),
          lastOutcome: { status: failed ? 'FAILED' : 'SUCCEEDED', completedAt: now.toISOString(), summary } as Prisma.InputJsonValue,
          consecutiveFailures: failed ? { increment: 1 } : 0,
        },
      });
      updated += result.count;
    }
    return updated;
  }, { isolationLevel: 'Serializable' });
  return completed === dispatcher.taskIds.length;
}
