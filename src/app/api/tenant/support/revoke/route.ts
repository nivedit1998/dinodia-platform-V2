// Architecture: API boundary /tenant/support/revoke; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { computeSupportApproval } from '@/lib/supportRequests';
import { computeHomeSupportStatus } from '@/lib/supportHomeAccess';

const sanitizeAreas = (areas: Array<{ area: string }>): string[] => {
  const out = new Set<string>();
  for (const entry of areas) {
    const val = (entry.area || '').trim();
    if (val) out.add(val);
  }
  return Array.from(out);
};

const intersect = (a: string[], b: Set<string>) => a.filter((x) => b.has(x));

export async function POST(_req: NextRequest) {
  const me = await getCurrentUserFromRequest(_req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const tenant = await prisma.user.findUnique({
    where: { id: me.id },
    select: {
      id: true,
      homeId: true,
      accessRules: { select: { area: true } },
    },
  });

  if (!tenant || !tenant.homeId) {
    return apiFailFromStatus(400, 'This account is not linked to a home.');
  }

  const tenantAreas = sanitizeAreas(tenant.accessRules);
  const tenantAreaSet = new Set(tenantAreas);

  const homeUsers = await prisma.user.findMany({
    where: { homeId: tenant.homeId, role: { in: [Role.ADMIN, Role.TENANT] } },
    select: {
      id: true,
      role: true,
      accessRules: { select: { area: true } },
    },
  });

  const userById = new Map(
    homeUsers.map((u) => [
      u.id,
      {
        role: u.role,
        areas: sanitizeAreas(u.accessRules),
      },
    ])
  );

  const supportRequests = await prisma.supportRequest.findMany({
    where: {
      homeId: tenant.homeId,
      kind: { in: ['HOME_ACCESS', 'USER_REMOTE_ACCESS'] },
      revokedAt: null,
    },
    select: {
      id: true,
      kind: true,
      homeId: true,
      targetUserId: true,
      installerUserId: true,
      authChallengeId: true,
      approvedAt: true,
      approvalValidUntil: true,
      revokedAt: true,
      haSessionStartedAt: true,
      haSessionExpiresAt: true,
      haSessionEndedAt: true,
      haSessionFailureAt: true,
      haSessionRevokedAt: true,
      haSecurityCodeConsumedAt: true,
      haSecurityCodeExpiresAt: true,
      scope: true,
      reason: true,
    },
  });

  if (supportRequests.length === 0) {
    return NextResponse.json({ ok: true, revokedCount: 0, revokedRequestIds: [] });
  }

  const challengeIds = Array.from(
    new Set(
      supportRequests
        .map((r) => r.authChallengeId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );
  const challenges = await prisma.authChallenge.findMany({
    where: { id: { in: challengeIds } },
    select: { id: true, approvedAt: true, consumedAt: true, expiresAt: true },
  });
  const challengeById = new Map(challenges.map((c) => [c.id, c]));

  const candidates = supportRequests.filter((supportRequest) => {
    if (supportRequest.kind === 'HOME_ACCESS') {
      const homeStatus = computeHomeSupportStatus(
        {
          approvedAt: supportRequest.approvedAt,
          approvalValidUntil: supportRequest.approvalValidUntil,
          revokedAt: supportRequest.revokedAt,
          haSessionRevokedAt: supportRequest.haSessionRevokedAt,
          haSessionFailureAt: supportRequest.haSessionFailureAt,
          haSessionStartedAt: supportRequest.haSessionStartedAt,
          haSessionExpiresAt: supportRequest.haSessionExpiresAt,
          haSessionEndedAt: supportRequest.haSessionEndedAt,
          haSecurityCodeConsumedAt: supportRequest.haSecurityCodeConsumedAt,
          haSecurityCodeExpiresAt: supportRequest.haSecurityCodeExpiresAt,
        },
        []
      );
      if (homeStatus !== 'APPROVED' && homeStatus !== 'ACTIVE') {
        return false;
      }
    } else {
      const approval = computeSupportApproval(
        supportRequest.authChallengeId ? challengeById.get(supportRequest.authChallengeId) ?? null : null
      );
      if (approval.status !== 'APPROVED' || !approval.validUntil) {
        return false;
      }
    }

    if (supportRequest.kind === 'HOME_ACCESS') {
      return tenantAreas.length > 0;
    }
    if (!supportRequest.targetUserId) {
      return false;
    }
    const target = userById.get(supportRequest.targetUserId);
    if (!target || target.role !== Role.TENANT) {
      return false;
    }
    return intersect(target.areas, tenantAreaSet).length > 0;
  });

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, revokedCount: 0, revokedRequestIds: [] });
  }

  const now = new Date();
  const candidateIds = candidates.map((c) => c.id);
  const outcome = await prisma.$transaction(async (tx) => {
    const revocable = await tx.supportRequest.findMany({
      where: {
        id: { in: candidateIds },
        revokedAt: null,
      },
      select: {
        id: true,
        kind: true,
        homeId: true,
        installerUserId: true,
        targetUserId: true,
        authChallengeId: true,
        scope: true,
        reason: true,
      },
    });

    if (revocable.length === 0) {
      return { revokedRequestIds: [] as string[] };
    }

    const revokedRequestIds = revocable.map((r) => r.id);
    const revokedChallengeIds = Array.from(
      new Set(
        revocable
          .map((r) => r.authChallengeId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
      )
    );

    await tx.supportRequest.updateMany({
      where: {
        id: { in: revokedRequestIds },
        revokedAt: null,
      },
      data: {
        revokedAt: now,
        revokedByUserId: me.id,
      },
    });

    if (revokedChallengeIds.length > 0) {
      await tx.authChallenge.updateMany({
        where: {
          id: { in: revokedChallengeIds },
          consumedAt: null,
        },
        data: {
          consumedAt: now,
        },
      });
    }

    for (const supportRequest of revocable) {
      await tx.auditEvent.create({
        data: {
          type: AuditEventType.SUPPORT_REQUEST_REVOKED,
          homeId: supportRequest.homeId,
          actorUserId: me.id,
          metadata: {
            supportRequestId: supportRequest.id,
            kind: supportRequest.kind,
            installerUserId: supportRequest.installerUserId,
            targetUserId: supportRequest.targetUserId,
            scope: supportRequest.scope,
            reason: supportRequest.reason,
            revokedAt: now.toISOString(),
          },
        },
      });
    }

    return { revokedRequestIds };
  });

  return NextResponse.json({
    ok: true,
    revokedAt: now.toISOString(),
    revokedCount: outcome.revokedRequestIds.length,
    revokedRequestIds: outcome.revokedRequestIds,
  });
}
