// Architecture: API boundary /installer/support/requests/[requestId]/impersonate; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { AuditEventType, Role } from '@prisma/client';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import {
  AuthUser,
  createTokenWithExpiry,
  getCurrentUserFromRequest,
  setAuthCookieWithTtl,
} from '@/lib/auth';
import { computeSupportApproval } from '@/lib/supportRequests';
import { ensureActiveDevice } from '@/lib/deviceRegistry';
import { readDeviceHeaders } from '@/lib/deviceAuth';
import {
  INSTALLER_IMPERSONATION_SCOPE,
  isScopeAllowedForImpersonation,
} from '@/lib/installerSupportScope';
import { canAccessSupportAuditSection } from '@/lib/companyPortalAccess';

const AUTH_COOKIE_NAME = 'dinodia_token';
const BACKUP_COOKIE_NAME = 'dinodia_installer_backup_token';
const IMPERSONATION_TTL_SECONDS = 15 * 60; // 15 minutes

async function resolveInstallerDeviceId(req: NextRequest, installerUserId: number): Promise<string | null> {
  const headerDeviceId = readDeviceHeaders(req).deviceId;

  if (headerDeviceId) {
    const trustedByHeader = await prisma.trustedDevice.findUnique({
      where: { userId_deviceId: { userId: installerUserId, deviceId: headerDeviceId } },
      select: { revokedAt: true },
    });
    if (trustedByHeader && !trustedByHeader.revokedAt) {
      try {
        await ensureActiveDevice(headerDeviceId);
        return headerDeviceId;
      } catch {
        return null;
      }
    }
  }

  const mostRecentTrusted = await prisma.trustedDevice.findFirst({
    where: { userId: installerUserId, revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    select: { deviceId: true },
  });
  if (!mostRecentTrusted?.deviceId) {
    return null;
  }

  try {
    await ensureActiveDevice(mostRecentTrusted.deviceId);
  } catch {
    return null;
  }
  return mostRecentTrusted.deviceId;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ requestId: string }> }
) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || !canAccessSupportAuditSection(me.role)) {
    return apiFailFromStatus(401, 'Installer access required.');
  }

  const { requestId } = await context.params;
  if (!requestId) {
    return apiFailFromStatus(400, 'Missing request id.');
  }

  const supportRequest = await prisma.supportRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      kind: true,
      homeId: true,
      targetUserId: true,
      installerUserId: true,
      authChallengeId: true,
      scope: true,
      reason: true,
    },
  });

  if (
    !supportRequest ||
    supportRequest.installerUserId !== me.id ||
    supportRequest.kind !== 'USER_REMOTE_ACCESS' ||
    !supportRequest.targetUserId ||
    !supportRequest.authChallengeId ||
    !isScopeAllowedForImpersonation(supportRequest.scope)
  ) {
    return apiFailFromStatus(404, 'Support request not found.');
  }

  const challenge = await prisma.authChallenge.findUnique({
    where: { id: supportRequest.authChallengeId },
    select: { approvedAt: true, expiresAt: true, consumedAt: true },
  });

  const approval = computeSupportApproval(challenge);
  if (approval.status !== 'APPROVED') {
    return apiFailFromStatus(403, 'Support request is not approved or expired.');
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: supportRequest.targetUserId },
    select: { id: true, username: true, role: true },
  });

  if (!targetUser) {
    return apiFailFromStatus(404, 'Target user not found.');
  }

  const cookieStore = await cookies();
  const currentToken = cookieStore.get(AUTH_COOKIE_NAME)?.value ?? null;
  if (!currentToken) {
    return apiFailFromStatus(401, 'Missing installer session.');
  }

  const installerDeviceId = await resolveInstallerDeviceId(req, me.id);
  if (!installerDeviceId) {
    return apiFailFromStatus(403, 'This installer device is not trusted for impersonation.');
  }

  // Backup installer session for 15 minutes
  cookieStore.set(BACKUP_COOKIE_NAME, currentToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: IMPERSONATION_TTL_SECONDS,
  });

  const impersonation: AuthUser = {
    id: targetUser.id,
    username: targetUser.username,
    role: targetUser.role,
  };
  const issuedAtIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + IMPERSONATION_TTL_SECONDS * 1000).toISOString();
  const token = createTokenWithExpiry(impersonation, IMPERSONATION_TTL_SECONDS, {
    installerUserId: me.id,
    supportRequestId: supportRequest.id,
    installerDeviceId,
    scope: INSTALLER_IMPERSONATION_SCOPE,
    issuedAt: issuedAtIso,
    expiresAt: expiresAtIso,
  });

  await setAuthCookieWithTtl(token, IMPERSONATION_TTL_SECONDS);

  const consumedAt = new Date();
  await prisma.$transaction([
    prisma.supportRequest.updateMany({
      where: {
        id: supportRequest.id,
        consumedAt: null,
      },
      data: { consumedAt },
    }),
    prisma.auditEvent.create({
      data: {
        type: AuditEventType.SUPPORT_IMPERSONATION_STARTED,
        homeId: supportRequest.homeId,
        actorUserId: me.id,
        metadata: {
          supportRequestId: supportRequest.id,
          targetUserId: supportRequest.targetUserId,
          scope: supportRequest.scope,
          reason: supportRequest.reason,
          installerDeviceId,
          issuedAt: issuedAtIso,
          expiresAt: expiresAtIso,
          startedAt: consumedAt.toISOString(),
        },
      },
    }),
  ]);

  const redirectTo = targetUser.role === Role.ADMIN ? '/admin/dashboard' : '/tenant/dashboard';
  return NextResponse.json({ ok: true, redirectTo });
}
