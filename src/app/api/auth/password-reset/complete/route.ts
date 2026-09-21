// Architecture: API boundary /auth/password-reset/complete; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuthChallengePurpose, Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getAppUrl, hashToken } from '@/lib/authChallenges';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { sendEmail } from '@/lib/email';
import { logServerError } from '@/lib/serverErrorLog';

export const runtime = 'nodejs';

const MIN_PASSWORD_LENGTH = 8;
const REPLY_TO = process.env.SES_REPLY_TO_EMAIL || 'niveditgupta@dinodiasmartliving.com';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const newPassword =
    typeof body?.newPassword === 'string' ? body.newPassword : '';
  const confirmPassword =
    typeof body?.confirmPassword === 'string' ? body.confirmPassword : '';

  if (!token) {
    return NextResponse.json(
      { error: 'Reset link is missing or invalid.' },
      { status: 400 }
    );
  }

  const tokenHash = hashToken(token);
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(
    `password-reset-complete:${ip}:${tokenHash.slice(0, 12)}`,
    { maxRequests: 10, windowMs: 15 * 60 * 1000 }
  );
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      { status: 429 }
    );
  }

  if (!newPassword || !confirmPassword) {
    return NextResponse.json(
      { error: 'Enter and confirm your new password.' },
      { status: 400 }
    );
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json(
      { error: 'Passwords do not match.' },
      { status: 400 }
    );
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const challenge = await prisma.authChallenge.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      purpose: true,
      expiresAt: true,
      consumedAt: true,
    },
  });

  if (!challenge || challenge.purpose !== AuthChallengePurpose.PASSWORD_RESET) {
    return NextResponse.json(
      { error: 'This reset link is not valid.' },
      { status: 400 }
    );
  }
  if (challenge.consumedAt) {
    return NextResponse.json(
      { error: 'This reset link was already used.' },
      { status: 400 }
    );
  }
  if (challenge.expiresAt < new Date()) {
    return NextResponse.json(
      { error: 'This reset link has expired. Request a new one.' },
      { status: 410 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: challenge.userId },
    select: {
      id: true,
      role: true,
      username: true,
      email: true,
      emailPending: true,
      passwordHash: true,
    },
  });

  if (!user || user.role === Role.INSTALLER) {
    return NextResponse.json(
      { error: 'This reset link is not valid.' },
      { status: 400 }
    );
  }

  const isSamePassword = await verifyPassword(newPassword, user.passwordHash);
  if (isSamePassword) {
    return NextResponse.json(
      { error: 'New password must be different from the current password.' },
      { status: 400 }
    );
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: now },
    });

    await tx.authChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: now },
    });
  });

  const appUrl = getAppUrl();
  const notifyEmail = user.email ?? user.emailPending;
  if (notifyEmail) {
    try {
      await sendEmail({
        to: notifyEmail,
        subject: 'Your Dinodia password was changed',
        text: `Hi${user.username ? ` ${user.username}` : ''},\n\nYour Dinodia password was just changed. If this wasn’t you, reset it again immediately and contact support.\n\nSign in: ${appUrl}\n`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
            <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
            <p style="margin: 0 0 12px 0;">Hi${user.username ? ` ${user.username}` : ''},</p>
            <p style="margin: 0 0 12px 0;">Your Dinodia password was just changed.</p>
            <p style="margin: 0 0 12px 0; color: #475569;">If this wasn’t you, reset it again immediately and contact support.</p>
            <p style="margin: 0 0 12px 0;"><a href="${appUrl}" style="color:#0f172a;">Sign in</a></p>
          </div>
        `,
        replyTo: REPLY_TO,
      });
    } catch (err) {
      logServerError('[password-reset:complete] Failed to send change notification', err, { userId: user.id });
    }
  }

  return NextResponse.json({ ok: true });
}
