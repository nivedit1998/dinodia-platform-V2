// Architecture: API boundary /alexa/oauth/revoke; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { AlexaOAuthError, validateAlexaClientSecret } from '@/lib/alexaOAuth';

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

function extractClientCredentials(req: NextRequest, body: Record<string, string>): ParsedClientCredentials {
  const basic = parseBasicAuth(req.headers.get('authorization'));
  if (basic) return basic;

  const clientId = body.client_id;
  const clientSecret = body.client_secret;
  if (!clientId || !clientSecret) {
    throw new AlexaOAuthError('invalid_client', 'Missing client credentials', 401);
  }
  return { clientId, clientSecret };
}

function oauthError(error: string, errorDescription: string, status = 400) {
  return NextResponse.json({ error, error_description: errorDescription }, { status });
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await parseBody(req);
  } catch {
    return oauthError('invalid_request', 'Unable to parse request body');
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

  const tokenRaw = body.token || body.refresh_token || '';
  const token = tokenRaw.trim();
  if (!token) {
    return oauthError('invalid_request', 'Missing token');
  }

  const tokenHash = hashToken(token);
  const existing = await prisma.alexaRefreshToken.findUnique({
    where: { tokenHash },
    select: { userId: true, clientId: true },
  });

  // Per RFC 7009, revocation is successful even if the token is unknown.
  if (!existing || existing.clientId !== client.clientId) {
    return NextResponse.json({ ok: true });
  }

  await prisma.$transaction(async (tx) => {
    await tx.alexaRefreshToken.updateMany({
      where: { userId: existing.userId, clientId: client.clientId, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
    await tx.alexaEventToken.deleteMany({ where: { userId: existing.userId } });
  });

  return NextResponse.json({ ok: true });
}
