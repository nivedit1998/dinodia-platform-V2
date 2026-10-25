import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { serializableTransaction } from '@/lib/serializableTransaction';
import {
  ALEXA_OAUTH_ABSOLUTE_MS, ALEXA_OAUTH_ACCESS_SECONDS,
  ALEXA_OAUTH_INACTIVITY_MS, alexaOAuthClientAuthenticated, alexaOAuthConfig, alexaOAuthJsonError,
  applyAlexaIntentScope, isAlexaOAuthEnabled, lockAndValidateAlexaConnectIntent,
  makeAlexaOpaqueToken, pkceChallenge, providerSubjectHash,
} from '@/lib/nativeAlexaOAuth';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

type IssuedTokens = { accessToken: string; refreshToken: string; expiresIn: number };
type ExchangeResult = { tokens: IssuedTokens } | { error: 'invalid_grant' };

function formFields(raw: string): URLSearchParams | null {
  if (Buffer.byteLength(raw, 'utf8') > 8192) return null;
  const values = new URLSearchParams(raw);
  if ([...values.keys()].some((key) => !['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier', 'refresh_token'].includes(key))) return null;
  if ([...new Set(values.keys())].some((key) => values.getAll(key).length !== 1)) return null;
  return values;
}

function reply(tokens: IssuedTokens) {
  return NextResponse.json({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: 'alexa::skills:account_linking',
  }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}

async function issueTokens(tx: Parameters<Parameters<typeof serializableTransaction>[0]>[0], linkId: string, now: Date): Promise<IssuedTokens> {
  const absoluteExpiresAt = new Date(now.getTime() + ALEXA_OAUTH_ABSOLUTE_MS);
  const inactivityExpiresAt = new Date(Math.min(now.getTime() + ALEXA_OAUTH_INACTIVITY_MS, absoluteExpiresAt.getTime()));
  const family = await tx.alexaOAuthTokenFamily.create({ data: { linkId, absoluteExpiresAt, inactivityExpiresAt, lastUsedAt: now }, select: { id: true } });
  const accessToken = makeAlexaOpaqueToken('access');
  const refreshToken = makeAlexaOpaqueToken('refresh');
  const accessExpiresAt = new Date(Math.min(now.getTime() + ALEXA_OAUTH_ACCESS_SECONDS * 1000, inactivityExpiresAt.getTime(), absoluteExpiresAt.getTime()));
  await tx.alexaOAuthAccessToken.create({ data: { familyId: family.id, tokenHash: sha256(accessToken), expiresAt: accessExpiresAt } });
  await tx.alexaOAuthRefreshToken.create({ data: { familyId: family.id, tokenHash: sha256(refreshToken), expiresAt: inactivityExpiresAt } });
  return { accessToken, refreshToken, expiresIn: Math.max(1, Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1000)) };
}

async function exchangeAuthorizationCode(input: { code: string; clientId: string; redirectUri: string; verifier: string }): Promise<ExchangeResult> {
  const codeHash = sha256(input.code);
  const hint = await prisma.alexaOAuthAuthorizationCode.findUnique({ where: { codeHash }, select: {
    id: true, customerAccountId: true, intents: { select: { intentId: true } },
  } });
  if (!hint || hint.intents.length !== 1) return { error: 'invalid_grant' };
  return serializableTransaction(async (tx) => {
    const currentIntent = await lockAndValidateAlexaConnectIntent(tx, hint.intents[0].intentId, 'consumed');
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthAuthorizationCode" WHERE "id" = ${hint.id}::uuid FOR UPDATE`;
    const code = await tx.alexaOAuthAuthorizationCode.findUnique({ where: { id: hint.id }, select: {
      id: true, customerAccountId: true, clientId: true, redirectUri: true, codeChallenge: true,
      codeChallengeMethod: true, expiresAt: true, consumedAt: true,
      intents: { select: { intentId: true } },
    } });
    const now = new Date();
    if (!code || code.consumedAt || code.expiresAt <= now || code.customerAccountId !== currentIntent.intent.customerAccountId
      || code.clientId !== input.clientId || code.redirectUri !== input.redirectUri || code.codeChallengeMethod !== 'S256'
      || code.codeChallenge !== pkceChallenge(input.verifier) || code.intents.length !== 1 || code.intents[0].intentId !== currentIntent.intent.id) {
      return { error: 'invalid_grant' as const };
    }

    const subjectHash = providerSubjectHash(input.clientId, code.customerAccountId);
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "providerSubjectHash" = ${subjectHash} FOR UPDATE`;
    let link = await tx.alexaNativeLink.findUnique({ where: { providerSubjectHash: subjectHash }, select: {
      id: true, customerAccountId: true, status: true, revokedAt: true,
    } });
    if (link && link.customerAccountId !== code.customerAccountId) return { error: 'invalid_grant' as const };
    if (link && (link.status !== 'ACTIVE' || link.revokedAt)) {
      await tx.alexaNativeLink.delete({ where: { id: link.id } });
      link = null;
    }
    if (!link) {
      link = await tx.alexaNativeLink.create({ data: {
        customerAccountId: code.customerAccountId,
        providerSubjectHash: subjectHash,
        encryptionKeyVersion: 1,
        status: 'ACTIVE',
        revision: 1,
      }, select: { id: true, customerAccountId: true, status: true, revokedAt: true } });
    }
    await applyAlexaIntentScope(tx, { linkId: link.id, intentId: currentIntent.intent.id,
      membershipId: currentIntent.intent.membershipId, homeId: currentIntent.intent.homeId,
      selectedAreaIds: currentIntent.selectedAreas, now });
    const consumed = await tx.alexaOAuthAuthorizationCode.updateMany({
      where: { id: code.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now },
    });
    if (consumed.count !== 1) return { error: 'invalid_grant' as const };
    const tokens = await issueTokens(tx, link.id, now);
    return { tokens };
  }, 2);
}

async function refreshTokens(input: { refreshToken: string; clientId: string }): Promise<ExchangeResult> {
  const tokenHash = sha256(input.refreshToken);
  const hint = await prisma.alexaOAuthRefreshToken.findUnique({ where: { tokenHash }, select: {
    id: true, familyId: true, family: { select: { linkId: true, link: { select: { customerAccountId: true } } } },
  } });
  if (!hint) return { error: 'invalid_grant' };
  return serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${hint.family.link.customerAccountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${hint.family.linkId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthTokenFamily" WHERE "id" = ${hint.familyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthRefreshToken" WHERE "id" = ${hint.id}::uuid FOR UPDATE`;
    const credential = await tx.alexaOAuthRefreshToken.findUnique({ where: { id: hint.id }, select: {
      id: true, familyId: true, tokenHash: true, expiresAt: true, usedAt: true, revokedAt: true,
      family: { select: {
        id: true, linkId: true, absoluteExpiresAt: true, inactivityExpiresAt: true, revokedAt: true,
        link: { select: {
          id: true, customerAccountId: true, status: true, revokedAt: true,
          customerAccount: { select: { status: true, emailVerifiedAt: true } },
        } },
      } },
    } });
    const now = new Date();
    if (!credential || credential.tokenHash !== tokenHash || credential.family.linkId !== hint.family.linkId) return { error: 'invalid_grant' as const };
    if (credential.usedAt) {
      await tx.alexaOAuthTokenFamily.updateMany({ where: { id: credential.familyId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'refresh_token_reuse' } });
      return { error: 'invalid_grant' as const };
    }
    if (credential.revokedAt || credential.expiresAt <= now || credential.family.revokedAt
      || credential.family.absoluteExpiresAt <= now || credential.family.inactivityExpiresAt <= now
      || credential.family.link.status !== 'ACTIVE' || credential.family.link.revokedAt
      || credential.family.link.customerAccount.status !== 'ACTIVE' || !credential.family.link.customerAccount.emailVerifiedAt) {
      return { error: 'invalid_grant' as const };
    }
    const used = await tx.alexaOAuthRefreshToken.updateMany({ where: { id: credential.id, tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (used.count !== 1) return { error: 'invalid_grant' as const };
    const newInactivityExpiry = new Date(Math.min(now.getTime() + ALEXA_OAUTH_INACTIVITY_MS, credential.family.absoluteExpiresAt.getTime()));
    await tx.alexaOAuthTokenFamily.update({ where: { id: credential.family.id }, data: { lastUsedAt: now, inactivityExpiresAt: newInactivityExpiry } });
    const accessToken = makeAlexaOpaqueToken('access');
    const refreshToken = makeAlexaOpaqueToken('refresh');
    const accessExpiresAt = new Date(Math.min(now.getTime() + ALEXA_OAUTH_ACCESS_SECONDS * 1000, newInactivityExpiry.getTime(), credential.family.absoluteExpiresAt.getTime()));
    await tx.alexaOAuthAccessToken.create({ data: { familyId: credential.family.id, tokenHash: sha256(accessToken), expiresAt: accessExpiresAt } });
    await tx.alexaOAuthRefreshToken.create({ data: { familyId: credential.family.id, tokenHash: sha256(refreshToken), expiresAt: newInactivityExpiry } });
    return { tokens: { accessToken, refreshToken, expiresIn: Math.max(1, Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1000)) } };
  }, 2);
}

export async function POST(request: Request) {
  const config = alexaOAuthConfig();
  if (!config) return alexaOAuthJsonError('temporarily_unavailable', 503);
  if (!isAlexaOAuthEnabled()) return alexaOAuthJsonError('temporarily_unavailable', 503);
  if (!String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return alexaOAuthJsonError('invalid_request', 400);
  const values = formFields(await request.text());
  if (!values) return alexaOAuthJsonError('invalid_request', 400);
  if (!alexaOAuthClientAuthenticated(request, values, config)) return alexaOAuthJsonError('invalid_client', 401);
  const grantType = values.get('grant_type') ?? '';
  try {
    let result: ExchangeResult;
    if (grantType === 'authorization_code') {
      if ([...values.keys()].some((key) => !['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier'].includes(key))
        || [...['code', 'redirect_uri', 'code_verifier']].some((key) => values.getAll(key).length !== 1)) return alexaOAuthJsonError('invalid_request', 400);
      const code = values.get('code') ?? '';
      const redirectUri = values.get('redirect_uri') ?? '';
      const verifier = values.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9_-]{40,128}$/.test(code) || !config.redirectUris.has(redirectUri)
        || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return alexaOAuthJsonError('invalid_grant', 400);
      result = await exchangeAuthorizationCode({ code, clientId: config.clientId, redirectUri, verifier });
    } else if (grantType === 'refresh_token') {
      if ([...values.keys()].some((key) => !['grant_type', 'client_id', 'refresh_token'].includes(key)) || values.getAll('refresh_token').length !== 1) return alexaOAuthJsonError('invalid_request', 400);
      const refreshToken = values.get('refresh_token') ?? '';
      if (!/^dno-alexa-refresh-[A-Za-z0-9_-]{40,128}$/.test(refreshToken)) return alexaOAuthJsonError('invalid_grant', 400);
      result = await refreshTokens({ refreshToken, clientId: config.clientId });
    } else {
      return alexaOAuthJsonError('unsupported_grant_type', 400);
    }
    return 'tokens' in result ? reply(result.tokens) : alexaOAuthJsonError('invalid_grant', 400);
  } catch {
    return alexaOAuthJsonError('server_error', 500);
  }
}
