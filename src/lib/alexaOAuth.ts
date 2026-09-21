// Architecture: Shared platform helper src/lib/alexaOAuth.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import crypto, { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import type { AuthUser } from '@/lib/auth';
import { Role } from '@prisma/client';
import { isAlexaEligibleRole } from './alexaScope';

const ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const REFRESH_TOKEN_ACTIVE_CAP = 5;
const REVOKED_REFRESH_TOKEN_RETENTION_DAYS = 30;

type AlexaOAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowedRedirectUris: string[];
  accessTokenTtlSeconds: number;
};

export class AlexaOAuthError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'server_error',
    message: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = 'AlexaOAuthError';
  }
}

function parseAllowedRedirectUris(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

let cachedConfig: AlexaOAuthConfig | null = null;

function loadConfig(): AlexaOAuthConfig {
  if (cachedConfig) return cachedConfig;

  const clientId = process.env.ALEXA_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.ALEXA_CLIENT_SECRET?.trim() ?? '';
  const allowedRedirectUris = parseAllowedRedirectUris(process.env.ALEXA_ALLOWED_REDIRECT_URIS);
  const ttlRaw = process.env.ALEXA_ACCESS_TOKEN_TTL_SECONDS;
  const ttlParsed = ttlRaw ? Number.parseInt(ttlRaw, 10) : ACCESS_TOKEN_DEFAULT_TTL_SECONDS;
  const accessTokenTtlSeconds = Number.isFinite(ttlParsed) && ttlParsed > 0 ? ttlParsed : ACCESS_TOKEN_DEFAULT_TTL_SECONDS;

  cachedConfig = {
    clientId,
    clientSecret,
    allowedRedirectUris,
    accessTokenTtlSeconds,
  };

  return cachedConfig;
}

function ensureConfig(): AlexaOAuthConfig {
  const config = loadConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new AlexaOAuthError('invalid_request', 'Alexa OAuth is not configured', 500);
  }
  return config;
}

export function validateAlexaClientRequest(clientId: string, redirectUri: string) {
  const config = ensureConfig();
  if (!clientId) {
    throw new AlexaOAuthError('invalid_request', 'Missing client_id');
  }
  if (clientId !== config.clientId) {
    throw new AlexaOAuthError('invalid_client', 'Unknown client');
  }
  if (!redirectUri) {
    throw new AlexaOAuthError('invalid_request', 'Missing redirect_uri');
  }
  if (
    config.allowedRedirectUris.length > 0 &&
    !config.allowedRedirectUris.includes(redirectUri)
  ) {
    throw new AlexaOAuthError('invalid_request', 'redirect_uri is not allowed');
  }
}

export function validateAlexaClientSecret(clientId: string, clientSecret: string) {
  const config = ensureConfig();
  if (!clientSecret) {
    throw new AlexaOAuthError('invalid_client', 'Missing client secret');
  }
  if (clientId !== config.clientId || clientSecret !== config.clientSecret) {
    throw new AlexaOAuthError('invalid_client', 'Invalid client credentials');
  }
}

export function getAlexaAccessTokenTtlSeconds() {
  return ensureConfig().accessTokenTtlSeconds;
}

function toAuthUser(user: { id: number; username: string; role: Role }): AuthUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueAlexaAuthorizationCode(
  userId: number,
  clientId: string,
  redirectUri: string,
  ttlSeconds = 5 * 60
): Promise<string> {
  const code = generateRandomToken(32);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await prisma.alexaAuthCode.create({
    data: {
      code,
      userId,
      clientId,
      redirectUri,
      expiresAt,
    },
  });

  return code;
}

export async function consumeAlexaAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string
): Promise<AuthUser> {
  const record = await prisma.alexaAuthCode.findUnique({
    where: { code },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          role: true,
          alexaSkillUserLinks: {
            select: { disabledAt: true, disabledReason: true },
            orderBy: { linkedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  if (!record) {
    throw new AlexaOAuthError('invalid_grant', 'Authorization code not found');
  }

  if (record.clientId !== clientId) {
    throw new AlexaOAuthError('invalid_grant', 'Authorization code does not match client');
  }

  if (record.redirectUri !== redirectUri) {
    throw new AlexaOAuthError('invalid_grant', 'redirect_uri mismatch');
  }

  if (record.used) {
    throw new AlexaOAuthError('invalid_grant', 'Authorization code already used');
  }

  if (record.expiresAt < new Date()) {
    throw new AlexaOAuthError('invalid_grant', 'Authorization code expired');
  }

  if (!isAlexaEligibleRole(record.user.role)) {
    throw new AlexaOAuthError('invalid_grant', 'Account is not eligible for Alexa linking');
  }

  await prisma.alexaAuthCode.update({
    where: { id: record.id },
    data: { used: true },
  });

  return toAuthUser(record.user);
}

async function persistAlexaRefreshToken(userId: number, clientId: string): Promise<{ token: string; hash: string }> {
  const token = generateRandomToken(48);
  const tokenHash = hashToken(token);

  await prisma.alexaRefreshToken.create({
    data: {
      tokenHash,
      userId,
      clientId,
      lastUsedAt: new Date(),
    },
  });

  return { token, hash: tokenHash };
}

export async function issueAlexaRefreshToken(userId: number, clientId: string): Promise<string> {
  const { token } = await persistAlexaRefreshToken(userId, clientId);
  return token;
}

export async function rotateAlexaRefreshToken(refreshToken: string, clientId: string) {
  if (!refreshToken) {
    throw new AlexaOAuthError('invalid_request', 'Missing refresh_token');
  }

  const tokenHash = hashToken(refreshToken);
  const existing = await prisma.alexaRefreshToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          role: true,
          alexaSkillUserLinks: {
            select: { disabledAt: true, disabledReason: true },
            orderBy: { linkedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  if (!existing) {
    throw new AlexaOAuthError('invalid_grant', 'Refresh token not found');
  }

  if (existing.clientId !== clientId) {
    throw new AlexaOAuthError('invalid_grant', 'Refresh token does not match client');
  }

  if (existing.revoked) {
    throw new AlexaOAuthError('invalid_grant', 'Refresh token revoked');
  }

  if (!isAlexaEligibleRole(existing.user.role)) {
    throw new AlexaOAuthError('invalid_grant', 'Account is not eligible for Alexa linking');
  }

  const latestSkillLink = existing.user.alexaSkillUserLinks[0];
  const disabledReason = latestSkillLink?.disabledReason ?? '';
  if (
    latestSkillLink?.disabledAt &&
    (disabledReason === 'SKILL_DISABLED' || disabledReason === 'SKILL_ACCOUNT_UNLINKED')
  ) {
    throw new AlexaOAuthError('invalid_grant', 'Alexa link is no longer active');
  }

  const now = new Date();

  // Mark the presented token as recently used.
  await prisma.alexaRefreshToken.update({
    where: { id: existing.id },
    data: { lastUsedAt: now },
  });

  const newToken = await issueAlexaRefreshToken(existing.userId, clientId);

  // Best-effort housekeeping (never forces relink for valid active tokens).
  try {
    const cutoff = new Date(Date.now() - REVOKED_REFRESH_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await prisma.alexaRefreshToken.deleteMany({
      where: {
        revoked: true,
        revokedAt: { lt: cutoff },
      },
    });
  } catch {
    // Ignore cleanup failures; do not block token refresh.
  }

  // Enforce active token cap based on recency of use (keeps recently-used tokens valid).
  try {
    const active = await prisma.alexaRefreshToken.findMany({
      where: { userId: existing.userId, clientId, revoked: false },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true },
    });
    if (active.length > REFRESH_TOKEN_ACTIVE_CAP) {
      const revokeIds = active.slice(REFRESH_TOKEN_ACTIVE_CAP).map((t) => t.id);
      await prisma.alexaRefreshToken.updateMany({
        where: { id: { in: revokeIds } },
        data: { revoked: true, revokedAt: now },
      });
    }
  } catch {
    // Ignore cap failures; do not block token refresh.
  }

  return {
    user: toAuthUser(existing.user),
    refreshToken: newToken,
  };
}

export function buildOAuthRedirectUri(redirectUri: string, code: string, state?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}
