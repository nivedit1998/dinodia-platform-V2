import { prisma } from './prisma';
import { reconcileCredentialLifecycle } from './hubOperatorCredentials';
import { releaseExpiredClaim } from './stage1ClaimContract';

export async function runNativeOperations(now = new Date()) {
  const credentials = await reconcileCredentialLifecycle(now);
  const expiredSupport = await prisma.supportSession.updateMany({ where: { status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED', endedAt: now, desiredRevokedAt: now } });
  const expiredRequests = await prisma.supportAccessRequest.updateMany({ where: { status: { in: ['REQUESTED', 'APPROVED', 'ISSUED'] }, codeExpiresAt: { lte: now } }, data: { status: 'EXPIRED', revision: { increment: 1 } } });
  const claims = await prisma.homeClaimReservation.findMany({ where: { state: 'ACTIVE', expiresAt: { lte: now } }, select: { id: true } });
  let releasedClaims = 0;
  for (const claim of claims) if ((await releaseExpiredClaim(claim.id)).released) releasedClaims += 1;
  return { credentials, expiredSupport: expiredSupport.count, expiredRequests: expiredRequests.count, releasedClaims };
}

export async function acquireOperationsLease(name: string, now = new Date()): Promise<boolean> {
  const keyHash = `${name}:${Math.floor(now.getTime() / 60_000)}`;
  try {
    await prisma.idempotencyRecord.create({ data: { namespace: 'native-operations-lease', keyHash, requestHash: keyHash, responseStatus: 202, expiresAt: new Date(now.getTime() + 120_000) } });
    return true;
  } catch { return false; }
}
