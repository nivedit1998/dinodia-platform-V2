// Architecture: API boundary /installer/support/user-access/request; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { AuditEventType, AuthChallengePurpose } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { createAuthChallenge, buildVerifyUrl, getAppUrl } from '@/lib/authChallenges';
import { buildSupportApprovalEmail } from '@/lib/emailTemplates';
import { sendEmail } from '@/lib/email';
import { computeSupportApproval } from '@/lib/supportRequests';
import { canAccessSupportAuditSection } from '@/lib/companyPortalAccess';

const TTL_MINUTES = 60;
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 500;
const USER_SCOPE = 'IMPERSONATE_USER';

function parseSupportReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < MIN_REASON_LENGTH || value.length > MAX_REASON_LENGTH) return null;
  return value;
}

function parseUserScope(raw: unknown): typeof USER_SCOPE | null {
  if (raw === USER_SCOPE) {
    return USER_SCOPE;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || !canAccessSupportAuditSection(me.role)) {
    return apiFailFromStatus(401, 'Installer access required.');
  }

  const body = await req.json().catch(() => null);
  const homeId = Number(body?.homeId ?? 0);
  const userId = Number(body?.userId ?? 0);
  const reason = parseSupportReason(body?.reason);
  const scope = parseUserScope(body?.scope);
  if (!Number.isInteger(homeId) || homeId <= 0 || !Number.isInteger(userId) || userId <= 0) {
    return apiFailFromStatus(400, 'Invalid home or user id.');
  }
  if (!reason) {
    return apiFailFromStatus(400, 'Support reason must be 8-500 characters.');
  }
  if (!scope) {
    return apiFailFromStatus(400, 'Invalid support scope for user access.');
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, username: true, homeId: true },
  });

  if (!targetUser || targetUser.homeId !== homeId) {
    return apiFailFromStatus(404, 'User not found for this home.');
  }

  if (!targetUser.email) {
    return apiFailFromStatus(400, 'User has no email set for approvals.');
  }

  // Reuse existing approved request within window
  const existing = await prisma.supportRequest.findFirst({
    where: {
      kind: 'USER_REMOTE_ACCESS',
      homeId,
      installerUserId: me.id,
      targetUserId: targetUser.id,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, authChallengeId: true },
  });
  if (existing) {
    if (existing.authChallengeId) {
      const challenge = await prisma.authChallenge.findUnique({
        where: { id: existing.authChallengeId },
        select: { approvedAt: true, expiresAt: true, consumedAt: true },
      });
      const approval = computeSupportApproval(challenge);
      if (approval.status === 'APPROVED') {
        return NextResponse.json({
          ok: true,
          requestId: existing.id,
          expiresAt: approval.expiresAt,
          validUntil: approval.validUntil,
          approvedAt: approval.approvedAt,
        });
      }
    }
  }

  const challenge = await createAuthChallenge({
    userId: targetUser.id,
    purpose: AuthChallengePurpose.SUPPORT_USER_REMOTE_SUPPORT,
    email: targetUser.email,
    ttlMinutes: TTL_MINUTES,
  });

  const supportRequest = await prisma.supportRequest.create({
    data: {
      kind: 'USER_REMOTE_ACCESS',
      homeId,
      targetUserId: targetUser.id,
      installerUserId: me.id,
      authChallengeId: challenge.id,
      reason,
      scope,
    },
  });

  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.SUPPORT_REQUEST_CREATED,
      homeId,
      actorUserId: me.id,
      metadata: {
        supportRequestId: supportRequest.id,
        kind: 'USER_REMOTE_ACCESS',
        targetUserId: targetUser.id,
        authChallengeId: challenge.id,
        scope,
        reason,
      },
    },
  });

  const appUrl = getAppUrl();
  const verifyUrl = buildVerifyUrl(challenge.token);
  const email = buildSupportApprovalEmail({
    kind: 'SUPPORT_USER_REMOTE_SUPPORT',
    verifyUrl,
    appUrl,
    installerUsername: me.username,
    homeId,
    targetUsername: targetUser.username ?? undefined,
    reason,
    scope,
  });

  await sendEmail({
    to: targetUser.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  return NextResponse.json({
    ok: true,
    requestId: supportRequest.id,
    expiresAt: challenge.expiresAt,
    validUntil: null,
    approvedAt: null,
  });
}
