// Architecture: Shared platform helper src/lib/supportRequests.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { AuthChallenge, PrismaClient, SupportRequestKind } from '@prisma/client';
import { computeHomeSupportStatus, getLatestHomeSupportRequest } from '@/lib/supportHomeAccess';

export const SUPPORT_APPROVAL_WINDOW_MINUTES = 60;

export type SupportApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'EXPIRED'
  | 'CONSUMED'
  | 'NOT_FOUND'
  | 'ACTIVE'
  | 'FAILED'
  | 'REVOKED';

export type SupportApprovalInfo = {
  status: SupportApprovalStatus;
  approvedAt: Date | null;
  expiresAt: Date | null;
  validUntil: Date | null;
};

export function computeSupportApproval(
  challenge: Pick<AuthChallenge, 'approvedAt' | 'expiresAt' | 'consumedAt'> | null
): SupportApprovalInfo {
  if (!challenge) {
    return { status: 'NOT_FOUND', approvedAt: null, expiresAt: null, validUntil: null };
  }
  const now = new Date();

  if (challenge.consumedAt) {
    return {
      status: 'CONSUMED',
      approvedAt: challenge.approvedAt ?? null,
      expiresAt: challenge.expiresAt ?? null,
      validUntil: null,
    };
  }

  const expiresAt = challenge.expiresAt ?? null;
  const approvedAt = challenge.approvedAt ?? null;

  if (approvedAt) {
    const validUntil = new Date(approvedAt.getTime() + SUPPORT_APPROVAL_WINDOW_MINUTES * 60 * 1000);
    if (validUntil < now) {
      return { status: 'EXPIRED', approvedAt, expiresAt, validUntil };
    }
    return { status: 'APPROVED', approvedAt, expiresAt, validUntil };
  }

  if (expiresAt && expiresAt < now) {
    return { status: 'EXPIRED', approvedAt, expiresAt, validUntil: null };
  }

  return { status: 'PENDING', approvedAt, expiresAt, validUntil: null };
}

export type SupportApprovalSummary = {
  requestId: string;
  status: SupportApprovalStatus;
  approvedAt: Date | null;
  validUntil: Date | null;
  expiresAt: Date | null;
};

export type ActiveSupportApprovalContext = {
  requestId: string;
  approvedAt: Date;
  validUntil: Date;
  expiresAt: Date | null;
};

export type SupportAccessRequirement = {
  latest: SupportApprovalSummary | null;
  active: ActiveSupportApprovalContext | null;
};

async function resolveLatestUserSupportApproval(
  prisma: PrismaClient,
  where: {
    homeId: number;
    installerUserId: number;
    kind: SupportRequestKind;
    targetUserId?: number;
  }
): Promise<SupportAccessRequirement> {
  const latest = await prisma.supportRequest.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
    select: { id: true, authChallengeId: true },
  });

  if (!latest || !latest.authChallengeId) {
    return { latest: null, active: null };
  }

  const challenge = await prisma.authChallenge.findUnique({
    where: { id: latest.authChallengeId },
    select: { approvedAt: true, expiresAt: true, consumedAt: true },
  });

  const approval = computeSupportApproval(challenge);
  const summary: SupportApprovalSummary = {
    requestId: latest.id,
    status: approval.status,
    approvedAt: approval.approvedAt,
    validUntil: approval.validUntil,
    expiresAt: approval.expiresAt,
  };

  if (approval.status !== 'APPROVED' || !approval.approvedAt || !approval.validUntil) {
    return { latest: summary, active: null };
  }

  return {
    latest: summary,
    active: {
      requestId: latest.id,
      approvedAt: approval.approvedAt,
      validUntil: approval.validUntil,
      expiresAt: approval.expiresAt,
    },
  };
}

export async function requireActiveHomeAccess(params: {
  prisma: PrismaClient;
  homeId: number;
  installerUserId: number;
}): Promise<SupportAccessRequirement> {
  const { prisma, homeId, installerUserId } = params;
  const latest = await getLatestHomeSupportRequest(prisma, homeId, installerUserId);
  if (!latest) return { latest: null, active: null };

  const status = computeHomeSupportStatus(latest, latest.approvalTokens);
  const summary: SupportApprovalSummary = {
    requestId: latest.id,
    status,
    approvedAt: latest.approvedAt ?? null,
    validUntil: latest.approvalValidUntil ?? null,
    expiresAt: latest.approvalTokens[0]?.expiresAt ?? null,
  };

  if (status !== 'APPROVED' && status !== 'ACTIVE') {
    return { latest: summary, active: null };
  }

  const approvedAt = latest.approvedAt;
  const validUntil = latest.approvalValidUntil;
  if (!approvedAt || !validUntil) {
    return { latest: summary, active: null };
  }

  return {
    latest: summary,
    active: {
      requestId: latest.id,
      approvedAt,
      validUntil,
      expiresAt: latest.approvalTokens[0]?.expiresAt ?? null,
    },
  };
}

export async function requireActiveUserAccess(params: {
  prisma: PrismaClient;
  homeId: number;
  installerUserId: number;
  targetUserId: number;
}): Promise<SupportAccessRequirement> {
  const { prisma, homeId, installerUserId, targetUserId } = params;
  return resolveLatestUserSupportApproval(prisma, {
    homeId,
    installerUserId,
    kind: 'USER_REMOTE_ACCESS',
    targetUserId,
  });
}
