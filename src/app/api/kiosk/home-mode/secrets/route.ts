// Architecture: API boundary /kiosk/home-mode/secrets; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { requireKioskDeviceSession, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { prisma } from '@/lib/prisma';
import { getPublishedHubTokenPlaintext } from '@/lib/hubTokens';
import { getActiveInstallerImpersonation } from '@/lib/installerSupportScope';
import { safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const impersonation = await getActiveInstallerImpersonation(req);
    if (impersonation) {
      return apiFailFromStatus(403, 'Installer impersonation cannot access home-mode secrets.');
    }

    const { user } = await requireKioskDeviceSession(req);
    const { haConnection, user: fullUser } = await getUserWithHaConnection(user.id);
    if (!haConnection.baseUrl) {
      return apiFailFromStatus(400, 'Dinodia Hub connection is not configured.');
    }

    const homeId = fullUser.home?.id;
    if (!homeId) {
      return apiFailFromStatus(400, 'Dinodia Hub connection is not configured for this home.');
    }

    const hubInstall = await prisma.hubInstall.findFirst({
      where: { homeId },
      select: { id: true, publishedHubTokenVersion: true },
    });
    if (!hubInstall) {
      return apiFailFromStatus(400, 'Dinodia Hub agent is not linked to this home yet.');
    }

    const hubToken = await getPublishedHubTokenPlaintext(
      hubInstall.id,
      hubInstall.publishedHubTokenVersion
    );

    const base = new URL(haConnection.baseUrl);
    const port = process.env.HUB_AGENT_PORT || '8099';
    base.port = port;
    const hubBaseUrl = base.toString().replace(/\/+$/, '');

    return NextResponse.json({
      baseUrl: hubBaseUrl,
      longLivedToken: hubToken,
    });
  } catch (err) {
    const trusted = toTrustedDeviceResponse(err);
    if (trusted) {
      safeLog('warn', '[api/kiosk/home-mode/secrets] trusted device rejected', {
        event: 'kiosk_home_mode_secrets_trusted_rejected',
        route: '/api/kiosk/home-mode/secrets',
        status: trusted.status,
      });
      return trusted;
    }
    logServerError('[api/kiosk/home-mode/secrets] failed', err);
    return apiFailFromStatus(500, 'Unable to load Dinodia Hub settings. Please refresh and try again.');
  }
}
