// Architecture: API boundary /kiosk/blinds/travel-seconds; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireKioskDeviceSession, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { logApiHit } from '@/lib/requestLog';

export const runtime = 'nodejs';

type OverrideRow = {
  entityId: string;
  blindTravelSeconds: number | null;
};

function errorResponse(message: string, status = 400) {
  return apiFailFromStatus(status, message);
}

function normalizeEntityIds(entityIds: unknown): string[] {
  if (!Array.isArray(entityIds)) return [];
  const ids: string[] = [];
  for (const id of entityIds) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed.startsWith('cover.')) continue;
    if (trimmed.length === 0) continue;
    ids.push(trimmed);
  }
  // Cap to prevent abuse.
  return ids.slice(0, 300);
}

export async function POST(req: NextRequest) {
  logApiHit(req, '/api/kiosk/blinds/travel-seconds');

  let sessionUser: Awaited<ReturnType<typeof requireKioskDeviceSession>>['user'];
  try {
    ({ user: sessionUser } = await requireKioskDeviceSession(req));
  } catch (err) {
    const trusted = toTrustedDeviceResponse(err);
    if (trusted) return trusted;
    return errorResponse('Unable to verify this device.', 401);
  }

  const body = await req.json().catch(() => null);
  const entityIds = normalizeEntityIds((body as Record<string, unknown> | null)?.entityIds);
  if (entityIds.length === 0) {
    return errorResponse('Provide at least one cover entity id.');
  }

  const user = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      haConnection: { select: { id: true } },
    },
  });

  const haConnectionId = user?.haConnection?.id;
  if (!haConnectionId) {
    return errorResponse('Dinodia Hub connection is not configured for this account.', 400);
  }

  const overrides: OverrideRow[] = await prisma.device.findMany({
    where: {
      haConnectionId,
      entityId: { in: entityIds },
    },
    select: { entityId: true, blindTravelSeconds: true },
  });

  const filtered = overrides
    .map((row) => {
      const value = row.blindTravelSeconds;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
      }
      return { entityId: row.entityId, blindTravelSeconds: value };
    })
    .filter((row): row is { entityId: string; blindTravelSeconds: number } => Boolean(row));

  return NextResponse.json({ ok: true, overrides: filtered });
}
