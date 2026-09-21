// Architecture: API boundary /homeassistant/script; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import {
  buildAlexaChangeReportSnapshotForEntity,
  scheduleAlexaChangeReport,
} from '@/lib/deviceControl';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { callHaService } from '@/lib/homeAssistant';
import { prisma } from '@/lib/prisma';
import { EntityAccessError, assertTenantEntityAccess, parseEntityId } from '@/lib/entityAccess';
import { Role } from '@prisma/client';
import { hashForLog, safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';

type BlindScriptName = 'openblind' | 'closeblind' | 'openblindfully' | 'closeblindfully';

const LEGACY_SCRIPT_NAMES: BlindScriptName[] = [
  'openblind',
  'closeblind',
  'openblindfully',
  'closeblindfully',
];

const SCRIPT_MAP: Record<BlindScriptName, string> = {
  openblind: process.env.HA_BLIND_OPEN_SCRIPT_ENTITY_ID || 'script.openblind',
  closeblind: process.env.HA_BLIND_CLOSE_SCRIPT_ENTITY_ID || 'script.closeblind',
  openblindfully:
    process.env.HA_BLIND_OPEN_FULLY_SCRIPT_ENTITY_ID || 'script.openblindfully',
  closeblindfully:
    process.env.HA_BLIND_CLOSE_FULLY_SCRIPT_ENTITY_ID || 'script.closeblindfully',
};

const DEFAULT_BLIND_TRAVEL_SECONDS = Number(process.env.HA_BLIND_TRAVEL_SECONDS || '22');
const GLOBAL_BLIND_CONTROLLER_SCRIPT_ENTITY_ID =
  process.env.HA_BLIND_GLOBAL_CONTROLLER_SCRIPT_ENTITY_ID || 'script.global_blind_controller';
const GLOBAL_BLIND_CONTROLLER_SCRIPT_SERVICE =
  GLOBAL_BLIND_CONTROLLER_SCRIPT_ENTITY_ID.startsWith('script.')
    ? GLOBAL_BLIND_CONTROLLER_SCRIPT_ENTITY_ID.slice('script.'.length)
    : null;

export async function POST(req: NextRequest) {
  // TODO: depending on how you wire the ChatGPT assistant,
  // you might want a different auth mechanism (e.g., a shared secret header).
  // For now, reuse the standard user session.
  const user = await getCurrentUserFromRequest(req);
  if (!user) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid body');
  }

  let entityId: string;
  let script: string | undefined;
  let travel_seconds: number | undefined;
  let target_position: number | undefined;
  try {
    const parsed = parseEntityId((body as Record<string, unknown> | null)?.entityId);
    entityId = parsed.entityId;
    script = (body as Record<string, unknown> | null)?.script as string | undefined;
    travel_seconds = (body as Record<string, unknown> | null)?.travel_seconds as number | undefined;
    target_position = (body as Record<string, unknown> | null)?.target_position as number | undefined;
  } catch (err) {
    const status = err instanceof EntityAccessError ? err.status : 400;
    const message = err instanceof Error ? err.message : 'Invalid body';
    return apiFailFromStatus(status, message);
  }

  if (!script || !entityId) {
    return apiFailFromStatus(400, 'Missing script or entityId');
  }

  const isLegacyScript = LEGACY_SCRIPT_NAMES.includes(script as BlindScriptName);
  const isGlobalController = script === 'global_blind_controller';

  if (!isLegacyScript && !isGlobalController) {
    return apiFailFromStatus(400, 'Invalid script name');
  }

  if (!entityId.startsWith('cover.')) {
    return apiFailFromStatus(400, 'entityId must be a cover.* entity');
  }

  if (isGlobalController) {
    if (typeof target_position !== 'number' || Number.isNaN(target_position)) {
      return apiFailFromStatus(400, 'target_position must be provided as a number');
    }
    if (target_position < 0 || target_position > 100) {
      return apiFailFromStatus(400, 'target_position must be between 0 and 100');
    }
  }

  const haConnResult = await getUserWithHaConnection(user.id).catch((err) => {
    logServerError('[api/homeassistant/script] Failed to resolve HA connection', err, { userId: user.id });
    return null;
  });
  if (!haConnResult) {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }
  const { haConnection } = haConnResult;
  const haConnectionId = haConnection.id;
  const effectiveHa = resolveHaCloudFirst(haConnection);

  try {
    await assertTenantEntityAccess({
      user: { id: user.id, role: user.role as Role },
      accessRules: haConnResult.user.accessRules ?? [],
      haConnectionId,
      entityId,
      options: { bypassCache: true },
    });
  } catch (err) {
    if (err instanceof EntityAccessError) {
      return apiFailFromStatus(err.status, err.message);
    }
    throw err;
  }

  const travelSeconds =
    typeof travel_seconds === 'number'
      ? travel_seconds
      : await resolveBlindTravelSecondsForScript(haConnectionId, entityId);

  let alexaSnapshot: Awaited<ReturnType<typeof buildAlexaChangeReportSnapshotForEntity>> | null =
    null;
  try {
    alexaSnapshot = await buildAlexaChangeReportSnapshotForEntity(effectiveHa, entityId, 'blind');
  } catch (err) {
    safeLog('warn', '[api/homeassistant/script] Failed to capture Alexa snapshot', {
      entityIdHash: hashForLog(entityId),
      err,
    });
  }

  try {
    if (isGlobalController) {
      const targetPosition = target_position as number;
      if (GLOBAL_BLIND_CONTROLLER_SCRIPT_SERVICE) {
        await callHaService(effectiveHa, 'script', GLOBAL_BLIND_CONTROLLER_SCRIPT_SERVICE, {
          target_cover: entityId,
          target_position: targetPosition,
          travel_seconds: travelSeconds,
        });
      } else {
        await callHaService(effectiveHa, 'script', 'turn_on', {
          entity_id: GLOBAL_BLIND_CONTROLLER_SCRIPT_ENTITY_ID,
          variables: {
            target_cover: entityId,
            target_position: targetPosition,
            travel_seconds: travelSeconds,
          },
        });
      }
    } else {
      const scriptKey = script as BlindScriptName;
      const scriptEntityId = SCRIPT_MAP[scriptKey];
      await callHaService(effectiveHa, 'script', 'turn_on', {
        entity_id: scriptEntityId,
        variables: {
          target_cover: entityId,
          travel_seconds: travelSeconds,
        },
      });
    }

    if (alexaSnapshot) {
      await scheduleAlexaChangeReport(effectiveHa, alexaSnapshot, 'app', {
        haConnectionId,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isHaTimeoutError(err)) {
      safeLog('warn', '[api/homeassistant/script] Blind script timeout (continuing)', {
        entityIdHash: hashForLog(entityId),
      });
      return NextResponse.json({
        ok: true,
        warning: 'Home Assistant is still moving that blind.',
      });
    }
    logServerError('[api/homeassistant/script] error', err, { userId: user.id, haConnectionId });
    return apiFailFromStatus(500, 'Dinodia Hub unavailable. Please refresh and try again.');
  }
}

function isHaTimeoutError(err: unknown): err is Error {
  return err instanceof Error && err.message.toLowerCase().includes('timeout');
}

async function resolveBlindTravelSecondsForScript(haConnectionId: number, entityId: string) {
  try {
    const device = await prisma.device.findUnique({
      where: {
        haConnectionId_entityId: {
          haConnectionId,
          entityId,
        },
      },
      select: { blindTravelSeconds: true },
    });
    if (
      device?.blindTravelSeconds != null &&
      Number.isFinite(device.blindTravelSeconds) &&
      device.blindTravelSeconds > 0
    ) {
      return device.blindTravelSeconds;
    }
  } catch (err) {
    safeLog('warn', '[api/homeassistant/script] Failed to read blindTravelSeconds override', {
      entityIdHash: hashForLog(entityId),
      haConnectionId,
      err,
    });
  }
  return DEFAULT_BLIND_TRAVEL_SECONDS;
}
