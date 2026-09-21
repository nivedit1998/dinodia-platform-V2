// Architecture: Shared platform helper src/lib/homeownerOnboardingPending.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import {
  AuditEventType,
  HomeStatus,
  HomeownerOnboardingFlowType,
  Prisma,
  PrismaClient,
  Role,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';

const PENDING_TTL_HOURS = 24;
type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

function buildExpiresAt() {
  const value = new Date();
  value.setHours(value.getHours() + PENDING_TTL_HOURS);
  return value;
}

type CreatePendingInput = {
  flowType: HomeownerOnboardingFlowType;
  claimCodeHash?: string | null;
  hubInstallId?: string | null;
  homeId?: number | null;
  userId: number;
  proposedUsername: string;
  proposedPasswordHash: string;
  proposedEmail: string;
  deviceId: string;
  deviceLabel?: string | null;
};

export async function createPendingHomeownerOnboarding(input: CreatePendingInput) {
  const now = new Date();
  await prisma.pendingHomeownerOnboarding.deleteMany({
    where: {
      userId: input.userId,
      policyAcceptedAt: null,
      expiresAt: { lt: now },
    },
  });

  return prisma.pendingHomeownerOnboarding.create({
    data: {
      flowType: input.flowType,
      policyVersionRequired: '2026-V1',
      claimCodeHash: input.claimCodeHash ?? null,
      hubInstallId: input.hubInstallId ?? null,
      homeId: input.homeId ?? null,
      userId: input.userId,
      proposedUsername: input.proposedUsername,
      proposedPasswordHash: input.proposedPasswordHash,
      proposedEmail: input.proposedEmail,
      deviceId: input.deviceId,
      deviceLabel: input.deviceLabel ?? null,
      expiresAt: buildExpiresAt(),
    },
  });
}

export async function getPendingHomeownerOnboardingForUser(
  userId: number,
  client: PrismaClientOrTx = prisma
) {
  const now = new Date();
  return client.pendingHomeownerOnboarding.findFirst({
    where: {
      userId,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function markPendingHomeownerEmailVerified(
  userId: number,
  client: PrismaClientOrTx = prisma
) {
  const pending = await getPendingHomeownerOnboardingForUser(userId, client);
  if (!pending || pending.emailVerifiedAt) {
    return pending;
  }

  return client.pendingHomeownerOnboarding.update({
    where: { id: pending.id },
    data: { emailVerifiedAt: new Date() },
  });
}

export async function markPendingHomeownerPolicyAccepted(userId: number, pendingOnboardingId?: string | null) {
  const now = new Date();
  const pending = pendingOnboardingId
    ? await prisma.pendingHomeownerOnboarding.findFirst({
        where: { id: pendingOnboardingId, userId, expiresAt: { gt: now } },
      })
    : await getPendingHomeownerOnboardingForUser(userId);

  if (!pending || pending.policyAcceptedAt) {
    return pending;
  }

  return prisma.pendingHomeownerOnboarding.update({
    where: { id: pending.id },
    data: { policyAcceptedAt: now },
  });
}

export async function finalizePendingHomeownerOnboarding(params: {
  userId: number;
  pendingOnboardingId?: string | null;
}) {
  const now = new Date();
  const pending = params.pendingOnboardingId
    ? await prisma.pendingHomeownerOnboarding.findFirst({
        where: {
          id: params.pendingOnboardingId,
          userId: params.userId,
          expiresAt: { gt: now },
        },
      })
    : await prisma.pendingHomeownerOnboarding.findFirst({
        where: {
          userId: params.userId,
          expiresAt: { gt: now },
          emailVerifiedAt: { not: null },
          policyAcceptedAt: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      });

  if (!pending) {
    return { finalized: false as const, pendingOnboardingId: null, homeId: null };
  }

  if (!pending.emailVerifiedAt || !pending.policyAcceptedAt) {
    return { finalized: false as const, pendingOnboardingId: pending.id, homeId: pending.homeId ?? null };
  }

  const finalized = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: params.userId },
      select: {
        id: true,
        username: true,
        role: true,
        email: true,
        emailPending: true,
      },
    });

    if (!user || user.role !== Role.ADMIN) {
      throw new Error('Admin account not found for onboarding finalization.');
    }

    let homeId = pending.homeId ?? null;
    if (!homeId && pending.hubInstallId) {
      const hubInstall = await tx.hubInstall.findUnique({
        where: { id: pending.hubInstallId },
        select: { homeId: true },
      });
      homeId = hubInstall?.homeId ?? null;
    }

    if (!homeId && pending.claimCodeHash) {
      const homeByClaim = await tx.home.findUnique({
        where: { claimCodeHash: pending.claimCodeHash },
        select: { id: true },
      });
      homeId = homeByClaim?.id ?? null;
    }

    if (!homeId) {
      throw new Error('No home found for pending onboarding finalization.');
    }

    const home = await tx.home.findUnique({
      where: { id: homeId },
      select: {
        id: true,
        status: true,
        claimCodeConsumedAt: true,
        haConnectionId: true,
        haConnection: { select: { ownerId: true } },
      },
    });

    if (!home) {
      throw new Error('Home not found for onboarding finalization.');
    }

    if (home.haConnection?.ownerId && home.haConnection.ownerId !== user.id) {
      throw new Error('Home already has a different owner.');
    }

    await tx.user.update({
      where: { id: user.id },
      data: {
        homeId,
        haConnectionId: home.haConnectionId,
        email: user.email ?? user.emailPending ?? pending.proposedEmail,
      },
    });

    await tx.haConnection.update({
      where: { id: home.haConnectionId },
      data: { ownerId: user.id },
    });

    await tx.home.update({
      where: { id: home.id },
      data: {
        status: HomeStatus.ACTIVE,
        claimCodeConsumedAt:
          pending.flowType === HomeownerOnboardingFlowType.CLAIM_CODE && !home.claimCodeConsumedAt
            ? now
            : home.claimCodeConsumedAt,
      },
    });

    await tx.pendingHomeownerOnboarding.update({
      where: { id: pending.id },
      data: { homeId },
    });

    if (pending.flowType === HomeownerOnboardingFlowType.CLAIM_CODE) {
      await tx.auditEvent.create({
        data: {
          type: AuditEventType.HOME_CLAIMED,
          homeId,
          actorUserId: user.id,
          metadata: {
            userId: user.id,
            username: user.username,
            pendingOnboardingId: pending.id,
          },
        },
      });
    }

    return { homeId };
  });

  return {
    finalized: true as const,
    pendingOnboardingId: pending.id,
    homeId: finalized.homeId,
  };
}
