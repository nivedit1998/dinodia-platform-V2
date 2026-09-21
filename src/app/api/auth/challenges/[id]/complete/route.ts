// Architecture: API boundary /auth/challenges/[id]/complete; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuthChallengePurpose, Role, StepUpPurpose } from '@prisma/client';
import {
  markChallengeConsumed,
  type ChallengeCompletionValidationResult,
  validateChallengeForCompletion,
} from '@/lib/authChallenges';
import { prisma } from '@/lib/prisma';
import { trustDevice } from '@/lib/deviceTrust';
import { createKioskToken, createSessionForUser, createTokenForUser } from '@/lib/auth';
import { createStepUpApproval } from '@/lib/stepUp';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { getHomeownerPolicyStatus } from '@/lib/homeownerPolicy';
import { markPendingHomeownerEmailVerified } from '@/lib/homeownerOnboardingPending';
import { safeLog } from '@/lib/safeLogger';

export const runtime = 'nodejs';

type CompletionStatus = 'COMPLETED' | 'ALREADY_COMPLETED';

class CompletionFailure extends Error {
  status: number;
  errorCode: AuthErrorCode;
  reason?: string;

  constructor(status: number, errorCode: AuthErrorCode, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.reason = reason;
  }
}

class ConsumedRaceError extends Error {}

function fail(status: number, errorCode: AuthErrorCode, error: string, extras: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, errorCode, error, ...extras }, { status });
}

function logCompletionResult(payload: {
  result: string;
  challengeId?: string | null;
  purpose?: AuthChallengePurpose | null;
  deviceId?: string | null;
  reason?: string | null;
}) {
  safeLog('info', '[auth/challenges/complete] result', {
    event: 'auth_challenge_completion',
    route: '/api/auth/challenges/[id]/complete',
    result: payload.result,
    challengeId: payload.challengeId ?? null,
    purpose: payload.purpose ?? null,
    deviceId: payload.deviceId ?? null,
    reason: payload.reason ?? null,
  });
}

function isStrictSameDeviceReplay(
  challenge: { deviceId: string | null } | undefined,
  deviceId: string
) {
  return Boolean(challenge?.deviceId && challenge.deviceId === deviceId);
}

function failFromValidation(result: Extract<ChallengeCompletionValidationResult, { ok: false }>) {
  const status =
    result.reason === 'NOT_FOUND'
      ? 404
      : result.reason === 'EXPIRED'
        ? 410
        : result.reason === 'DEVICE_MISMATCH'
          ? 403
          : result.reason === 'ALREADY_CONSUMED'
            ? 409
            : 400;
  const message =
    result.reason === 'NOT_FOUND'
      ? 'Verification request not found.'
      : result.reason === 'EXPIRED'
        ? 'Verification request expired.'
        : result.reason === 'DEVICE_MISMATCH'
          ? 'This verification request is for a different device.'
          : result.reason === 'DEVICE_REQUIRED'
            ? 'Device information is required.'
            : result.reason === 'ALREADY_CONSUMED'
              ? 'This verification request was already completed.'
              : result.reason === 'NOT_APPROVED'
                ? 'This verification request is not approved yet.'
                : 'Unable to complete verification.';

  return fail(status, AUTH_ERROR_CODES.VERIFICATION_FAILED, message, { reason: result.reason });
}

async function applyChallengeCompletion(
  challenge: { id: string; userId: number; purpose: AuthChallengePurpose; email: string },
  deviceId: string,
  deviceLabel?: string
): Promise<{ trustedSessionVersion?: number | null }> {
  let trustedSessionVersion: number | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      switch (challenge.purpose) {
        case AuthChallengePurpose.ADMIN_EMAIL_VERIFY: {
          const user = await tx.user.findUnique({
            where: { id: challenge.userId },
            select: {
              id: true,
              role: true,
              email: true,
              emailPending: true,
              emailVerifiedAt: true,
            },
          });
          if (!user || user.role !== Role.ADMIN) {
            throw new CompletionFailure(
              400,
              AUTH_ERROR_CODES.VERIFICATION_FAILED,
              'Invalid verification target.'
            );
          }

          const now = new Date();
          if (user.emailPending) {
            await tx.user.update({
              where: { id: user.id },
              data: {
                email: user.emailPending,
                emailPending: null,
                emailVerifiedAt: now,
              },
            });
          } else if (!user.emailVerifiedAt) {
            await tx.user.update({
              where: { id: user.id },
              data: { emailVerifiedAt: now },
            });
          }

          await markPendingHomeownerEmailVerified(user.id, tx);
          trustedSessionVersion = (await trustDevice(user.id, deviceId, deviceLabel, tx))?.sessionVersion ?? null;
          break;
        }

        case AuthChallengePurpose.LOGIN_NEW_DEVICE: {
          const user = await tx.user.findUnique({
            where: { id: challenge.userId },
            select: { id: true, role: true, emailVerifiedAt: true },
          });
          if (!user) {
            throw new CompletionFailure(404, AUTH_ERROR_CODES.INTERNAL_ERROR, 'User not found.');
          }
          if (user.role === Role.ADMIN && !user.emailVerifiedAt) {
            throw new CompletionFailure(
              403,
              AUTH_ERROR_CODES.VERIFICATION_REQUIRED,
              'Admin email must be verified before login.'
            );
          }

          trustedSessionVersion = (await trustDevice(user.id, deviceId, deviceLabel, tx))?.sessionVersion ?? null;
          break;
        }

        case AuthChallengePurpose.TENANT_ENABLE_2FA: {
          const user = await tx.user.findUnique({
            where: { id: challenge.userId },
            select: {
              id: true,
              email: true,
              emailPending: true,
            },
          });
          if (!user) {
            throw new CompletionFailure(404, AUTH_ERROR_CODES.INTERNAL_ERROR, 'User not found.');
          }

          const emailToUse = user.emailPending || challenge.email || user.email;
          await tx.user.update({
            where: { id: user.id },
            data: {
              email: emailToUse ?? undefined,
              emailPending: null,
              emailVerifiedAt: new Date(),
              email2faEnabled: true,
            },
          });

          trustedSessionVersion = (await trustDevice(user.id, deviceId, deviceLabel, tx))?.sessionVersion ?? null;
          break;
        }

        case AuthChallengePurpose.REMOTE_ACCESS_SETUP: {
          const user = await tx.user.findUnique({
            where: { id: challenge.userId },
            select: { id: true, role: true },
          });
          if (!user || user.role !== Role.ADMIN) {
            throw new CompletionFailure(
              400,
              AUTH_ERROR_CODES.VERIFICATION_FAILED,
              'Invalid verification target.'
            );
          }

          await createStepUpApproval(user.id, deviceId, StepUpPurpose.REMOTE_ACCESS_SETUP, tx);
          break;
        }

        default:
          throw new CompletionFailure(
            400,
            AUTH_ERROR_CODES.VERIFICATION_FAILED,
            'Unsupported verification type.'
          );
      }

      const consumed = await markChallengeConsumed(challenge.id, tx);
      if (!consumed) {
        throw new ConsumedRaceError();
      }
    });
    return { trustedSessionVersion };
  } catch (error) {
    if (error instanceof CompletionFailure) throw error;
    if (error instanceof ConsumedRaceError) throw error;
    throw new CompletionFailure(500, AUTH_ERROR_CODES.INTERNAL_ERROR, 'Unable to complete verification.');
  }
}

async function buildCompletionSuccessResponse(args: {
  challenge: { userId: number; purpose: AuthChallengePurpose };
  deviceId: string;
  completionStatus: CompletionStatus;
  trustedSessionVersion?: number | null;
}) {
  const user = await prisma.user.findUnique({
    where: { id: args.challenge.userId },
    select: {
      id: true,
      username: true,
      role: true,
      emailVerifiedAt: true,
      home: {
        select: {
          haConnection: { select: { cloudUrl: true } },
        },
      },
    },
  });

  if (!user) {
    return fail(404, AUTH_ERROR_CODES.INTERNAL_ERROR, 'User not found.');
  }

  if (args.challenge.purpose === AuthChallengePurpose.REMOTE_ACCESS_SETUP) {
    return NextResponse.json({
      ok: true,
      stepUpApproved: true,
      completionStatus: args.completionStatus,
    });
  }

  const sessionUser = {
    id: user.id,
    username: user.username,
    role: user.role,
  };
  const resolvedSessionVersion =
    args.trustedSessionVersion ??
    Number(
      (
        await prisma.trustedDevice.findUnique({
          where: { userId_deviceId: { userId: user.id, deviceId: args.deviceId } },
          select: { sessionVersion: true },
        })
      )?.sessionVersion ?? NaN
    );
  if (!Number.isFinite(resolvedSessionVersion)) {
    return fail(500, AUTH_ERROR_CODES.INTERNAL_ERROR, 'Trusted device session was not created.');
  }

  const cloudEnabled = Boolean(user.home?.haConnection?.cloudUrl?.trim());
  const kioskToken = createKioskToken(sessionUser, args.deviceId, resolvedSessionVersion);
  const webToken = createTokenForUser(sessionUser);

  await createSessionForUser(sessionUser);

  if (args.challenge.purpose === AuthChallengePurpose.ADMIN_EMAIL_VERIFY) {
    if (user.role !== Role.ADMIN) {
      return fail(400, AUTH_ERROR_CODES.VERIFICATION_FAILED, 'Invalid verification target.');
    }

    const policy = await getHomeownerPolicyStatus(user.id);
    return NextResponse.json({
      ok: true,
      role: user.role,
      token: kioskToken,
      webToken,
      cloudEnabled,
      completionStatus: args.completionStatus,
      requiresHomeownerPolicyAcceptance: policy?.requiresAcceptance ?? true,
      homeownerPolicyVersion: policy?.policyVersion ?? '2026-V1',
      pendingOnboardingId: policy?.pendingOnboardingId ?? null,
    });
  }

  if (args.challenge.purpose === AuthChallengePurpose.LOGIN_NEW_DEVICE) {
    if (user.role === Role.ADMIN) {
      const policy = await getHomeownerPolicyStatus(user.id);
      return NextResponse.json({
        ok: true,
        role: user.role,
        token: kioskToken,
        webToken,
        cloudEnabled,
        completionStatus: args.completionStatus,
        requiresHomeownerPolicyAcceptance: policy?.requiresAcceptance ?? true,
        homeownerPolicyVersion: policy?.policyVersion ?? '2026-V1',
        pendingOnboardingId: policy?.pendingOnboardingId ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      role: user.role,
      token: kioskToken,
      webToken,
      cloudEnabled,
      completionStatus: args.completionStatus,
    });
  }

  return NextResponse.json({
    ok: true,
    role: user.role,
    token: kioskToken,
    webToken,
    cloudEnabled,
    completionStatus: args.completionStatus,
  });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const body = await req.json().catch(() => null);
  const deviceId = body?.deviceId as string | undefined;
  const deviceLabel = body?.deviceLabel as string | undefined;

  if (!deviceId) {
    return fail(400, AUTH_ERROR_CODES.DEVICE_REQUIRED, 'Device information is required.');
  }

  const validation = await validateChallengeForCompletion({ id, deviceId });
  if (!validation.ok) {
    const replayChallenge = validation.challenge;
    if (
      validation.reason === 'ALREADY_CONSUMED' &&
      replayChallenge &&
      isStrictSameDeviceReplay(replayChallenge, deviceId)
    ) {
      logCompletionResult({
        result: 'completion_idempotent_success',
        challengeId: replayChallenge.id,
        purpose: replayChallenge.purpose,
        deviceId,
        reason: validation.reason,
      });
      return buildCompletionSuccessResponse({
        challenge: replayChallenge,
        deviceId,
        completionStatus: 'ALREADY_COMPLETED',
      });
    }
    logCompletionResult({
      result:
        validation.reason === 'ALREADY_CONSUMED'
          ? 'completion_already_consumed'
          : 'completion_validation_failed',
      challengeId: replayChallenge?.id ?? id,
      purpose: replayChallenge?.purpose ?? null,
      deviceId,
      reason: validation.reason,
    });
    return failFromValidation(validation);
  }

  let completion: { trustedSessionVersion?: number | null };
  try {
    completion = await applyChallengeCompletion(validation.challenge, deviceId, deviceLabel);
  } catch (error) {
    if (error instanceof ConsumedRaceError) {
      if (isStrictSameDeviceReplay(validation.challenge, deviceId)) {
        logCompletionResult({
          result: 'completion_idempotent_success',
          challengeId: validation.challenge.id,
          purpose: validation.challenge.purpose,
          deviceId,
          reason: 'ALREADY_CONSUMED',
        });
        return buildCompletionSuccessResponse({
          challenge: validation.challenge,
          deviceId,
          completionStatus: 'ALREADY_COMPLETED',
        });
      }
      logCompletionResult({
        result: 'completion_already_consumed',
        challengeId: validation.challenge.id,
        purpose: validation.challenge.purpose,
        deviceId,
        reason: 'ALREADY_CONSUMED',
      });
      return fail(
        409,
        AUTH_ERROR_CODES.VERIFICATION_FAILED,
        'This verification request was already completed.',
        { reason: 'ALREADY_CONSUMED' }
      );
    }
    if (error instanceof CompletionFailure) {
      logCompletionResult({
        result: 'completion_failed_before_consume',
        challengeId: validation.challenge.id,
        purpose: validation.challenge.purpose,
        deviceId,
        reason: error.reason ?? error.errorCode ?? 'COMPLETION_FAILURE',
      });
      return fail(error.status, error.errorCode, error.message, error.reason ? { reason: error.reason } : {});
    }
    logCompletionResult({
      result: 'completion_failed_before_consume',
      challengeId: validation.challenge.id,
      purpose: validation.challenge.purpose,
      deviceId,
      reason: 'UNEXPECTED_ERROR',
    });
    return fail(500, AUTH_ERROR_CODES.INTERNAL_ERROR, 'Unable to complete verification.');
  }

  logCompletionResult({
    result: 'completion_success',
    challengeId: validation.challenge.id,
    purpose: validation.challenge.purpose,
    deviceId,
    reason: 'COMPLETED',
  });
  return buildCompletionSuccessResponse({
    challenge: validation.challenge,
    deviceId,
    completionStatus: 'COMPLETED',
    trustedSessionVersion: completion.trustedSessionVersion ?? null,
  });
}
