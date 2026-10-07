import { prisma } from './prisma';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { reconcileCredentialLifecycle } from './hubOperatorCredentials';
import { releaseExpiredClaim } from './stage1ClaimContract';
import { createPropertySupportNotifications } from './supportNotifications';
import { dispatchInstallationRequestNotifications } from './installationRequestDelivery';

export const NATIVE_OPERATION_BATCH_LIMIT = 100;
export const NATIVE_DISPATCH_LEASE_MS = 120_000;

export const nativeTaskRegistry = Object.freeze([
  { taskId: 'operator_credential_lifecycle', owner: 'supabase_pg_cron_two_minute' },
  { taskId: 'support_expiry_and_revocation', owner: 'supabase_pg_cron_two_minute' },
  { taskId: 'claim_reservation_expiry', owner: 'supabase_pg_cron_two_minute' },
  { taskId: 'expired_dispatch_lease_cleanup', owner: 'vercel_hobby_daily' },
] as const);

const nativeTaskOwnerById = new Map<string, string>([
  ['operator_credential_lifecycle', 'supabase_pg_cron_two_minute'],
  ['support_expiry_and_revocation', 'supabase_pg_cron_two_minute'],
  ['claim_reservation_expiry', 'supabase_pg_cron_two_minute'],
  ['expired_dispatch_lease_cleanup', 'vercel_hobby_daily'],
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
  let installationDelivery = { operationsAccepted: 0, operationsDeferred: 0, operationsFailed: 0, completionAccepted: 0, completionDeferred: 0, completionSuppressed: 0 };
  const failures: string[] = [];
  const isolate = async (taskId: string, run: () => Promise<void>) => {
    try { await run(); } catch { failures.push(taskId); }
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
  });
  await isolate('claim_reservation_expiry', async () => {
    const claims = await prisma.homeClaimReservation.findMany({ where: { state: 'ACTIVE', expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: NATIVE_OPERATION_BATCH_LIMIT, select: { id: true } });
    for (const claim of claims) if ((await releaseExpiredClaim(claim.id, {}, now)).released) releasedClaims += 1;
  });
  return { tasks: taskIds, expiredSupport: expiredSupportCount, expiredRequests: expiredRequestCount, releasedClaims, installationDelivery, failedTasks: failures };
}

export async function runNativeMaintenance(now = new Date()) {
  const taskIds = ['expired_dispatch_lease_cleanup'];
  assertTaskRegistryOwner(taskIds, 'vercel_hobby_daily');
  const leases = await prisma.nativeBackgroundTaskState.updateMany({
    where: { taskId: { not: 'expired_dispatch_lease_cleanup' }, leaseExpiresAt: { lte: now } },
    data: { leaseOwner: null, leaseExpiresAt: null },
  });
  const receipts = await prisma.hubSyncReceipt.deleteMany({ where: { expiresAt: { lte: now } } });
  return { tasks: taskIds, expiredDispatcherLeases: leases.count, expiredSyncReceipts: receipts.count };
}

const taskIdsByDispatcher = {
  'native-operations': { owner: 'OPERATIONS' as const, taskIds: ['operator_credential_lifecycle', 'support_expiry_and_revocation', 'claim_reservation_expiry'] },
  'native-maintenance': { owner: 'MAINTENANCE' as const, taskIds: ['expired_dispatch_lease_cleanup'] },
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
  failedTasks?: string[]; expiredSupport?: number; expiredRequests?: number; releasedClaims?: number; expiredDispatcherLeases?: number; expiredSyncReceipts?: number;
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
