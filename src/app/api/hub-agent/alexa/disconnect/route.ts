// Architecture: signed Hub Agent boundary for removing the native Alexa link.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { authenticateNativeHubEnvelope } from '@/lib/alexaNativeHubAuth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const hubInstall = await authenticateNativeHubEnvelope(body || {});
    if ((body as Record<string, unknown>)?.confirm !== true) return apiFailFromStatus(400, 'Disconnect confirmation is required.');
    const homeownerLinks = await prisma.alexaSkillUserLink.findMany({ where: { homeId: hubInstall.homeId!, scope: 'HOMEOWNER', disabledAt: null }, select: { userId: true } });
    await prisma.$transaction(async (tx) => {
      const userIds = homeownerLinks.map((link) => link.userId);
      if (userIds.length) {
        await tx.alexaSkillUserLink.updateMany({ where: { homeId: hubInstall.homeId!, scope: 'HOMEOWNER', disabledAt: null }, data: { disabledAt: new Date(), disabledReason: 'DINODIA_HOME_DISCONNECT' } });
        await tx.alexaRefreshToken.updateMany({ where: { userId: { in: userIds }, revoked: false }, data: { revoked: true, revokedAt: new Date() } });
        await tx.alexaEventToken.deleteMany({ where: { userId: { in: userIds } } });
      }
      const activeLinks = await tx.alexaSkillUserLink.count({ where: { homeId: hubInstall.homeId!, disabledAt: null } });
      await tx.alexaHomeConnection.updateMany({ where: { homeId: hubInstall.homeId! }, data: { status: activeLinks > 0 ? 'LINKED' : 'DISCONNECTED', lastErrorCode: null, lastErrorAt: null } });
    });
    return NextResponse.json({ ok: true, status: homeownerLinks.length ? 'DISCONNECTED' : 'LINKED', revokedHomeownerLinks: homeownerLinks.length });
  } catch (error) {
    return apiFailFromStatus(Number((error as { statusCode?: number })?.statusCode || 500), error instanceof Error ? error.message : 'Unable to disconnect Alexa.');
  }
}
