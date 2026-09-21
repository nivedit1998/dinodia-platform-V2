// Architecture: API boundary /auth/register-admin; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { HomeownerOnboardingFlowType, Role } from '@prisma/client';
import { createAuthChallenge, buildVerifyUrl, getAppUrl } from '@/lib/authChallenges';
import { buildVerifyLinkEmail } from '@/lib/emailTemplates';
import { sendEmail } from '@/lib/email';
import { HubInstallError, verifyBootstrapClaim } from '@/lib/hubInstall';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { createPendingHomeownerOnboarding } from '@/lib/homeownerOnboardingPending';
import { normalizePhoneNumberWithCountry } from '@/lib/phoneNumber';
import { logServerError } from '@/lib/serverErrorLog';
import { legacyNativeRouteDisabled } from '@/lib/legacyNativeRouteGate';

function fail(status: number, errorCode: AuthErrorCode, error: string) {
  return NextResponse.json({ ok: false, errorCode, error }, { status });
}

export async function POST(req: NextRequest) {
  const disabled = legacyNativeRouteDisabled();
  if (disabled) return disabled;
  try {
    const body = await req.json();

    const {
      username,
      password,
      email,
      phoneNumber,
      phoneCountryIso2,
      deviceId,
      deviceLabel,
      dinodiaSerial,
      bootstrapSecret,
    } = body;

    const ip = getClientIp(req);
    const rateKey = `register-admin:${ip}:${String(dinodiaSerial ?? '').toLowerCase()}`;
    const allowed = await checkRateLimit(rateKey, { maxRequests: 8, windowMs: 10 * 60_000 });
    if (!allowed) {
      return fail(
        429,
        AUTH_ERROR_CODES.RATE_LIMITED,
        'Too many setup attempts. Please wait a few minutes and try again.'
      );
    }

    if (!username || !password || !email || !phoneNumber || !deviceId || !dinodiaSerial || !bootstrapSecret) {
      return fail(
        400,
        AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
        'Please fill in all fields to connect your Dinodia Hub.'
      );
    }

    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!emailRegex.test(email)) {
      return fail(400, AUTH_ERROR_CODES.EMAIL_INVALID, 'Please enter a valid email address.');
    }
    const normalizedEmail = String(email).trim();

    const normalizedPhone = normalizePhoneNumberWithCountry({
      countryIso2: phoneCountryIso2,
      nationalNumber: phoneNumber,
      fullNumber: phoneNumber,
    });
    if (!normalizedPhone) {
      return fail(
        400,
        AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
        'Enter a valid phone number.'
      );
    }

    // Enforce phone uniqueness: at most one ADMIN/INSTALLER account can exist for a given phone number.
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
    // (A tenant may also use the same email; that is allowed.)
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

    const existing = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      return fail(409, AUTH_ERROR_CODES.REGISTRATION_BLOCKED, 'That username is already taken. Try another one.');
    }

    let hubInstall;
    try {
      hubInstall = await verifyBootstrapClaim(dinodiaSerial, bootstrapSecret);
    } catch (err) {
      if (err instanceof HubInstallError) {
        return fail(err.status, AUTH_ERROR_CODES.REGISTRATION_BLOCKED, err.message);
      }
      throw err;
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
      const createdAdmin = await tx.user.create({
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
      return createdAdmin;
    });

    const pending = await createPendingHomeownerOnboarding({
      flowType: HomeownerOnboardingFlowType.SETUP_QR,
      userId: admin.id,
      proposedUsername: admin.username,
      proposedPasswordHash: passwordHash,
      proposedEmail: email,
      deviceId,
      deviceLabel: typeof deviceLabel === 'string' ? deviceLabel : null,
      homeId,
      hubInstallId: hubInstall.id,
    });

    const challenge = await createAuthChallenge({
      userId: admin.id,
      purpose: 'ADMIN_EMAIL_VERIFY',
      email,
      deviceId,
    });

    const appUrl = getAppUrl();
    const verifyUrl = buildVerifyUrl(challenge.token);
    const emailContent = buildVerifyLinkEmail({
      kind: 'ADMIN_EMAIL_VERIFY',
      verifyUrl,
      appUrl,
      username: admin.username,
      deviceLabel,
    });

    await sendEmail({
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      replyTo: 'niveditgupta@dinodiasmartliving.com',
    });

    return NextResponse.json({
      ok: true,
      requiresEmailVerification: true,
      challengeId: challenge.id,
      pendingOnboardingId: pending.id,
    });
  } catch (err) {
    logServerError('[api/auth/register-admin] unhandled', err);
    return fail(
      500,
      AUTH_ERROR_CODES.INTERNAL_ERROR,
      'We couldn’t finish setting up the homeowner account. Please try again.'
    );
  }
}
