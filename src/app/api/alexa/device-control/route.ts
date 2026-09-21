// Architecture: API boundary /alexa/device-control; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { apiFailFromStatus } from '@/lib/apiError';
import { resolveAlexaAuthUser } from '@/app/api/alexa/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import {
  DEVICE_CONTROL_NUMERIC_COMMANDS,
  executeDeviceCommand,
} from '@/lib/deviceControl';
import { EntityAccessError, assertTenantEntityAccess, parseEntityId } from '@/lib/entityAccess';
import { Role } from '@prisma/client';
import { checkRateLimit } from '@/lib/rateLimit';
import { hashForLog, safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';

export async function POST(req: NextRequest) {
  const authUser = await resolveAlexaAuthUser(req);
  if (!authUser) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  if (authUser.role !== Role.TENANT) {
    return apiFailFromStatus(403, 'Alexa is available to tenant accounts only.');
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid body');
  }

  let entityId: string;
  let command: string;
  let value: number | undefined;
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = parseEntityId((body as Record<string, unknown> | null)?.entityId);
    entityId = parsed.entityId;
    command = (body as Record<string, unknown> | null)?.command as string;
    value = (body as Record<string, unknown> | null)?.value as number | undefined;
    const rawPayload = (body as Record<string, unknown> | null)?.payload;
    payload =
      rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : undefined;
  } catch (err) {
    const status = err instanceof EntityAccessError ? err.status : 400;
    const message = err instanceof Error ? err.message : 'Invalid body';
    return apiFailFromStatus(status, message);
  }

  if (!entityId || !command) {
    return apiFailFromStatus(400, 'Missing entityId or command');
  }

  const allowed = await checkRateLimit(`alexa-device-control:${authUser.id}`, {
    maxRequests: 30,
    windowMs: 10_000,
  });
  if (!allowed) {
    return apiFailFromStatus(429, 'Too many requests. Please wait a moment and try again.');
  }

  if (DEVICE_CONTROL_NUMERIC_COMMANDS.has(command) && typeof value !== 'number') {
    return apiFailFromStatus(400, 'Command requires numeric value');
  }

  try {
    const { haConnection, user } = await getUserWithHaConnection(authUser.id);

    try {
      await assertTenantEntityAccess({
        user: { id: user.id, role: user.role as Role },
        accessRules: user.accessRules ?? [],
        haConnectionId: haConnection.id,
        entityId,
        // Alexa requires fast responses (< ~8s). Avoid forcing a full HA refresh here.
        // Device access rules don't need ultra-fresh metadata.
        options: { bypassCache: false, cacheTtlMs: 60_000, labelsOnly: true, notFoundStatus: 404 },
      });
    } catch (err) {
      if (err instanceof EntityAccessError) {
        return apiFailFromStatus(err.status, err.message);
      }
      throw err;
    }

    const effectiveHa = resolveHaCloudFirst(haConnection);

    const work = (async () => {
      try {
        await executeDeviceCommand(
          effectiveHa,
          entityId,
          command,
          value,
          {
            source: 'alexa',
            userId: authUser.id,
            haConnectionId: haConnection.id,
            skipStatePrefetch: true,
          },
          payload
        );
      } catch (err) {
        safeLog('error', '[api/alexa/device-control] background execution failed', {
          entityIdHash: hashForLog(entityId),
          command,
          err,
        });
      }
    })();

    // Respond immediately to avoid Alexa "device is unresponsive" (deadline ~8s).
    // Vercel will keep background work alive when attached via waitUntil().
    try {
      waitUntil(work);
    } catch {
      // Fallback for local / non-Vercel runtimes.
      void work;
    }

    return NextResponse.json({ ok: true, accepted: true });
  } catch (err) {
    logServerError('[api/alexa/device-control] error', err, { userId: authUser.id });
    return apiFailFromStatus(500, 'Dinodia Hub unavailable. Please refresh and try again.');
  }
}
