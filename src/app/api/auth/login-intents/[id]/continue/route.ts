// Architecture: API boundary /auth/login-intents/[id]/continue; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { createSessionForUser, hashPassword, verifyPassword } from '@/lib/auth';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { createAuthChallenge, buildVerifyUrl, getAppUrl } from '@/lib/authChallenges';
import { isDeviceTrusted, touchTrustedDevice, trustDevice } from '@/lib/deviceTrust';
import { getOrCreateDevice } from '@/lib/deviceRegistry';
import { sendEmail } from '@/lib/email';
import { buildVerifyLinkEmail } from '@/lib/emailTemplates';
import { consumeLoginIntent, getActiveLoginIntent } from '@/lib/loginIntents';
import { prisma } from '@/lib/prisma';
import { normalizePhoneNumberWithCountry } from '@/lib/phoneNumber';
import { getCompanyLandingPath, isCompanyPortalRole } from '@/lib/companyPortalAccess';
import { isAppleReviewDemoTenantUser } from '@/lib/appleReviewDemoBypass';

const REPLY_TO = 'niveditgupta@dinodiasmartliving.com';
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type ContinueBody = {
  email?: string;
  confirmEmail?: string;
  phoneNumber?: string;
  phoneCountryIso2?: string;
  newPassword?: string;
  confirmNewPassword?: string;
  deviceLabel?: string;
};

function fail(status: number, errorCode: AuthErrorCode, error: string) {
  return NextResponse.json({ ok: false, errorCode, error }, { status });
}

function normalizedOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const intentResult = await getActiveLoginIntent(id);
  if (!intentResult.ok) {
    if (intentResult.reason === 'EXPIRED') {
      return fail(410, AUTH_ERROR_CODES.VERIFICATION_FAILED, 'Login session expired. Please sign in again.');
    }
    if (intentResult.reason === 'NOT_FOUND') {
      return fail(404, AUTH_ERROR_CODES.VERIFICATION_FAILED, 'Login session not found. Please sign in again.');
    }
    return fail(409, AUTH_ERROR_CODES.VERIFICATION_FAILED, 'Login session is no longer valid.');
  }

  const intent = intentResult.intent;
  const body = (await req.json().catch(() => ({}))) as ContinueBody;
  const email = normalizedOptionalString(body.email).toLowerCase();
  const confirmEmail = normalizedOptionalString(body.confirmEmail).toLowerCase();
  const phoneNumberRaw = normalizedOptionalString(body.phoneNumber);
  const phoneCountryIso2 = normalizedOptionalString(body.phoneCountryIso2);
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  const confirmNewPassword = typeof body.confirmNewPassword === 'string' ? body.confirmNewPassword : '';
  const deviceId = intent.deviceId;
  const deviceLabel =
    (typeof body.deviceLabel === 'string' && body.deviceLabel.trim()) || intent.deviceLabel || undefined;

  const user = await prisma.user.findUnique({
    where: { id: intent.userId },
    select: {
      id: true,
      username: true,
      role: true,
      isActive: true,
      passwordHash: true,
      mustChangePassword: true,
      email: true,
      emailPending: true,
      emailVerifiedAt: true,
      email2faEnabled: true,
      phoneNumber: true,
      home: {
        select: {
          haConnection: {
            select: {
              cloudUrl: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    return fail(404, AUTH_ERROR_CODES.INTERNAL_ERROR, 'User not found.');
  }
  if (user.isActive === false) {
    return fail(403, AUTH_ERROR_CODES.VERIFICATION_FAILED, 'This account is inactive. Please contact CXO support.');
  }
  if (user.role !== intent.role) {
    return fail(403, AUTH_ERROR_CODES.VERIFICATION_FAILED, 'Login session role mismatch.');
  }

  const sessionUser = {
    id: user.id,
    username: user.username,
    role: user.role,
  };
  const cloudEnabled = Boolean(user.home?.haConnection?.cloudUrl?.trim());
  const appUrl = getAppUrl();

  if (isAppleReviewDemoTenantUser(user)) {
    await trustDevice(user.id, deviceId, deviceLabel);
    await createSessionForUser(sessionUser);
    await consumeLoginIntent(intent.id);

    return NextResponse.json({
      ok: true,
      role: user.role,
      cloudEnabled,
      appleReviewDemoBypass: true,
    });
  }

  if (isCompanyPortalRole(user.role)) {
    if (user.mustChangePassword) {
      if (!newPassword || !confirmNewPassword) {
        return NextResponse.json({
          ok: true,
          role: user.role,
          requiresPasswordChange: true,
          passwordPolicy: { minLength: 8 },
          loginIntentId: intent.id,
        });
      }
      if (newPassword !== confirmNewPassword) {
        return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'New passwords do not match.');
      }
      if (newPassword.length < 8) {
        return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Password must be at least 8 characters.');
      }
      const sameAsCurrent = await verifyPassword(newPassword, user.passwordHash);
      if (sameAsCurrent) {
        return fail(
          400,
          AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
          'New password must be different from the current password.'
        );
      }

      const passwordHash = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        },
      });
      user.mustChangePassword = false;
    }

    await trustDevice(user.id, deviceId, deviceLabel);
    await createSessionForUser(sessionUser);
    await consumeLoginIntent(intent.id);
    return NextResponse.json({
      ok: true,
      role: user.role,
      cloudEnabled,
      redirectTo: getCompanyLandingPath(user.role),
    });
  }

  if (user.role === Role.TENANT && !user.phoneNumber) {
    if (!phoneNumberRaw) {
      return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Phone number is required to continue.');
    }
    const normalizedPhone = normalizePhoneNumberWithCountry({
      countryIso2: phoneCountryIso2,
      nationalNumber: phoneNumberRaw,
      fullNumber: phoneNumberRaw,
    });
    if (!normalizedPhone) {
      return fail(
        400,
        AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
        'Enter a valid phone number.'
      );
    }
    const existingTenantPhone = await prisma.user.findFirst({
      where: { role: Role.TENANT, phoneNumber: normalizedPhone, id: { not: user.id } },
      select: { id: true },
    });
    if (existingTenantPhone) {
      return fail(
        409,
        AUTH_ERROR_CODES.REGISTRATION_BLOCKED,
        'That phone number is already used by another tenant. Please use a different phone number.'
      );
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { phoneNumber: normalizedPhone },
    });
    user.phoneNumber = normalizedPhone;
  }

  // Hard-stop: do not allow a tenant to substitute a different email during first-login/setup
  // if an email (or pending email) is already associated to the account.
  if (user.role === Role.TENANT) {
    const existing = (user.emailPending || user.email || '').trim().toLowerCase();
    if (existing && email && email !== existing) {
      return fail(
        400,
        AUTH_ERROR_CODES.TENANT_EMAIL_MISMATCH,
        "Email doesn’t match the tenant created."
      );
    }
    if (existing && confirmEmail && confirmEmail !== existing) {
      return fail(
        400,
        AUTH_ERROR_CODES.TENANT_EMAIL_MISMATCH,
        "Email doesn’t match the tenant created."
      );
    }
  }

  if (user.role === Role.ADMIN) {
    await getOrCreateDevice(deviceId);
    if (!user.emailVerifiedAt) {
      let targetEmail = user.emailPending || user.email;
      if (!targetEmail) {
        if (!email) {
          return NextResponse.json({
            ok: true,
            role: user.role,
            requiresEmailVerification: true,
            needsEmailInput: true,
            loginIntentId: intent.id,
          });
        }
        if (confirmEmail && email !== confirmEmail) {
          return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Email addresses must match.');
        }
        if (!EMAIL_REGEX.test(email)) {
          return fail(400, AUTH_ERROR_CODES.EMAIL_INVALID, 'Please enter a valid email address.');
        }
        targetEmail = email;
        await prisma.user.update({
          where: { id: user.id },
          data: { emailPending: targetEmail, emailVerifiedAt: null },
        });
      }

      const challenge = await createAuthChallenge({
        userId: user.id,
        purpose: 'ADMIN_EMAIL_VERIFY',
        email: targetEmail,
        deviceId,
      });
      const verifyUrl = buildVerifyUrl(challenge.token);
      const emailContent = buildVerifyLinkEmail({
        kind: 'ADMIN_EMAIL_VERIFY',
        verifyUrl,
        appUrl,
        username: user.username,
        deviceLabel,
      });
      await sendEmail({
        to: targetEmail,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        replyTo: REPLY_TO,
      });
      await consumeLoginIntent(intent.id);
      return NextResponse.json({
        ok: true,
        role: user.role,
        requiresEmailVerification: true,
        challengeId: challenge.id,
        loginIntentId: intent.id,
      });
    }

    const trusted = await isDeviceTrusted(user.id, deviceId);
    if (!trusted) {
      if (!user.email) {
        return fail(400, AUTH_ERROR_CODES.EMAIL_REQUIRED, 'Admin email is missing. Please contact support.');
      }
      const challenge = await createAuthChallenge({
        userId: user.id,
        purpose: 'LOGIN_NEW_DEVICE',
        email: user.email,
        deviceId,
      });
      const verifyUrl = buildVerifyUrl(challenge.token);
      const emailContent = buildVerifyLinkEmail({
        kind: 'LOGIN_NEW_DEVICE',
        verifyUrl,
        appUrl,
        username: user.username,
        deviceLabel,
      });
      await sendEmail({
        to: user.email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        replyTo: REPLY_TO,
      });
      await consumeLoginIntent(intent.id);
      return NextResponse.json({
        ok: true,
        role: user.role,
        requiresEmailVerification: true,
        challengeId: challenge.id,
        loginIntentId: intent.id,
      });
    }

    await touchTrustedDevice(user.id, deviceId);
    await createSessionForUser(sessionUser);
    await consumeLoginIntent(intent.id);
    return NextResponse.json({ ok: true, role: user.role, cloudEnabled });
  }

  if (user.mustChangePassword) {
    if (!newPassword || !confirmNewPassword) {
      return NextResponse.json({
        ok: true,
        role: user.role,
        requiresPasswordChange: true,
        passwordPolicy: { minLength: 8 },
        loginIntentId: intent.id,
      });
    }
    if (newPassword !== confirmNewPassword) {
      return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'New passwords do not match.');
    }
    if (newPassword.length < 8) {
      return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Password must be at least 8 characters.');
    }
    const sameAsCurrent = await verifyPassword(newPassword, user.passwordHash);
    if (sameAsCurrent) {
      return fail(
        400,
        AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
        'New password must be different from the current password.'
      );
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });
    user.mustChangePassword = false;
  }

  const hasVerifiedEmail = Boolean(user.email && user.emailVerifiedAt);
  const requiresInitialEmailSetup = !hasVerifiedEmail || user.email2faEnabled === false;
  if (requiresInitialEmailSetup) {
    let targetEmail = user.emailPending || user.email;
    if (!targetEmail) {
      if (!email) {
        return NextResponse.json({
          ok: true,
          role: user.role,
          requiresEmailVerification: true,
          needsEmailInput: true,
          loginIntentId: intent.id,
        });
      }
      if (confirmEmail && email !== confirmEmail) {
        return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Email addresses must match.');
      }
      if (!EMAIL_REGEX.test(email)) {
        return fail(400, AUTH_ERROR_CODES.EMAIL_INVALID, 'Please enter a valid email address.');
      }
      targetEmail = email;
      await prisma.user.update({
        where: { id: user.id },
        data: { emailPending: targetEmail, emailVerifiedAt: null },
      });
    }

    const challenge = await createAuthChallenge({
      userId: user.id,
      purpose: 'TENANT_ENABLE_2FA',
      email: targetEmail,
      deviceId,
    });
    const verifyUrl = buildVerifyUrl(challenge.token);
    const emailContent = buildVerifyLinkEmail({
      kind: 'TENANT_ENABLE_2FA',
      verifyUrl,
      appUrl,
      username: user.username,
      deviceLabel,
    });
    await sendEmail({
      to: targetEmail,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      replyTo: REPLY_TO,
    });
    await consumeLoginIntent(intent.id);
    return NextResponse.json({
      ok: true,
      role: user.role,
      requiresEmailVerification: true,
      challengeId: challenge.id,
      loginIntentId: intent.id,
    });
  }

  if (!user.email) {
    return fail(
      400,
      AUTH_ERROR_CODES.EMAIL_REQUIRED,
      'Email is required for verification. Please contact support.'
    );
  }

  const trusted = await isDeviceTrusted(user.id, deviceId);
  if (!trusted) {
    const challenge = await createAuthChallenge({
      userId: user.id,
      purpose: 'LOGIN_NEW_DEVICE',
      email: user.email,
      deviceId,
    });
    const verifyUrl = buildVerifyUrl(challenge.token);
    const emailContent = buildVerifyLinkEmail({
      kind: 'LOGIN_NEW_DEVICE',
      verifyUrl,
      appUrl,
      username: user.username,
      deviceLabel,
    });
    await sendEmail({
      to: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      replyTo: REPLY_TO,
    });
    await consumeLoginIntent(intent.id);
    return NextResponse.json({
      ok: true,
      role: user.role,
      requiresEmailVerification: true,
      challengeId: challenge.id,
      loginIntentId: intent.id,
    });
  }

  await touchTrustedDevice(user.id, deviceId);
  await createSessionForUser(sessionUser);
  await consumeLoginIntent(intent.id);
  return NextResponse.json({ ok: true, role: user.role, cloudEnabled });
}
