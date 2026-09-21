// Architecture: API boundary /claim/recover; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, HomeownerOnboardingFlowType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { apiFailFromStatus } from '@/lib/apiError';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { verifyBootstrapSecretForRecovery, HubInstallError } from '@/lib/hubInstall';
import { setHomeClaimCodeWithClient } from '@/lib/claimCode';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { logServerError } from '@/lib/serverErrorLog';
import { legacyNativeRouteDisabled } from '@/lib/legacyNativeRouteGate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function normalizeBody(body: unknown): { serial: string; bootstrapSecret: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const serial =
    typeof b.serial === 'string'
      ? b.serial
      : typeof b.s === 'string'
      ? b.s
      : '';
  const bootstrapSecret =
    typeof b.bootstrapSecret === 'string'
      ? b.bootstrapSecret
      : typeof b.bs === 'string'
      ? b.bs
      : '';
  return { serial: serial.trim(), bootstrapSecret: bootstrapSecret.trim() };
}

function fail(status: number, message: string, errorCode: AuthErrorCode = AUTH_ERROR_CODES.CLAIM_INVALID) {
  return NextResponse.json({ ok: false, errorCode, error: message }, { status });
}

export async function POST(req: NextRequest) {
  const disabled = legacyNativeRouteDisabled();
  if (disabled) return disabled;
  const body = await req.json().catch(() => null);
  const { serial, bootstrapSecret } = normalizeBody(body);
  if (!serial || !bootstrapSecret) {
    return fail(400, 'Serial and bootstrap secret are required.', AUTH_ERROR_CODES.INVALID_LOGIN_INPUT);
  }

  const ip = getClientIp(req);
  const rateKey = `claim-recover:${ip}:${serial.toLowerCase()}`;
  const allowed = await checkRateLimit(rateKey, { maxRequests: 8, windowMs: 10 * 60_000 });
  if (!allowed) {
    return fail(429, 'Too many attempts. Please wait a few minutes and try again.', AUTH_ERROR_CODES.RATE_LIMITED);
  }

  let hubInstall: Awaited<ReturnType<typeof verifyBootstrapSecretForRecovery>>;
  try {
    hubInstall = await verifyBootstrapSecretForRecovery(serial, bootstrapSecret);
  } catch (err) {
    if (err instanceof HubInstallError) {
      const code =
        err.status === 429
          ? AUTH_ERROR_CODES.RATE_LIMITED
          : err.status === 401
          ? AUTH_ERROR_CODES.CLAIM_INVALID
          : AUTH_ERROR_CODES.CLAIM_INVALID;
      return fail(err.status, err.message, code);
    }
    logServerError('[api/claim/recover] Failed to verify hub bootstrap secret', err, { serial });
    return fail(500, 'Claim recovery is not available right now. Please try again later.', AUTH_ERROR_CODES.INTERNAL_ERROR);
  }

  const homeId = hubInstall.homeId;
  const haConnectionId = hubInstall.home?.haConnectionId ?? null;
  if (!homeId || !haConnectionId) {
    return apiFailFromStatus(400, 'This Dinodia Hub is not fully provisioned.');
  }
  const ownerId = hubInstall.home?.haConnection?.ownerId ?? null;
  if (ownerId) {
    return fail(
      409,
      'This home already has a homeowner. Ask them to transfer it first.',
      AUTH_ERROR_CODES.CLAIM_RECOVERY_NOT_ALLOWED
    );
  }

  try {
    const claimCode = await prisma.$transaction(async (tx) => {
      // Clear any stale pending claim flows (and their placeholder users) so the new claim can start cleanly.
      const pendingRows = await tx.pendingHomeownerOnboarding.findMany({
        where: {
          OR: [{ homeId }, { hubInstallId: hubInstall.id }],
          flowType: HomeownerOnboardingFlowType.CLAIM_CODE,
        },
        select: { userId: true },
      });
      const pendingUserIds = Array.from(
        new Set(pendingRows.map((r) => r.userId).filter((id): id is number => typeof id === 'number'))
      );

      if (pendingUserIds.length > 0) {
        await tx.authChallenge.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.accessRule.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.trustedDevice.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.stepUpApproval.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.remoteAccessLease.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.alexaAuthCode.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.alexaRefreshToken.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.alexaEventToken.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.alexaSkillUserLink.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.newDeviceCommissioningSession.deleteMany({ where: { userId: { in: pendingUserIds } } });
        await tx.loginIntent.deleteMany({ where: { userId: { in: pendingUserIds } } });
      }

      await tx.pendingHomeownerOnboarding.deleteMany({
        where: { OR: [{ homeId }, { hubInstallId: hubInstall.id }], flowType: HomeownerOnboardingFlowType.CLAIM_CODE },
      });

      if (pendingUserIds.length > 0) {
        await tx.user.deleteMany({ where: { id: { in: pendingUserIds } } });
      }

      // Ensure a consumed claim can be restarted (e.g. previous claim completed but owner later removed).
      await tx.home.update({
        where: { id: homeId },
        data: { claimCodeConsumedAt: null },
      });

      const { claimCode } = await setHomeClaimCodeWithClient(tx, homeId);

      await tx.auditEvent.create({
        data: {
          type: AuditEventType.CLAIM_CODE_GENERATED,
          homeId,
          actorUserId: null,
          metadata: {
            source: 'LOST_CLAIM_CODE_RECOVERY',
            serial,
            hubInstallId: hubInstall.id,
          },
        },
      });

      return claimCode;
    });

    return NextResponse.json({ ok: true, claimCode });
  } catch (err) {
    logServerError('[api/claim/recover] Failed to generate claim code', err, { serial, homeId });
    return fail(500, 'We could not generate a claim code. Please try again.', AUTH_ERROR_CODES.INTERNAL_ERROR);
  }
}
