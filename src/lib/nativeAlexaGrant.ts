import { prisma } from '@/lib/prisma';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { encryptPlatformEnvelope } from '@/lib/hubOperatorCredentials';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { sha256 } from '@/lib/stage1Crypto';

const LWA_TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024;
const GRANT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

type LinkAuthority = { accountId: string; linkId: string; accessExpiresAt: Date };

function lwaCredentials() {
  const clientId = String(process.env.DINODIA_ALEXA_LWA_CLIENT_ID ?? '').trim();
  const clientSecret = String(process.env.DINODIA_ALEXA_LWA_CLIENT_SECRET ?? '');
  if (!clientId || clientId.length > 512 || clientSecret.length < 16 || clientSecret.length > 2048) return null;
  let endpoint = LWA_TOKEN_ENDPOINT;
  const testEndpoint = String(process.env.DINODIA_ALEXA_LWA_LOOPBACK_TEST_ENDPOINT ?? '');
  if (process.env.V2_ENVIRONMENT === 'test' && testEndpoint) {
    try {
      const url = new URL(testEndpoint);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1'].includes(url.hostname) || !url.port
        || url.username || url.password || url.search || url.hash || url.pathname !== '/oauth/token') return null;
      endpoint = url.toString();
    } catch { return null; }
  }
  return { clientId, clientSecret, endpoint };
}

function accessTokenFrom(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (dno-alexa-access-[A-Za-z0-9_-]{40,128})$/.exec(header);
  if (!match) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
  return match[1];
}

async function lockAndValidateLinkAuthority(tokenHash: string): Promise<LinkAuthority> {
  const hint = await prisma.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: {
    familyId: true, family: { select: { linkId: true, link: { select: { customerAccountId: true } } } },
  } });
  if (!hint) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
  return serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${hint.family.link.customerAccountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${hint.family.linkId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthTokenFamily" WHERE "linkId" = ${hint.family.linkId}::uuid ORDER BY "id" FOR UPDATE`;
    const token = await tx.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: {
      expiresAt: true, revokedAt: true, family: { select: {
        linkId: true, absoluteExpiresAt: true, inactivityExpiresAt: true, revokedAt: true,
        link: { select: { id: true, customerAccountId: true, status: true, revokedAt: true,
          customerAccount: { select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true } } },
        },
      } },
    } });
    const now = new Date();
    const policy = currentCustomerPolicy();
    const accepted = policy ? await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
      customerAccountId: hint.family.link.customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
    } }, select: { id: true } }) : null;
    if (!token || token.revokedAt || token.expiresAt <= now || token.family.revokedAt
      || token.family.absoluteExpiresAt <= now || token.family.inactivityExpiresAt <= now
      || token.family.linkId !== hint.family.linkId || token.family.link.status !== 'ACTIVE' || token.family.link.revokedAt
      || token.family.link.customerAccount.id !== token.family.link.customerAccountId
      || token.family.link.customerAccount.status !== 'ACTIVE' || !token.family.link.customerAccount.emailVerifiedAt
      || token.family.link.customerAccount.mustChangePassword || token.family.link.customerAccount.usernameSelectionRequired
      || !policy || !accepted) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
    return { accountId: token.family.link.customerAccountId, linkId: token.family.linkId, accessExpiresAt: token.expiresAt };
  }, 3, { timeoutMs: 6000 });
}

async function exchangeGrantCode(code: string) {
  const credentials = lwaCredentials();
  if (!credentials) throw new Stage1AuthError(503, 'alexa_event_gateway_unconfigured', 'Alexa event-gateway credentials are not configured');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: credentials.clientId, client_secret: credentials.clientSecret });
  const response = await fetch(credentials.endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(8000), redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw new Stage1AuthError(503, 'alexa_event_gateway_unavailable', 'Alexa could not complete the event-gateway authorization');
  const reader = response.body?.getReader();
  if (!reader) throw new Stage1AuthError(503, 'alexa_event_gateway_unavailable', 'Alexa could not complete the event-gateway authorization');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Stage1AuthError(503, 'alexa_event_gateway_response_invalid', 'Alexa returned an invalid event-gateway response');
    }
    chunks.push(value);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = null; }
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const expiresIn = Number(result?.expires_in);
  if (!response.ok || !result || typeof result.access_token !== 'string' || result.access_token.length < 16 || result.access_token.length > 8192
    || typeof result.refresh_token !== 'string' || result.refresh_token.length < 16 || result.refresh_token.length > 8192
    || result.token_type !== 'bearer' && result.token_type !== 'Bearer'
    || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 24 * 60 * 60) {
    throw new Stage1AuthError(503, 'alexa_event_gateway_exchange_failed', 'Alexa could not complete the event-gateway authorization');
  }
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresIn };
}

/** Refreshes only the stored Alexa Event Gateway grant; tokens never enter a response or log. */
export async function refreshNativeAlexaEventToken(refreshToken: string) {
  const credentials = lwaCredentials();
  if (!credentials || typeof refreshToken !== 'string' || refreshToken.length < 16 || refreshToken.length > 8192) {
    throw new Stage1AuthError(503, 'alexa_event_gateway_unconfigured', 'Alexa event-gateway credentials are not configured');
  }
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: credentials.clientId, client_secret: credentials.clientSecret });
  const response = await fetch(credentials.endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body, signal: AbortSignal.timeout(8000), redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw new Stage1AuthError(503, 'alexa_event_gateway_unavailable', 'Alexa could not refresh its event-gateway authorization');
  const reader = response.body?.getReader();
  if (!reader) throw new Stage1AuthError(503, 'alexa_event_gateway_unavailable', 'Alexa could not refresh its event-gateway authorization');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Stage1AuthError(503, 'alexa_event_gateway_response_invalid', 'Alexa returned an invalid event-gateway response');
    }
    chunks.push(value);
  }
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { decoded = null; }
  const result = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null;
  const expiresIn = Number(result?.expires_in);
  if (!response.ok || !result || typeof result.access_token !== 'string' || result.access_token.length < 16 || result.access_token.length > 8192
    || result.token_type !== 'bearer' && result.token_type !== 'Bearer'
    || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 24 * 60 * 60
    || result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || result.refresh_token.length < 16 || result.refresh_token.length > 8192)) {
    throw new Stage1AuthError(503, 'alexa_event_gateway_refresh_failed', 'Alexa could not refresh its event-gateway authorization');
  }
  return { accessToken: result.access_token, refreshToken: typeof result.refresh_token === 'string' ? result.refresh_token : refreshToken, expiresIn };
}

export async function acceptNativeAlexaGrant(request: Request, input: { messageId: string; grantCode: string }) {
  if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') throw new Stage1AuthError(503, 'alexa_not_activated', 'Native Alexa linking is not yet activated');
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(input.messageId) || typeof input.grantCode !== 'string' || input.grantCode.length < 1 || input.grantCode.length > 4096) {
    throw new Stage1AuthError(400, 'alexa_grant_invalid', 'The Alexa permission request is invalid');
  }
  const accessToken = accessTokenFrom(request);
  const tokenHash = sha256(accessToken);
  const authority = await lockAndValidateLinkAuthority(tokenHash);
  const requestId = `alexa-grant:${sha256(`${authority.linkId}\n${input.messageId}`)}`;
  const digest = sha256(`${input.messageId}\n${sha256(input.grantCode)}`);
  const reserved = await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${authority.accountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${authority.linkId}::uuid FOR UPDATE`;
    const existing = await tx.alexaNativeDirectiveReceipt.findUnique({ where: { requestId }, select: { id: true, linkId: true, requestDigest: true, responseStatus: true, expiresAt: true } });
    if (existing) {
      if (existing.linkId !== authority.linkId || existing.requestDigest !== digest || existing.expiresAt <= new Date()) {
        throw new Stage1AuthError(409, 'alexa_grant_replay_conflict', 'The Alexa permission request identifier was already used');
      }
      return { existing: true, completed: existing.responseStatus === 200, id: existing.id };
    }
    const link = await tx.alexaNativeLink.findUnique({ where: { id: authority.linkId }, select: { customerAccountId: true, status: true, revokedAt: true } });
    if (!link || link.customerAccountId !== authority.accountId || link.status !== 'ACTIVE' || link.revokedAt) {
      throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'The Alexa link is no longer active');
    }
    const row = await tx.alexaNativeDirectiveReceipt.create({ data: {
      linkId: authority.linkId, requestId, requestDigest: digest, eventTokenHash: tokenHash,
      responseStatus: 202, expiresAt: new Date(Date.now() + GRANT_RECEIPT_TTL_MS),
    }, select: { id: true } });
    return { existing: false, completed: false, id: row.id };
  }, 3, { timeoutMs: 5000 });
  if (reserved.completed) return { accepted: true };
  if (reserved.existing) throw new Stage1AuthError(409, 'alexa_grant_outcome_uncertain', 'The Alexa permission exchange is still being reconciled; relink if Alexa reports a failure');

  let grant: Awaited<ReturnType<typeof exchangeGrantCode>>;
  try { grant = await exchangeGrantCode(input.grantCode); }
  catch (error) {
    await prisma.alexaNativeDirectiveReceipt.update({ where: { id: reserved.id }, data: { responseStatus: 503, responseDigest: sha256('grant-exchange-failed') } }).catch(() => {});
    throw error;
  }
  try {
    await serializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${authority.accountId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${authority.linkId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthTokenFamily" WHERE "linkId" = ${authority.linkId}::uuid ORDER BY "id" FOR UPDATE`;
      const token = await tx.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: {
        expiresAt: true, revokedAt: true, family: { select: { linkId: true, absoluteExpiresAt: true, inactivityExpiresAt: true, revokedAt: true,
          link: { select: { id: true, customerAccountId: true, status: true, revokedAt: true, revision: true, customerAccount: { select: { status: true, emailVerifiedAt: true } } } },
        } },
      } });
      const now = new Date();
      const link = await tx.alexaNativeLink.findUnique({ where: { id: authority.linkId }, select: { id: true, customerAccountId: true, status: true, revokedAt: true } });
      if (!token || token.revokedAt || token.expiresAt <= now || token.family.revokedAt || token.family.absoluteExpiresAt <= now
        || token.family.inactivityExpiresAt <= now || token.family.linkId !== authority.linkId
        || token.family.link.id !== authority.linkId || token.family.link.customerAccountId !== authority.accountId
        || token.family.link.status !== 'ACTIVE' || token.family.link.revokedAt
        || token.family.link.customerAccount.status !== 'ACTIVE' || !token.family.link.customerAccount.emailVerifiedAt
        || !link || link.customerAccountId !== authority.accountId || link.status !== 'ACTIVE' || link.revokedAt) {
        throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'The Alexa link changed during event-gateway authorization');
      }
      const nextRevision = link ? (await tx.alexaNativeLink.findUniqueOrThrow({ where: { id: authority.linkId }, select: { revision: true } })).revision + 1 : 1;
      const expiresAt = new Date(now.getTime() + grant.expiresIn * 1000);
      await tx.alexaNativeLink.update({ where: { id: authority.linkId }, data: {
        accessTokenCiphertext: JSON.stringify(encryptPlatformEnvelope(grant.accessToken)),
        refreshTokenCiphertext: JSON.stringify(encryptPlatformEnvelope(grant.refreshToken)),
        encryptionKeyVersion: 1, accessTokenExpiresAt: expiresAt, revision: nextRevision, updatedAt: now,
      } });
      await tx.alexaNativeDirectiveReceipt.update({ where: { id: reserved.id }, data: {
        responseStatus: 200, responseDigest: sha256(`${authority.linkId}\n${nextRevision}\n${expiresAt.toISOString()}`),
      } });
    }, 3, { timeoutMs: 7000 });
  } catch (error) {
    await prisma.alexaNativeDirectiveReceipt.update({ where: { id: reserved.id }, data: { responseStatus: 401, responseDigest: sha256('authority-changed-after-grant') } }).catch(() => {});
    throw error;
  }
  return { accepted: true };
}
