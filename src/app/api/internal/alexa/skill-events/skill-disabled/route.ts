// Architecture: API boundary /internal/alexa/skill-events/skill-disabled; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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

async function revokeAlexaForUser(userId: number, reason: string) {
  const clientId = process.env.ALEXA_CLIENT_ID ?? '';
  await prisma.$transaction(async (tx) => {
    await tx.alexaRefreshToken.updateMany({
      where: { userId, ...(clientId ? { clientId } : {}), revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
    await tx.alexaEventToken.deleteMany({ where: { userId } });
    await tx.alexaSkillUserLink.updateMany({
      where: { userId },
      data: { disabledAt: new Date(), disabledReason: reason },
    });
  });
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
  if (!alexaUserId) return NextResponse.json({ error: 'Missing alexaUserId' }, { status: 400 });

  const requestId = typeof obj.requestId === 'string' ? obj.requestId.trim() : null;
  const eventAt = parseTimestamp(obj.timestamp);
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim().length > 0 ? obj.reason.trim() : 'SKILL_DISABLED';

  const link = await prisma.alexaSkillUserLink.findUnique({
    where: { alexaUserId },
    select: { userId: true, lastEventAt: true, user: { select: { homeId: true } } },
  });
  if (!link) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'no_mapping' });
  }

  // Idempotency: ignore older events.
  if (eventAt && link.lastEventAt && eventAt.getTime() < link.lastEventAt.getTime()) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'stale' });
  }

  await prisma.alexaSkillUserLink.update({
    where: { alexaUserId },
    data: {
      disabledAt: new Date(),
      disabledReason: reason,
      lastEventAt: eventAt ?? undefined,
      lastEventRequestId: requestId ?? undefined,
    },
  });

  await revokeAlexaForUser(link.userId, reason);
  if (link.user.homeId) {
    const activeLinks = await prisma.alexaSkillUserLink.count({ where: { homeId: link.user.homeId, disabledAt: null } });
    await prisma.alexaHomeConnection.updateMany({ where: { homeId: link.user.homeId }, data: { status: activeLinks > 0 ? 'LINKED' : 'DISCONNECTED' } });
  }

  return NextResponse.json({ ok: true });
}
