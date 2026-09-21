// Architecture: API boundary /alexa/oauth/authorize; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { alexaRoleError, isAlexaEligibleRole } from '@/lib/alexaScope';
import { authenticateWithCredentials } from '@/lib/auth';
import {
  AlexaOAuthError,
  buildOAuthRedirectUri,
  issueAlexaAuthorizationCode,
  validateAlexaClientRequest,
} from '@/lib/alexaOAuth';
import { prisma } from '@/lib/prisma';
import {
  buildVerifyUrl,
  createAuthChallenge,
  getAppUrl,
} from '@/lib/authChallenges';
import { buildVerifyLinkEmail } from '@/lib/emailTemplates';
import { sendEmail } from '@/lib/email';
import { isDeviceTrusted } from '@/lib/deviceTrust';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { logServerError } from '@/lib/serverErrorLog';
import {
  isAppleReviewDemoTenantUser,
  shouldSkipAppleReviewDemoRateLimit,
} from '@/lib/appleReviewDemoBypass';

export const runtime = 'nodejs';

const REPLY_TO = 'niveditgupta@dinodiasmartliving.com';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return apiFailFromStatus(400, 'Invalid request. Please start linking again from the Alexa app.');
    }

    const {
      username,
      password,
      clientId,
      redirectUri,
      responseType,
      state,
      deviceId,
      deviceLabel,
    } = body as {
      username?: string;
      password?: string;
      clientId?: string;
      redirectUri?: string;
      responseType?: string;
      state?: string;
      deviceId?: string;
      deviceLabel?: string;
    };

    if (!username || !password) {
      return apiFailFromStatus(400, 'Please enter your Dinodia username and password.');
    }

    if (!clientId || !redirectUri) {
      return apiFailFromStatus(400, 'Some link details are missing. Please start linking again from the Alexa app.');
    }

    if (responseType !== 'code') {
      return apiFailFromStatus(400, 'We couldn’t finish linking with Alexa. Please try again.');
    }

    if (!shouldSkipAppleReviewDemoRateLimit(username)) {
      const ip = getClientIp(req);
      const rateKey = `alexa-authz:${ip}:${username.toLowerCase()}`;
      const allowed = await checkRateLimit(rateKey, { maxRequests: 10, windowMs: 60_000 });
      if (!allowed) {
        return apiFailFromStatus(429, 'Too many attempts. Please wait a moment and try again.');
      }
    }

    try {
      validateAlexaClientRequest(clientId, redirectUri);
    } catch (err) {
      if (err instanceof AlexaOAuthError) {
        return apiFailFromStatus(err.status, err.message);
      }
      throw err;
    }

    const authUser = await authenticateWithCredentials(username, password);
    if (!authUser) {
      return apiFailFromStatus(401, 'Those details don’t match any Dinodia account.');
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        username: true,
        role: true,
        email: true,
        emailVerifiedAt: true,
        email2faEnabled: true,
      },
    });

    if (!user) {
      return apiFailFromStatus(404, 'We couldn’t find your account. Please try again.');
    }

    if (!isAlexaEligibleRole(user.role)) {
      return apiFailFromStatus(403, alexaRoleError());
    }

    const issueRedirect = async () => {
      try {
        const code = await issueAlexaAuthorizationCode(authUser.id, clientId, redirectUri);
        const redirectTo = buildOAuthRedirectUri(redirectUri, code, state);
        return NextResponse.json({ redirectTo });
      } catch (err) {
        logServerError('[api/alexa/oauth/authorize] failed to issue code', err, { userId: authUser.id });
        if (err instanceof AlexaOAuthError) {
          return apiFailFromStatus(err.status, err.message);
        }
        return apiFailFromStatus(500, 'We couldn’t complete linking with Alexa. Please try again in a moment.');
      }
    };

    if (isAppleReviewDemoTenantUser(user)) {
      return issueRedirect();
    }

    const verificationRequired = user.email2faEnabled === true;
    if (user.email2faEnabled) {
      if (!user.email || !user.emailVerifiedAt) {
        return apiFailFromStatus(400, 'Enable 2FA in the Dinodia app first.');
      }
    }

    if (!verificationRequired) {
      return issueRedirect();
    }

    if (!deviceId) {
      return apiFailFromStatus(400, 'Missing device identifier. Please try again.');
    }

    const trusted = await isDeviceTrusted(user.id, deviceId);
    if (trusted) {
      return issueRedirect();
    }

    const targetEmail = user.email;
    if (!targetEmail) {
      return apiFailFromStatus(400, 'Enable 2FA in the Dinodia app first.');
    }

    const challenge = await createAuthChallenge({
      userId: user.id,
      purpose: 'LOGIN_NEW_DEVICE',
      email: targetEmail,
      deviceId,
    });

    const verifyUrl = buildVerifyUrl(challenge.token);
    const appUrl = getAppUrl();
    const emailContent = buildVerifyLinkEmail({
      kind: 'LOGIN_NEW_DEVICE',
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

    return NextResponse.json({
      ok: true,
      requiresEmailVerification: true,
      challengeId: challenge.id,
    });
  } catch (err) {
    logServerError('[api/alexa/oauth/authorize] unexpected error', err, { ip: getClientIp(req) });
    return apiFailFromStatus(500, 'We couldn’t complete linking with Alexa. Please try again in a moment.');
  }
}
