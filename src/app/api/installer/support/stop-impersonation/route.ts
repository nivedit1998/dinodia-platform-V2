// Architecture: API boundary /installer/support/stop-impersonation; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType } from '@prisma/client';
import { cookies } from 'next/headers';
import { clearAuthCookie, setAuthCookie } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getActiveInstallerImpersonation } from '@/lib/installerSupportScope';

const BACKUP_COOKIE_NAME = 'dinodia_installer_backup_token';

export async function GET(req: NextRequest) {
  const impersonation = await getActiveInstallerImpersonation(req);

  const cookieStore = await cookies();
  const backup = cookieStore.get(BACKUP_COOKIE_NAME)?.value ?? null;

  if (impersonation?.supportRequestId && Number.isInteger(impersonation.installerUserId)) {
    const supportRequest = await prisma.supportRequest.findUnique({
      where: { id: impersonation.supportRequestId },
      select: {
        id: true,
        homeId: true,
        installerUserId: true,
        targetUserId: true,
        scope: true,
        reason: true,
      },
    });

    if (supportRequest && supportRequest.installerUserId === impersonation.installerUserId) {
      await prisma.auditEvent.create({
        data: {
          type: AuditEventType.SUPPORT_IMPERSONATION_STOPPED,
          homeId: supportRequest.homeId,
          actorUserId: impersonation.installerUserId,
          metadata: {
            supportRequestId: supportRequest.id,
            targetUserId: supportRequest.targetUserId,
            scope: supportRequest.scope,
            reason: supportRequest.reason,
            installerDeviceId: impersonation.installerDeviceId,
            issuedAt: impersonation.issuedAt,
            expiresAt: impersonation.expiresAt,
            restoredInstallerSession: Boolean(backup),
          },
        },
      });
    }
  }

  if (!backup) {
    await clearAuthCookie();
    cookieStore.set(BACKUP_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
    return NextResponse.json({ ok: true, restored: false });
  }

  await setAuthCookie(backup);
  cookieStore.set(BACKUP_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });

  return NextResponse.json({ ok: true, restored: true });
}
