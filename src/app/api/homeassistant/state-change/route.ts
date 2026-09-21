// Architecture: API boundary /homeassistant/state-change; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { scheduleAlexaChangeReportForEntityStateChange } from '@/lib/deviceControl';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { prisma } from '@/lib/prisma';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { logApiHit } from '@/lib/requestLog';
import { bumpDevicesVersion } from '@/lib/devicesVersion';
import { hashForLog, safeLog } from '@/lib/safeLogger';
// In-memory dedupe (best effort, per instance)
const recent = new Map<string, number>();
const DEDUPE_TTL_MS = 1000;

function dedupeKey(haConnectionId: number | null, entityId: string | null) {
  return `${haConnectionId ?? 'null'}::${entityId ?? 'null'}`;
}

function shouldDedupe(key: string) {
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUPE_TTL_MS) {
    return true;
  }
  recent.set(key, now);
  // Best-effort cleanup of old keys
  if (recent.size > 2000) {
    const cutoff = now - DEDUPE_TTL_MS * 5;
    for (const [k, ts] of recent) {
      if (ts < cutoff) recent.delete(k);
    }
  }
  return false;
}

const WEBHOOK_SECRET = process.env.HA_WEBHOOK_SECRET;
const FALLBACK_EVENTS_USER_ID = Number(process.env.ALEXA_EVENTS_USER_ID || NaN);

type HaResolution = {
  haConnection: {
    id: number;
    baseUrl: string;
    cloudUrl: string | null;
    longLivedToken: string;
  };
  haConnectionId: number;
};

function getBearerToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function resolveHaForEntity(
  entityId: string,
  haConnectionIdFromBody: number | null
): Promise<HaResolution | null> {
  if (haConnectionIdFromBody && Number.isFinite(haConnectionIdFromBody)) {
    try {
      const haConnection = await prisma.haConnection.findUnique({
        where: { id: haConnectionIdFromBody },
        select: {
          id: true,
          baseUrl: true,
          cloudUrl: true,
          longLivedToken: true,
          longLivedTokenCiphertext: true,
        },
      });
      if (haConnection) {
        const secrets = resolveHaLongLivedToken(haConnection);
        return {
          haConnection: { ...haConnection, ...secrets },
          haConnectionId: haConnection.id,
        };
      }
      safeLog('warn', '[api/homeassistant/state-change] Provided haConnectionId not found', {
        entityIdHash: hashForLog(entityId),
        haConnectionIdFromBody,
      });
    } catch (err) {
      safeLog('warn', '[api/homeassistant/state-change] Failed to resolve haConnection from body', {
        entityIdHash: hashForLog(entityId),
        haConnectionIdFromBody,
        error: err,
      });
    }
  }

  try {
    const device = await prisma.device.findFirst({
      where: { entityId },
      include: { haConnection: true },
    });
    if (device?.haConnection) {
      const secrets = resolveHaLongLivedToken(device.haConnection);
      return {
        haConnection: { ...device.haConnection, ...secrets },
        haConnectionId: device.haConnection.id,
      };
    }
  } catch (err) {
    safeLog('warn', '[api/homeassistant/state-change] Failed to resolve HA connection from device fallback', {
      entityIdHash: hashForLog(entityId),
      error: err,
    });
  }

  if (Number.isFinite(FALLBACK_EVENTS_USER_ID)) {
    try {
      const { haConnection } = await getUserWithHaConnection(FALLBACK_EVENTS_USER_ID);
      return {
        haConnection: {
          id: haConnection.id,
          baseUrl: haConnection.baseUrl,
          cloudUrl: haConnection.cloudUrl,
          longLivedToken: haConnection.longLivedToken,
        },
        haConnectionId: haConnection.id,
      };
    } catch (err) {
      safeLog('warn', '[api/homeassistant/state-change] Failed to resolve HA connection for Alexa events user', {
        entityIdHash: hashForLog(entityId),
        userId: FALLBACK_EVENTS_USER_ID,
        error: err,
      });
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  if (!WEBHOOK_SECRET) {
    safeLog('error', '[api/homeassistant/state-change] Missing HA_WEBHOOK_SECRET');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  logApiHit(req, '/api/homeassistant/state-change');

  const token = getBearerToken(req);
  if (token !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const entityId =
    typeof (body as Record<string, unknown>).entity_id === 'string'
      ? ((body as Record<string, unknown>).entity_id as string)
      : typeof (body as Record<string, unknown>).entityId === 'string'
      ? ((body as Record<string, unknown>).entityId as string)
      : null;

  const haConnectionIdFromBody =
    typeof (body as Record<string, unknown>).haConnectionId === 'number'
      ? ((body as Record<string, unknown>).haConnectionId as number)
      : typeof (body as Record<string, unknown>).ha_connection_id === 'number'
      ? ((body as Record<string, unknown>).ha_connection_id as number)
      : null;

  if (!entityId) {
    return NextResponse.json({ error: 'Missing entity_id' }, { status: 400 });
  }

  const dedupeKeyStr = dedupeKey(haConnectionIdFromBody, entityId);
  if (shouldDedupe(dedupeKeyStr)) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const haResolution = await resolveHaForEntity(entityId, haConnectionIdFromBody);
  if (!haResolution) {
    safeLog('warn', '[api/homeassistant/state-change] No HA connection for entity', {
      entityIdHash: hashForLog(entityId),
    });
    return NextResponse.json(
      { ok: true, warning: 'No HA connection found for that entity' },
      { status: 200 }
    );
  }

  const { haConnection, haConnectionId } = haResolution;
  const effectiveHa = resolveHaCloudFirst(haConnection);

  try {
    await scheduleAlexaChangeReportForEntityStateChange(
      effectiveHa,
      haConnectionId,
      entityId,
      'physical'
    );
  } catch (err) {
    safeLog('warn', '[api/homeassistant/state-change] Failed to schedule Alexa ChangeReport', {
      entityIdHash: hashForLog(entityId),
      error: err,
    });
    return NextResponse.json(
      { ok: true, warning: 'Failed to schedule Alexa ChangeReport' },
      { status: 200 }
    );
  }

  try {
    await bumpDevicesVersion(haConnectionId);
  } catch (err) {
    safeLog('warn', '[api/homeassistant/state-change] Failed to bump devicesVersion', {
      haConnectionId,
      error: err,
    });
  }

  return NextResponse.json({ ok: true });
}
