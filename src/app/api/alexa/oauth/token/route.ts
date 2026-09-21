// Architecture: API boundary /alexa/oauth/token; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { createToken } from '@/lib/auth';
import {
  AlexaOAuthError,
  consumeAlexaAuthorizationCode,
  getAlexaAccessTokenTtlSeconds,
  issueAlexaRefreshToken,
  rotateAlexaRefreshToken,
  validateAlexaClientRequest,
  validateAlexaClientSecret,
} from '@/lib/alexaOAuth';
import { checkRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/requestInfo';
import { logServerError } from '@/lib/serverErrorLog';

type ParsedClientCredentials = {
  clientId: string;
  clientSecret: string;
};

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = (await req.json().catch(() => ({}))) as Record<string, string>;
    return json ?? {};
  }

  const raw = await req.text();
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function parseBasicAuth(header: string | null | undefined): ParsedClientCredentials | null {
  if (!header || !header.startsWith('Basic ')) return null;
  const base64 = header.slice('Basic '.length);
  try {
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return null;
    const clientId = decoded.slice(0, separatorIndex);
    const clientSecret = decoded.slice(separatorIndex + 1);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

function extractClientCredentials(
  req: NextRequest,
  body: Record<string, string>
): ParsedClientCredentials {
  const basic = parseBasicAuth(req.headers.get('authorization'));
  if (basic) {
    return basic;
  }

  const clientId = body.client_id;
  const clientSecret = body.client_secret;

  if (!clientId || !clientSecret) {
    throw new AlexaOAuthError('invalid_client', 'Missing client credentials');
  }

  return { clientId, clientSecret };
}

function oauthError(error: string, errorDescription: string, status = 400) {
  return NextResponse.json({ error, error_description: errorDescription }, { status });
}

export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await parseBody(req);
  } catch (err) {
    logServerError('[api/alexa/oauth/token] failed to parse body', err, { ip: getClientIp(req) });
    return oauthError('invalid_request', 'Unable to parse request body');
  }

  const grantType = body.grant_type;
  if (!grantType) {
    return oauthError('invalid_request', 'Missing grant_type');
  }

  let client: ParsedClientCredentials;
  try {
    client = extractClientCredentials(req, body);
    validateAlexaClientSecret(client.clientId, client.clientSecret);
  } catch (err) {
    if (err instanceof AlexaOAuthError) {
      return oauthError(err.code, err.message, err.status);
    }
    throw err;
  }

  const accessTokenTtl = getAlexaAccessTokenTtlSeconds();

  try {
    const ip = getClientIp(req);
    const rateKey = `alexa-token:${client.clientId}:${grantType}:${ip}`;
    const allowed = await checkRateLimit(rateKey, { maxRequests: 60, windowMs: 60_000 });
    if (!allowed) {
      return oauthError('slow_down', 'Too many token requests. Please wait a moment.', 429);
    }

    if (grantType === 'authorization_code') {
      const code = body.code;
      const redirectUri = body.redirect_uri;

      if (!code || !redirectUri) {
        return oauthError('invalid_request', 'Missing code or redirect_uri');
      }

      try {
        validateAlexaClientRequest(client.clientId, redirectUri);
      } catch (err) {
        if (err instanceof AlexaOAuthError) {
          return oauthError(err.code, err.message, err.status);
        }
        throw err;
      }

      const user = await consumeAlexaAuthorizationCode(code, client.clientId, redirectUri);
      const accessToken = createToken(user);
      const refreshToken = await issueAlexaRefreshToken(user.id, client.clientId);

      return NextResponse.json({
        token_type: 'Bearer',
        access_token: accessToken,
        expires_in: accessTokenTtl,
        refresh_token: refreshToken,
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = body.refresh_token;
      if (!refreshToken) {
        return oauthError('invalid_request', 'Missing refresh_token');
      }

      const { user, refreshToken: newRefreshToken } = await rotateAlexaRefreshToken(
        refreshToken,
        client.clientId
      );
      const accessToken = createToken(user);

      return NextResponse.json({
        token_type: 'Bearer',
        access_token: accessToken,
        expires_in: accessTokenTtl,
        refresh_token: newRefreshToken,
      });
    }

    return oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  } catch (err) {
    logServerError('[api/alexa/oauth/token] error', err, { ip: getClientIp(req) });
    if (err instanceof AlexaOAuthError) {
      return oauthError(err.code, err.message, err.status);
    }
    return oauthError('server_error', 'Internal server error', 500);
  }
}
