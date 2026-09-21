// Architecture: API boundary /kiosk/remote-access/step-up/start; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuthChallengePurpose, Role } from '@prisma/client';
import { readDeviceHeaders, requireKioskDeviceSession } from '@/lib/deviceAuth';
import { isDeviceTrusted } from '@/lib/deviceTrust';
import { createAuthChallenge, buildVerifyUrl, getAppUrl } from '@/lib/authChallenges';
import { buildVerifyLinkEmail } from '@/lib/emailTemplates';
import { sendEmail } from '@/lib/email';
import { prisma } from '@/lib/prisma';

const REPLY_TO = 'niveditgupta@dinodiasmartliving.com';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { user, deviceId } = await requireKioskDeviceSession(req);
  if (!user || user.role !== Role.ADMIN) {
    return NextResponse.json({ error: 'Admin access required.' }, { status: 401 });
  }

  const { deviceLabel } = readDeviceHeaders(req);

  const trusted = await isDeviceTrusted(user.id, deviceId);
  if (!trusted) {
    return NextResponse.json(
      { error: 'This device is not trusted. Please sign in again.' },
      { status: 403 }
    );
  }

  const fullUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, emailPending: true, username: true },
  });
  const targetEmail = fullUser?.email ?? fullUser?.emailPending;
  if (!targetEmail) {
    return NextResponse.json(
      { error: 'Email is required to send verification. Please add an email in settings.' },
      { status: 400 }
    );
  }

  const challenge = await createAuthChallenge({
    userId: user.id,
    purpose: AuthChallengePurpose.REMOTE_ACCESS_SETUP,
    email: targetEmail,
    deviceId,
  });

  const appUrl = getAppUrl();
  const verifyUrl = buildVerifyUrl(challenge.token);
  const email = buildVerifyLinkEmail({
    kind: 'REMOTE_ACCESS_SETUP',
    verifyUrl,
    appUrl,
    username: fullUser?.username ?? user.username,
    deviceLabel: deviceLabel ?? undefined,
  });

  await sendEmail({
    to: targetEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: REPLY_TO,
  });

  return NextResponse.json({
    ok: true,
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt,
  });
}
