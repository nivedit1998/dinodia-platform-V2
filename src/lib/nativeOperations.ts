import { prisma } from './prisma';
import { reconcileCredentialLifecycle } from './hubOperatorCredentials';
import { releaseExpiredClaim } from './stage1ClaimContract';
import { createPropertySupportNotifications } from './supportNotifications';

export const NATIVE_OPERATION_BATCH_LIMIT = 100;

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
  });
  await isolate('claim_reservation_expiry', async () => {
    const claims = await prisma.homeClaimReservation.findMany({ where: { state: 'ACTIVE', expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: NATIVE_OPERATION_BATCH_LIMIT, select: { id: true } });
    for (const claim of claims) if ((await releaseExpiredClaim(claim.id, {}, now)).released) releasedClaims += 1;
  });
  return { tasks: taskIds, expiredSupport: expiredSupportCount, expiredRequests: expiredRequestCount, releasedClaims, failedTasks: failures };
}

export async function runNativeMaintenance(now = new Date()) {
  const taskIds = ['expired_dispatch_lease_cleanup'];
  assertTaskRegistryOwner(taskIds, 'vercel_hobby_daily');
  // Only scheduler lease rows are purged here. Business idempotency records
  // have route-specific replay semantics and are intentionally untouched.
  const leases = await prisma.idempotencyRecord.deleteMany({
    where: { namespace: 'native-operations-lease', expiresAt: { lte: now } },
  });
  return { tasks: taskIds, expiredDispatcherLeases: leases.count };
}

export async function acquireOperationsLease(name: string, now = new Date()): Promise<boolean> {
  // One stable row per dispatcher prevents minute-bucket overlap. A bounded
  // 180-second lease intentionally skips a schedule tick if a prior run is
  // still in flight; the next tick may acquire only after expiry.
  const keyHash = name;
  const expiresAt = new Date(now.getTime() + 180_000);
  try {
    const replaced = await prisma.idempotencyRecord.updateMany({
      where: { namespace: 'native-operations-lease', keyHash, expiresAt: { lte: now } },
      data: { requestHash: keyHash, responseStatus: 202, responseDigest: null, responseBody: undefined, expiresAt },
    });
    if (replaced.count === 1) return true;
    await prisma.idempotencyRecord.create({ data: { namespace: 'native-operations-lease', keyHash, requestHash: keyHash, responseStatus: 202, expiresAt } });
    return true;
  } catch { return false; }
}
