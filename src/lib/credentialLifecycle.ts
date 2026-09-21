// Stage 1 credential lifecycle reconciliation. This is deliberately a task
// invoked by the existing shared operational dispatcher; it is not a new
// route, provider schedule or feature-specific cron.
import { HubOperatorCredentialStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createPendingOperatorCredential, OPERATOR_GRACE_MINUTES, OPERATOR_ROTATE_MINUTES } from '@/lib/hubOperatorCredentials';

export async function reconcileOperatorCredentialLifecycle(now = new Date()) {
  const graceCandidates = await prisma.hubOperatorCredential.findMany({
    where: { status: HubOperatorCredentialStatus.GRACE, graceUntil: { lte: now } },
    select: { id: true, version: true, hubInstallId: true, hubInstall: { select: { homeId: true } } },
  });
  let expiredGraceCount = 0;
  for (const candidate of graceCandidates) {
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.hubOperatorCredential.updateMany({ where: { id: candidate.id, status: HubOperatorCredentialStatus.GRACE, graceUntil: { lte: now } }, data: { status: HubOperatorCredentialStatus.REVOKED, revokedAt: now } });
      if (result.count === 1 && candidate.hubInstall.homeId) await tx.auditEvent.create({ data: { homeId: candidate.hubInstall.homeId, actorUserId: null, type: 'OS_OPERATOR_CREDENTIAL_REVOKED', metadata: { hubInstallId: candidate.hubInstallId, version: candidate.version, reason: 'grace_expired', outcome: 'revoked' } } });
      return result.count;
    });
    expiredGraceCount += changed;
  }

  const hubs = await prisma.hubInstall.findMany({
    select: {
      id: true,
      operatorRotateEveryMinutes: true,
      operatorGraceMinutes: true,
      publishedOperatorCredentialVersion: true,
      operatorCredentials: {
        where: { status: { in: [HubOperatorCredentialStatus.ACTIVE, HubOperatorCredentialStatus.PENDING, HubOperatorCredentialStatus.DELIVERED, HubOperatorCredentialStatus.ACKNOWLEDGED] } },
        orderBy: { version: 'desc' },
        take: 2,
        select: { version: true, status: true, activatedAt: true },
      },
    },
  });

  let pendingCreated = 0;
  for (const hub of hubs) {
    const pending = hub.operatorCredentials.find((credential) => ([HubOperatorCredentialStatus.PENDING, HubOperatorCredentialStatus.DELIVERED, HubOperatorCredentialStatus.ACKNOWLEDGED] as HubOperatorCredentialStatus[]).includes(credential.status));
    if (pending) continue;
    const active = hub.operatorCredentials.find((credential) => credential.status === HubOperatorCredentialStatus.ACTIVE);
    if (!active?.activatedAt) continue;
    const rotateMinutes = Math.max(1, Number(hub.operatorRotateEveryMinutes || OPERATOR_ROTATE_MINUTES));
    if (now.getTime() - active.activatedAt.getTime() < rotateMinutes * 60_000) continue;
    const nextVersion = Math.max(hub.publishedOperatorCredentialVersion || 0, active.version) + 1;
    const created = await createPendingOperatorCredential(hub.id, nextVersion);
    if (created.record.status === HubOperatorCredentialStatus.PENDING && created.record.version === nextVersion) pendingCreated += 1;
  }

  return {
    expiredGrace: expiredGraceCount,
    pendingCreated,
    rotateEveryMinutes: OPERATOR_ROTATE_MINUTES,
    graceMinutes: OPERATOR_GRACE_MINUTES,
  };
}
