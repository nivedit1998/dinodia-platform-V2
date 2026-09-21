// Architecture: API boundary /tenant/profile/2fa/complete; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { AuthChallengePurpose, Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { trustDevice } from '@/lib/deviceTrust';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  let body:
    | {
        challengeId?: string;
        deviceId?: string;
        deviceLabel?: string;
      }
    | null = null;

  try {
    body = await req.json();
  } catch {
    return apiFailFromStatus(400, 'Invalid request body.');
  }

  const challengeId = typeof body?.challengeId === 'string' ? body.challengeId : '';
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
  const deviceLabel =
    typeof body?.deviceLabel === 'string' ? body.deviceLabel.trim() : undefined;

  if (!challengeId || !deviceId) {
    return apiFailFromStatus(400, 'Verification details are missing or incomplete.');
  }

  const challenge = await prisma.authChallenge.findUnique({
    where: { id: challengeId },
    select: {
      id: true,
      userId: true,
      purpose: true,
      email: true,
      deviceId: true,
      expiresAt: true,
      approvedAt: true,
      consumedAt: true,
    },
  });

  if (!challenge || challenge.userId !== me.id) {
    return apiFailFromStatus(404, 'Verification request not found.');
  }

  if (challenge.purpose !== AuthChallengePurpose.TENANT_ENABLE_2FA) {
    return apiFailFromStatus(400, 'Invalid verification purpose.');
  }

  if (challenge.deviceId && challenge.deviceId !== deviceId) {
    return apiFailFromStatus(403, 'This device cannot complete verification.');
  }

  if (!challenge.approvedAt) {
    return apiFailFromStatus(400, 'Verification email not yet approved.');
  }

  if (challenge.consumedAt) {
    return apiFailFromStatus(400, 'Verification link already used.');
  }

  if (challenge.expiresAt < new Date()) {
    return apiFailFromStatus(410, 'Verification link has expired.');
  }

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { email: true, emailPending: true },
  });

  if (!user) {
    return apiFailFromStatus(404, 'User not found.');
  }

  const now = new Date();
  const emailToUse = user.emailPending || challenge.email;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: me.id },
      data: {
        email: emailToUse,
        emailPending: null,
        emailVerifiedAt: now,
        email2faEnabled: true,
      },
    });

    await trustDevice(me.id, deviceId, deviceLabel, tx);

    await tx.authChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: now },
    });
  });

  return NextResponse.json({ ok: true });
}
