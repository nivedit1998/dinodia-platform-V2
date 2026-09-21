// Architecture: API boundary /internal/alexa/skill-events/account-linked; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromAuthorizationHeader } from '@/lib/auth';
import { alexaScopeForRole, isAlexaEligibleRole } from '@/lib/alexaScope';

function getBearerToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function parseTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.ALEXA_SKILL_EVENTS_INTERNAL_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 500 });

  const token = getBearerToken(req);
  if (token !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const obj = body as Record<string, unknown>;
  const alexaUserId = typeof obj.alexaUserId === 'string' ? obj.alexaUserId.trim() : '';
  const accessToken = typeof obj.accessToken === 'string' ? obj.accessToken.trim() : '';

  if (!alexaUserId || !accessToken) {
    return NextResponse.json({ error: 'Missing alexaUserId/accessToken' }, { status: 400 });
  }

  const user = await getUserFromAuthorizationHeader(`Bearer ${accessToken}`);
  if (!user || !isAlexaEligibleRole(user.role)) {
    return NextResponse.json({ error: 'Invalid access token' }, { status: 401 });
  }
  const linkedUser = await prisma.user.findUnique({ where: { id: user.id }, select: { homeId: true } });

  const skillId = typeof obj.skillId === 'string' ? obj.skillId.trim() : null;
  const marketplace = typeof obj.marketplace === 'string' ? obj.marketplace.trim() : null;
  const locale = typeof obj.locale === 'string' ? obj.locale.trim() : null;
  const eventAt = parseTimestamp(obj.timestamp);
  const requestId = typeof obj.requestId === 'string' ? obj.requestId.trim() : null;

  await prisma.$transaction(async (tx) => {
    await tx.alexaSkillUserLink.upsert({
    where: { alexaUserId },
    create: {
      alexaUserId,
      userId: user.id,
      homeId: linkedUser?.homeId ?? null,
      scope: alexaScopeForRole(user.role),
      skillId,
      marketplace,
      locale,
      linkedAt: new Date(),
      disabledAt: null,
      disabledReason: null,
      lastEventAt: eventAt ?? null,
      lastEventRequestId: requestId,
    },
    update: {
      userId: user.id,
      homeId: linkedUser?.homeId ?? null,
      scope: alexaScopeForRole(user.role),
      skillId,
      marketplace,
      locale,
      linkedAt: new Date(),
      disabledAt: null,
      disabledReason: null,
      lastEventAt: eventAt ?? undefined,
      lastEventRequestId: requestId ?? undefined,
    },
    });
    if (linkedUser?.homeId) {
        await tx.alexaHomeConnection.updateMany({
          where: { homeId: linkedUser.homeId },
        data: { status: 'LINKED', linkedByUserId: user.id, lastErrorCode: null, lastErrorAt: null },
        });
    }
  });

  return NextResponse.json({ ok: true });
}
