// Stage 1 support lease reconciliation. This runs only from the shared
// native-operations dispatcher; it must not become a feature-specific cron.
import { prisma } from '@/lib/prisma';

export async function reconcileSupportAccessLifecycle(now = new Date()) {
  const expiredSessions = await prisma.supportAccessSession.findMany({
    where: { status: { in: ['APPROVED', 'ACTIVE'] }, expiresAt: { lte: now }, endedAt: null },
    select: { id: true, supportRequestId: true, homeId: true },
  });
  let expiredSessionCount = 0;
  for (const session of expiredSessions) {
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.supportAccessSession.updateMany({
        where: { id: session.id, status: { in: ['APPROVED', 'ACTIVE'] }, endedAt: null },
        data: { status: 'REVOKED', endedAt: now, codeHash: null, codeIssuedAt: null, codeExpiresAt: null, employeeProofHash: null, employeeProofExpiresAt: null, codeAttemptCount: 0, hubRevokePending: true, hubRevocationDesiredAt: now },
      });
      if (result.count === 1) await tx.auditEvent.create({ data: { homeId: session.homeId, actorUserId: null, type: 'SUPPORT_V2_ACCESS_CLOSED', metadata: { sessionId: session.id, ticketId: session.supportRequestId, outcome: 'expired', hubRevocationPending: true } } });
      return result.count;
    });
    expiredSessionCount += changed;
  }

  const expiredLeases = await prisma.supportAccessSession.findMany({
    where: { status: 'ACTIVE', hubLeaseExpiresAt: { lte: now }, endedAt: null },
    select: { id: true, supportRequestId: true, homeId: true },
  });
  let expiredLeaseCount = 0;
  for (const session of expiredLeases) {
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.supportAccessSession.updateMany({
        where: { id: session.id, status: 'ACTIVE', hubLeaseExpiresAt: { lte: now }, endedAt: null },
        data: { status: 'REVOKED', endedAt: now, hubLeaseTokenHash: null, hubLeaseExpiresAt: null, hubRevokePending: true, hubRevocationDesiredAt: now },
      });
      if (result.count === 1) await tx.auditEvent.create({ data: { homeId: session.homeId, actorUserId: null, type: 'SUPPORT_V2_ACCESS_CLOSED', metadata: { sessionId: session.id, ticketId: session.supportRequestId, outcome: 'lease_expired', hubRevocationPending: true } } });
      return result.count;
    });
    expiredLeaseCount += changed;
  }

  return { expiredSessions: expiredSessionCount, expiredLeases: expiredLeaseCount };
}
