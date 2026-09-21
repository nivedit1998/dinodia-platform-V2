// Architecture: API boundary /auth/login-intents; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { authenticateWithCredentialsDetailed } from '@/lib/auth';
import { AUTH_ERROR_CODES, type AuthErrorCode } from '@/lib/authErrorCodes';
import { createLoginIntent } from '@/lib/loginIntents';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { isCompanyPortalRole } from '@/lib/companyPortalAccess';
import {
  isAppleReviewDemoTenantUser,
  shouldSkipAppleReviewDemoRateLimit,
} from '@/lib/appleReviewDemoBypass';

function fail(status: number, errorCode: AuthErrorCode, error: string) {
  return NextResponse.json({ ok: false, errorCode, error }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
    const deviceLabel = typeof body?.deviceLabel === 'string' ? body.deviceLabel : null;
    const expectedRoleRaw = typeof body?.expectedRole === 'string' ? body.expectedRole.trim().toUpperCase() : '';
    const expectedRole = Object.values(Role).includes(expectedRoleRaw as Role) ? (expectedRoleRaw as Role) : null;

    if (!username || !password) {
      return fail(
        400,
        AUTH_ERROR_CODES.INVALID_LOGIN_INPUT,
        'Please enter both a username and password.'
      );
    }
    if (!deviceId) {
      return fail(400, AUTH_ERROR_CODES.DEVICE_REQUIRED, 'Device information is required to continue.');
    }

    if (!shouldSkipAppleReviewDemoRateLimit(username)) {
      const ip = getClientIp(req);
      const rateKey = `login-intent:${ip}:${username}`;
      const allowed = await checkRateLimit(rateKey, { maxRequests: 10, windowMs: 60_000 });
      if (!allowed) {
        return fail(
          429,
          AUTH_ERROR_CODES.RATE_LIMITED,
          'Too many login attempts. Please wait a moment and try again.'
        );
      }
    }

    const authResult = await authenticateWithCredentialsDetailed(username, password);
    const resolvedAuth =
      !authResult.ok && authResult.reason === 'EMAIL_NOT_UNIQUE' && expectedRole
        ? await authenticateWithCredentialsDetailed(username, password, { expectedRole })
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

    const user = await prisma.user.findUnique({
      where: { id: resolvedAuth.user.id },
      select: {
        id: true,
        username: true,
        role: true,
        mustChangePassword: true,
        isActive: true,
        email: true,
        emailPending: true,
        emailVerifiedAt: true,
        email2faEnabled: true,
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
    if (user.isActive === false) {
      return fail(403, AUTH_ERROR_CODES.INVALID_LOGIN_INPUT, 'This account is inactive. Please contact CXO support.');
    }

    if (expectedRole && user.role !== expectedRole) {
      const message =
        isCompanyPortalRole(user.role)
          ? `Use ${user.role.replaceAll('_', ' ').toLowerCase()} login.`
          : expectedRole === Role.TENANT
            ? 'Use Tenant login.'
            : 'Use Homeowner login.';
      return fail(403, AUTH_ERROR_CODES.ROLE_MISMATCH, message);
    }

    const hasVerifiedEmail = Boolean(user.email && user.emailVerifiedAt);
    const isCompanyRole = isCompanyPortalRole(user.role);
    const isAppleDemoUser = isAppleReviewDemoTenantUser(user);
    const requiresPasswordChange = isAppleDemoUser
      ? false
      : isCompanyRole
        ? user.mustChangePassword
        : user.role === Role.TENANT && user.mustChangePassword;
    const requiresEmailVerification = isAppleDemoUser
      ? false
      : isCompanyRole
        ? false
        : user.role === Role.ADMIN
          ? !user.emailVerifiedAt
          : !hasVerifiedEmail || user.email2faEnabled === false;
    const needsEmailInput = requiresEmailVerification && !(user.emailPending || user.email);
    const cloudEnabled = Boolean(user.home?.haConnection?.cloudUrl?.trim());

    const intent = await createLoginIntent({
      userId: user.id,
      username: user.username,
      role: user.role,
      deviceId,
      deviceLabel,
    });

    return NextResponse.json({
      ok: true,
      role: user.role,
      cloudEnabled,
      loginIntentId: intent.id,
      requiresPasswordChange,
      passwordPolicy: requiresPasswordChange ? { minLength: 8 } : undefined,
      requiresEmailVerification,
      needsEmailInput,
      appleReviewDemoBypass: isAppleDemoUser,
    });
  } catch {
    return fail(
      500,
      AUTH_ERROR_CODES.INTERNAL_ERROR,
      'We couldn’t start this login right now. Please try again in a moment.'
    );
  }
}
