// Architecture: API boundary /auth/register-serial; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { HomeownerOnboardingFlowType, Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { buildVerifyLinkEmail } from '@/lib/emailTemplates';
import { createAuthChallenge, buildVerifyUrl, getAppUrl } from '@/lib/authChallenges';
import { sendEmail } from '@/lib/email';
import { HubInstallError, verifyBootstrapClaim } from '@/lib/hubInstall';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { createPendingHomeownerOnboarding } from '@/lib/homeownerOnboardingPending';
import { normalizePhoneNumberE164 } from '@/lib/phoneNumber';
import { legacyNativeRouteDisabled } from '@/lib/legacyNativeRouteGate';

const REPLY_TO = 'niveditgupta@dinodiasmartliving.com';
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function fail(status: number, errorCode: AuthErrorCode, error: string) {
  return NextResponse.json({ ok: false, errorCode, error }, { status });
}

export async function POST(req: NextRequest) {
  const disabled = legacyNativeRouteDisabled();
  if (disabled) return disabled;
  let body: {
    serial?: string;
    bootstrapSecret?: string;
    username?: string;
    password?: string;
    email?: string;
    phoneNumber?: string;
    deviceId?: string;
    deviceLabel?: string;
  };

  try {
    body = await req.json();
  } catch {
    return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Invalid request.');
  }

  const {
    serial,
    bootstrapSecret,
    username,
    password,
    email,
    phoneNumber,
    deviceId,
    deviceLabel,
  } = body ?? {};

  const ip = getClientIp(req);
  const rateKey = `register-serial:${ip}:${String(serial ?? '').toLowerCase()}`;
  const allowed = await checkRateLimit(rateKey, { maxRequests: 8, windowMs: 10 * 60_000 });
  if (!allowed) {
    return fail(
      429,
      AUTH_ERROR_CODES.RATE_LIMITED,
      'Too many setup attempts. Please wait a few minutes and try again.'
    );
  }

  if (!serial || !bootstrapSecret || !username || !password || !email || !phoneNumber || !deviceId) {
    return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'All fields are required.');
  }

  if (!EMAIL_REGEX.test(email)) {
    return fail(400, AUTH_ERROR_CODES.EMAIL_INVALID, 'Please enter a valid email address.');
  }
  const normalizedEmail = String(email).trim();

  const normalizedPhone = normalizePhoneNumberE164(phoneNumber);
  if (!normalizedPhone) {
    return fail(
      400,
      AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
      'Please enter a valid phone number (include country code, e.g. +44...).'
    );
  }

  // Enforce: at most one ADMIN/INSTALLER account can exist for a given phone number.
  // (A tenant may also use the same phone; that is allowed.)
  const existingAdminPhone = await prisma.user.findFirst({
    where: {
      role: { in: [Role.ADMIN, Role.INSTALLER] },
      phoneNumber: normalizedPhone,
    },
    select: { id: true },
  });
  if (existingAdminPhone) {
    return fail(
      409,
      AUTH_ERROR_CODES.REGISTRATION_BLOCKED,
      'That phone number is already used by another homeowner account. Please use a different phone number.'
    );
  }

  // Enforce: at most one ADMIN/INSTALLER account can exist for a given email.
  const existingAdminEmail = await prisma.user.findFirst({
    where: {
      role: { in: [Role.ADMIN, Role.INSTALLER] },
      OR: [
        { email: { equals: normalizedEmail, mode: 'insensitive' } },
        { emailPending: { equals: normalizedEmail, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (existingAdminEmail) {
    return fail(
      409,
      AUTH_ERROR_CODES.REGISTRATION_BLOCKED,
      'That email address is already used by another homeowner account. Please use a different email.'
    );
  }

  const existingUser = await prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existingUser) {
    return fail(409, AUTH_ERROR_CODES.REGISTRATION_BLOCKED, 'That username is already taken.');
  }

  const hubInstall = await verifyBootstrapClaim(serial, bootstrapSecret).catch((err) => {
    if (err instanceof HubInstallError) {
      return err;
    }
    throw err;
  });
  if (hubInstall instanceof HubInstallError) {
    return fail(hubInstall.status, AUTH_ERROR_CODES.REGISTRATION_BLOCKED, hubInstall.message);
  }

  const homeId = hubInstall.homeId;
  if (!homeId) {
    return fail(
      400,
      AUTH_ERROR_CODES.REGISTRATION_BLOCKED,
      'This Dinodia Hub is not fully provisioned. Ask your installer to provision it.'
    );
  }

  const home = await prisma.home.findUnique({
    where: { id: homeId },
    include: {
      users: { select: { id: true }, take: 1 },
      haConnection: true,
    },
  });
  if (!home || !home.haConnection) {
    return fail(
      400,
      AUTH_ERROR_CODES.REGISTRATION_BLOCKED,
      'Dinodia Hub provisioning is incomplete. Ask your installer to provision it again.'
    );
  }
  if (home.users.length > 0) {
    return fail(409, AUTH_ERROR_CODES.REGISTRATION_BLOCKED, 'This Dinodia Hub is already claimed.');
  }

  const activePending = await prisma.pendingHomeownerOnboarding.findFirst({
    where: {
      homeId,
      flowType: HomeownerOnboardingFlowType.SETUP_QR,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (activePending) {
    return fail(
      409,
      AUTH_ERROR_CODES.REGISTRATION_BLOCKED,
      'Homeowner setup is already pending for this Dinodia Hub. Ask the homeowner to complete email verification and policy acceptance.'
    );
  }

  const passwordHash = await hashPassword(password);

  const admin = await prisma.$transaction(async (tx) => {
    const admin = await tx.user.create({
      data: {
        username,
        passwordHash,
        role: Role.ADMIN,
        emailPending: normalizedEmail,
        emailVerifiedAt: null,
        phoneNumber: normalizedPhone,
        homeId: null,
        haConnectionId: null,
      },
    });
    return admin;
  });

  const pending = await createPendingHomeownerOnboarding({
    flowType: HomeownerOnboardingFlowType.SETUP_QR,
    userId: admin.id,
    proposedUsername: admin.username,
    proposedPasswordHash: passwordHash,
    proposedEmail: normalizedEmail,
    deviceId,
    deviceLabel: typeof deviceLabel === 'string' ? deviceLabel : null,
    homeId,
    hubInstallId: hubInstall.id,
  });

  const challenge = await createAuthChallenge({
    userId: admin.id,
    purpose: 'ADMIN_EMAIL_VERIFY',
    email: normalizedEmail,
    deviceId,
  });

  const appUrl = getAppUrl();
  const verifyUrl = buildVerifyUrl(challenge.token);
  const emailContent = buildVerifyLinkEmail({
    kind: 'ADMIN_EMAIL_VERIFY',
    verifyUrl,
    appUrl,
    username,
    deviceLabel,
  });

  await sendEmail({
    to: normalizedEmail,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
    replyTo: REPLY_TO,
  });

  return NextResponse.json({
    ok: true,
    requiresEmailVerification: true,
    challengeId: challenge.id,
    homeId,
    pendingOnboardingId: pending.id,
  });
}
