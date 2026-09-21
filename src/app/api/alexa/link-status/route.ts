// Architecture: API boundary /alexa/link-status; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { resolveAlexaAuthUser } from '@/app/api/alexa/auth';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/rateLimit';
import { alexaRoleError, isAlexaEligibleRole } from '@/lib/alexaScope';
import { logServerError } from '@/lib/serverErrorLog';

export async function GET(req: NextRequest) {
  const authUser = await resolveAlexaAuthUser(req);
  if (!authUser) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  if (!isAlexaEligibleRole(authUser.role)) {
    return NextResponse.json(
      { error: alexaRoleError() },
      { status: 403 }
    );
  }

  const rateKey = `alexa-link-status:${authUser.id}`;
  const allowed = await checkRateLimit(rateKey, { maxRequests: 20, windowMs: 60_000 });
  if (!allowed) {
    return NextResponse.json(
      { error: 'Slow down. Please retry shortly.' },
      { status: 429 }
    );
  }

  try {
    const refreshToken = await prisma.alexaRefreshToken.findFirst({
      where: { userId: authUser.id, revoked: false },
    });
    const latestSkillLink = await prisma.alexaSkillUserLink.findFirst({
      where: { userId: authUser.id },
      orderBy: { updatedAt: 'desc' },
      select: { disabledReason: true, disabledAt: true },
    });

    const disabled = !!latestSkillLink?.disabledAt;
    const linked = !!refreshToken && !disabled;

    const reason =
      linked
        ? null
        : latestSkillLink?.disabledReason
          ? String(latestSkillLink.disabledReason)
          : null;

    return NextResponse.json({ linked, reason });
  } catch (err) {
    logServerError('[api/alexa/link-status] error', err, { userId: authUser.id });
    return NextResponse.json(
      { error: 'Unable to check Alexa link status right now.' },
      { status: 500 }
    );
  }
}
