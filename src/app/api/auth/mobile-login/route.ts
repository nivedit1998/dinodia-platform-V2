// Architecture: API boundary /auth/mobile-login; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { authenticateWithCredentialsDetailed, createKioskToken, hashPassword } from '@/lib/auth';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { prisma } from '@/lib/prisma';
import {
  createAuthChallenge,
  buildVerifyUrl,
  getAppUrl,
} from '@/lib/authChallenges';
import { buildVerifyLinkEmail } from '@/lib/emailTemplates';
import { sendEmail } from '@/lib/email';
import { isDeviceTrusted, touchTrustedDevice, trustDevice } from '@/lib/deviceTrust';
import { registerOrValidateDevice, DeviceBlockedError } from '@/lib/deviceRegistry';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { hashForLog, safeLog } from '@/lib/safeLogger';
import { createLoginIntent } from '@/lib/loginIntents';
import { getHomeownerPolicyStatus } from '@/lib/homeownerPolicy';
import { normalizePhoneNumberWithCountry } from '@/lib/phoneNumber';
import { isCompanyPortalRole } from '@/lib/companyPortalAccess';
import {
  isAppleReviewDemoTenantUser,
  shouldSkipAppleReviewDemoRateLimit,
} from '@/lib/appleReviewDemoBypass';

const REPLY_TO = 'niveditgupta@dinodiasmartliving.com';
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function fail(status: number, errorCode: AuthErrorCode, error: string) {
  return NextResponse.json({ ok: false, errorCode, error }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const {
      username,
      password,
      deviceId,
      deviceLabel,
      email,
      phoneNumber,
      phoneCountryIso2,
      newPassword,
      confirmNewPassword,
      expectedRole,
    } = await req.json();
    const phoneNumberRaw = typeof phoneNumber === 'string' ? phoneNumber.trim() : '';

    if (!username || !password) {
      return fail(
        400,
        AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
        'Please enter both a username and password.'
      );
    }

    const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const isDemoUsernameAttempt = shouldSkipAppleReviewDemoRateLimit(normalizedUsername);

    if (!isDemoUsernameAttempt) {
      const ip = getClientIp(req);
      const rateKey = `mobile-login:${ip}:${normalizedUsername}`;
      const allowed = await checkRateLimit(rateKey, { maxRequests: 12, windowMs: 60_000 });
      if (!allowed) {
        return fail(
          429,
          AUTH_ERROR_CODES.RATE_LIMITED,
          'Too many login attempts. Please wait a moment and try again.'
        );
      }
    }

    const expectedRoleValue = typeof expectedRole === 'string' ? expectedRole.trim().toUpperCase() : '';
    const expected =
      expectedRoleValue === 'TENANT' ? Role.TENANT : expectedRoleValue === 'ADMIN' ? Role.ADMIN : null;

    const authResult = await authenticateWithCredentialsDetailed(normalizedUsername, password);
    const resolvedAuth =
      !authResult.ok && authResult.reason === 'EMAIL_NOT_UNIQUE' && expected
        ? await authenticateWithCredentialsDetailed(normalizedUsername, password, { expectedRole: expected })
        : authResult;
    if (!resolvedAuth.ok) {
      if (resolvedAuth.reason === 'USERNAME_NOT_FOUND') {
        return fail(
          401,
          AUTH_ERROR_CODES.USERNAME_NOT_FOUND,
          'This username doesn’t exist. Ask your homeowner to create it first.'
        );
      }
      if (resolvedAuth.reason === 'EMAIL_NOT_UNIQUE') {
        return fail(
          401,
          AUTH_ERROR_CODES.EMAIL_NOT_UNIQUE,
          'Multiple accounts use this email. Please sign in with your username instead.'
        );
      }
      return fail(401, AUTH_ERROR_CODES.INVALID_PASSWORD, 'That password is incorrect. Please try again.');
    }
    const authUser = resolvedAuth.user;

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        username: true,
        role: true,
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
      return fail(404, AUTH_ERROR_CODES.INTERNAL_ERROR, 'We could not find your account. Please try again.');
    }

    if (isCompanyPortalRole(user.role)) {
      return fail(403, AUTH_ERROR_CODES.ROLE_MISMATCH, 'Use Company login.');
    }

    if (expected && user.role !== expected) {
      const message = expected === Role.TENANT ? 'Use Tenant login.' : 'Use Homeowner login.';
      return fail(403, AUTH_ERROR_CODES.ROLE_MISMATCH, message);
    }

    const sessionUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
    const cloudEnabled = Boolean(user.home?.haConnection?.cloudUrl?.trim());

    if (isAppleReviewDemoTenantUser(user)) {
      const resolvedDemoDeviceId =
        typeof deviceId === 'string' && deviceId.trim().length > 0
          ? deviceId.trim()
          : 'apple-review-demo-device';

      await trustDevice(user.id, resolvedDemoDeviceId, deviceLabel);
      const trustedRow = await prisma.trustedDevice.findUnique({
        where: { userId_deviceId: { userId: user.id, deviceId: resolvedDemoDeviceId } },
      });
      type SessionVersionRow = { sessionVersion?: number | null };
      const sessionVersion = (trustedRow as unknown as SessionVersionRow | null)?.sessionVersion ?? 0;
      const token = createKioskToken(sessionUser, resolvedDemoDeviceId, sessionVersion);
      safeLog('info', '[mobile-login] Apple review demo bypass', {
        userId: user.id,
        deviceIdHash: hashForLog(resolvedDemoDeviceId),
      });
      return NextResponse.json({
        ok: true,
        token,
        role: user.role,
        cloudEnabled,
        appleReviewDemoBypass: true,
      });
    }

    // Phone number requirement:
    // - applies to TENANT + ADMIN only (INSTALLER excluded)
    // - hard-block for existing users missing phone, except allow tenant onboarding screens to proceed
    //   (mustChangePassword / initial email verification) so they can provide phone during setup.
    if ((user.role === Role.ADMIN || user.role === Role.TENANT) && !user.phoneNumber) {
      if (user.role === Role.ADMIN) {
        return fail(
          403,
          AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
          'Phone number is required. Please contact support.'
        );
      }

      const hasVerifiedEmail = Boolean(user.email && user.emailVerifiedAt);
      const requiresInitialEmailSetup = !hasVerifiedEmail || user.email2faEnabled === false;
      if (!user.mustChangePassword && !requiresInitialEmailSetup) {
        return fail(
          403,
          AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
          'Phone number is required. Please contact support.'
        );
      }
    }

    if (user.role === Role.TENANT) {
      const existing = (user.emailPending || user.email || '').trim().toLowerCase();
      const submitted = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (existing && submitted && submitted !== existing) {
        return fail(
          400,
          AUTH_ERROR_CODES.TENANT_EMAIL_MISMATCH,
          "Email doesn’t match the tenant created."
        );
      }
    }

    if (user.role === Role.TENANT && !user.phoneNumber && typeof phoneNumber === 'string' && phoneNumber.trim()) {
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

    const appUrl = getAppUrl();
    let loginIntentId: string | null = null;
    const getLoginIntentId = async () => {
      if (loginIntentId) return loginIntentId;
      if (!deviceId) return null;
      const intent = await createLoginIntent({
        userId: user.id,
        username: user.username,
        role: user.role,
        deviceId,
        deviceLabel: typeof deviceLabel === 'string' ? deviceLabel : null,
      });
      loginIntentId = intent.id;
      return loginIntentId;
    };

    if (!deviceId) {
      return fail(400, AUTH_ERROR_CODES.DEVICE_REQUIRED, 'Device information is required to continue.');
    }

    if (user.role === Role.TENANT && user.mustChangePassword) {
      if (typeof newPassword !== 'string' || typeof confirmNewPassword !== 'string') {
        return NextResponse.json({
          ok: true,
          role: user.role,
          requiresPasswordChange: true,
          passwordPolicy: { minLength: 8 },
          loginIntentId: await getLoginIntentId(),
        });
      }
      if (newPassword !== confirmNewPassword) {
        return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'New passwords do not match.');
      }
      if (newPassword.length < 8) {
        return fail(400, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'Password must be at least 8 characters.');
      }
      if (newPassword === password) {
        return fail(
          400,
          AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
          'New password must be different from the current password.'
        );
      }

      const now = new Date();
      const passwordHash = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false, passwordChangedAt: now },
      });
    }

    try {
      await registerOrValidateDevice(deviceId);
    } catch (err) {
      const message =
        err instanceof DeviceBlockedError ? err.message : 'This device is blocked. Please contact support.';
      return fail(403, AUTH_ERROR_CODES.DEVICE_REQUIRED, message);
    }

    if (user.role === Role.ADMIN) {
      if (!user.emailVerifiedAt) {
        let targetEmail = user.emailPending || user.email;

        if (!targetEmail) {
          if (!email) {
            return NextResponse.json({
              ok: true,
              requiresEmailVerification: true,
              needsEmailInput: true,
              role: user.role,
              loginIntentId: await getLoginIntentId(),
            });
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

        if (!targetEmail) {
          return fail(
            400,
            AUTH_ERROR_CODES.EMAIL_REQUIRED,
            'An email address is required for verification.'
          );
        }

        if (!deviceId) {
          return fail(
            400,
            AUTH_ERROR_CODES.DEVICE_REQUIRED,
            'Device information is required for verification.'
          );
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

        safeLog('info', '[mobile-login] Sent admin email verification challenge', {
          userId: user.id,
          challengeId: challenge.id,
        });

        return NextResponse.json({
          ok: true,
          requiresEmailVerification: true,
          challengeId: challenge.id,
          role: user.role,
          loginIntentId: await getLoginIntentId(),
        });
      }

      if (!deviceId) {
        return fail(400, AUTH_ERROR_CODES.DEVICE_REQUIRED, 'Device information is required to continue.');
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

        safeLog('info', '[mobile-login] Sent admin new device challenge', {
          userId: user.id,
          challengeId: challenge.id,
        });

        return NextResponse.json({
          ok: true,
          requiresEmailVerification: true,
          challengeId: challenge.id,
          role: user.role,
          loginIntentId: await getLoginIntentId(),
        });
      }

      await touchTrustedDevice(user.id, deviceId);
      const trustedRow = await prisma.trustedDevice.findUnique({
        where: { userId_deviceId: { userId: user.id, deviceId } },
      });
      type SessionVersionRow = { sessionVersion?: number | null };
      const sessionVersion = (trustedRow as unknown as SessionVersionRow | null)?.sessionVersion ?? 0;
      const token = createKioskToken(sessionUser, deviceId, sessionVersion);
      safeLog('info', '[mobile-login] Admin login successful', { userId: user.id });
      const policy = await getHomeownerPolicyStatus(user.id);
      return NextResponse.json({
        ok: true,
        token,
        role: user.role,
        cloudEnabled,
        requiresHomeownerPolicyAcceptance: policy?.requiresAcceptance ?? true,
        homeownerPolicyVersion: policy?.policyVersion ?? '2026-V1',
        pendingOnboardingId: policy?.pendingOnboardingId ?? null,
      });
    }

    // Tenant
    const hasVerifiedEmail = Boolean(user.email && user.emailVerifiedAt);
    const requiresInitialEmailSetup = !hasVerifiedEmail || user.email2faEnabled === false;

    if (requiresInitialEmailSetup) {
      if (!user.phoneNumber && !phoneNumberRaw) {
        return NextResponse.json({
          ok: true,
          requiresEmailVerification: true,
          needsEmailInput: true,
          role: user.role,
          loginIntentId: await getLoginIntentId(),
        });
      }
      if (!deviceId) {
        return fail(
          400,
          AUTH_ERROR_CODES.DEVICE_REQUIRED,
          'Device information is required for verification.'
        );
      }

      let targetEmail = user.emailPending || user.email;
      if (!targetEmail) {
        if (email) {
          if (!EMAIL_REGEX.test(email)) {
            return fail(400, AUTH_ERROR_CODES.EMAIL_INVALID, 'Please enter a valid email address.');
          }
          targetEmail = email;
          await prisma.user.update({
            where: { id: user.id },
            data: { emailPending: targetEmail, emailVerifiedAt: null },
          });
        } else {
          return NextResponse.json({
            ok: true,
            requiresEmailVerification: true,
            needsEmailInput: true,
            role: user.role,
            loginIntentId: await getLoginIntentId(),
          });
        }
      }

      const safeEmail = targetEmail ?? email ?? '';

      const challenge = await createAuthChallenge({
        userId: user.id,
        purpose: 'TENANT_ENABLE_2FA',
        email: safeEmail,
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
        to: safeEmail,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        replyTo: REPLY_TO,
      });

      safeLog('info', '[mobile-login] Sent tenant email verification challenge', {
        userId: user.id,
        challengeId: challenge.id,
      });

      return NextResponse.json({
        ok: true,
        requiresEmailVerification: true,
        challengeId: challenge.id,
        role: user.role,
        loginIntentId: await getLoginIntentId(),
      });
    }

    if (!deviceId) {
      return fail(400, AUTH_ERROR_CODES.DEVICE_REQUIRED, 'Device information is required to continue.');
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

      safeLog('info', '[mobile-login] Sent tenant new device challenge', {
        userId: user.id,
        challengeId: challenge.id,
      });

      return NextResponse.json({
        ok: true,
        requiresEmailVerification: true,
        challengeId: challenge.id,
        role: user.role,
        loginIntentId: await getLoginIntentId(),
      });
    }

    await touchTrustedDevice(user.id, deviceId);
    const trustedRow = await prisma.trustedDevice.findUnique({
      where: { userId_deviceId: { userId: user.id, deviceId } },
    });
    type SessionVersionRow = { sessionVersion?: number | null };
    const sessionVersion = (trustedRow as unknown as SessionVersionRow | null)?.sessionVersion ?? 0;
    const token = createKioskToken(sessionUser, deviceId, sessionVersion);
    safeLog('info', '[mobile-login] Tenant login successful', { userId: user.id });
    return NextResponse.json({ ok: true, token, role: user.role, cloudEnabled });
  } catch (err) {
    safeLog('error', '[mobile-login] Login error', { error: err });
    return fail(
      500,
      AUTH_ERROR_CODES.INTERNAL_ERROR,
      'We couldn’t log you in right now. Please try again in a moment.'
    );
  }
}
