import { prisma } from './prisma';
import { reconcileCredentialLifecycle } from './hubOperatorCredentials';
import { releaseExpiredClaim } from './stage1ClaimContract';
import { createPropertySupportNotifications } from './supportNotifications';

export async function runNativeOperations(now = new Date()) {
  const credentials = await reconcileCredentialLifecycle(now);
  const expiredSupportRows = await prisma.supportSession.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: now } }, select: { id: true, homeId: true, ticketId: true, accessRequestId: true } });
  let expiredSupportCount = 0;
  for (const session of expiredSupportRows) {
    await prisma.$transaction(async (tx) => {
      const expired = await tx.supportSession.updateMany({ where: { id: session.id, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED', endedAt: now, desiredRevokedAt: now } });
      if (expired.count !== 1) return;
      expiredSupportCount += 1;
      await createPropertySupportNotifications(tx, { homeId: session.homeId, ticketId: session.ticketId, accessRequestId: session.accessRequestId, sessionId: session.id, eventType: 'EXPIRED' });
      await tx.auditEvent.create({ data: { homeId: session.homeId, actorType: 'SYSTEM', actorId: null, category: 'SECURITY', action: 'support_access_expired', targetType: 'SupportSession', targetId: session.id, metadata: { outcome: 'expired', hubAcknowledgementPending: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    });
  }
  const expiredRequests = await prisma.supportAccessRequest.updateMany({ where: { status: { in: ['REQUESTED', 'APPROVED', 'ISSUED'] }, codeExpiresAt: { lte: now } }, data: { status: 'EXPIRED', revision: { increment: 1 } } });
  const claims = await prisma.homeClaimReservation.findMany({ where: { state: 'ACTIVE', expiresAt: { lte: now } }, select: { id: true } });
  let releasedClaims = 0;
  for (const claim of claims) if ((await releaseExpiredClaim(claim.id, {}, now)).released) releasedClaims += 1;
  return { credentials, expiredSupport: expiredSupportCount, expiredRequests: expiredRequests.count, releasedClaims };
}

export async function acquireOperationsLease(name: string, now = new Date()): Promise<boolean> {
  const keyHash = `${name}:${Math.floor(now.getTime() / 60_000)}`;
  try {
    await prisma.idempotencyRecord.create({ data: { namespace: 'native-operations-lease', keyHash, requestHash: keyHash, responseStatus: 202, expiresAt: new Date(now.getTime() + 120_000) } });
    return true;
  } catch { return false; }
}
