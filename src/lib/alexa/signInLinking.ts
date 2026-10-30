import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { verifyPassword } from '@/lib/passwords';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { recordFailedAuthentication, Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { decryptPlatformEnvelope } from '@/lib/hubOperatorCredentials';
import { readApnsConfig, sendAlexaLinkApprovalPush, type ApnsEnvironment } from '@/lib/apnsDelivery';
import type { AlexaOAuthRequest } from '@/lib/nativeAlexaOAuth';

/**
 * Account linking started from the Alexa side. The person signs in on the Alexa-hosted page with their Dinodia email and
 * password, then must approve on a phone that is already signed in to the same Dinodia account by choosing the number the
 * Alexa page shows ("number matching"). The password alone never links an account. The link that results is tenant-only and
 * follows the tenant's real room access automatically (see syncAlexa.ts).
 */
export const ALEXA_SIGN_IN_TTL_MS = 5 * 60 * 1000;
const PUSH_BUDGET_MS = 4000;

export type AlexaSignInFailure = 'INVALID' | 'SETUP_REQUIRED' | 'NOT_TENANT' | 'NO_PHONE' | 'RATE_LIMITED' | 'UNAVAILABLE';
export type AlexaSignInStart = { ok: true; rawIntent: string; approvalNumber: number } | { ok: false; reason: AlexaSignInFailure };
export type AlexaSignInStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'EXPIRED';

export function alexaRequestHash(request: AlexaOAuthRequest): string {
  return sha256(JSON.stringify([request.clientId, request.redirectUri, request.state, request.codeChallenge, request.codeChallengeMethod]));
}

/** Amazon's certification reviewers cannot hold a phone for a sandbox tenant; this list is empty unless explicitly configured. */
function reviewAccountEmails(): Set<string> {
  return new Set(String(process.env.DINODIA_ALEXA_REVIEW_ACCOUNT_EMAILS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
}

/** Tenant memberships that can actually be exposed: an active Home with a completed installation and an active hub. */
export async function eligibleAlexaTenantMemberships(tx: Pick<Prisma.TransactionClient, 'homeMembership'>, customerAccountId: string) {
  return tx.homeMembership.findMany({ where: {
    customerAccountId, role: 'TENANT', status: 'ACTIVE',
    home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: { not: null } },
  }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, homeId: true } });
}

async function pushApprovalPrompt(customerAccountId: string, intentId: string, expiresAt: Date): Promise<void> {
  const config = readApnsConfig();
  if (!config) return;
  const devices = await prisma.trustedDevice.findMany({ where: {
    customerAccountId, revokedAt: null, pushRevokedAt: null, apnsTokenCiphertext: { not: null }, apnsEnvironment: { not: null },
  }, take: 6, orderBy: { lastUsedAt: 'desc' }, select: { apnsTokenCiphertext: true, apnsEnvironment: true } });
  await Promise.race([
    Promise.allSettled(devices.map(async (device) => {
      const deviceToken = decryptPlatformEnvelope(device.apnsTokenCiphertext as string);
      await sendAlexaLinkApprovalPush({ config, environment: device.apnsEnvironment as ApnsEnvironment, deviceToken, requestId: intentId, expiresAt });
    })),
    new Promise((resolve) => setTimeout(resolve, PUSH_BUDGET_MS)),
  ]);
}

export async function startAlexaSignIn(input: { email: unknown; password: unknown; request: AlexaOAuthRequest }): Promise<AlexaSignInStart> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!email || email.length > 320 || !password || password.length > 1024) return { ok: false, reason: 'INVALID' };
  try {
    await enforcePersistentRateLimit(`alexa-signin:${sha256(email)}`, 8, 15 * 60 * 1000);
  } catch (error) {
    if (error instanceof Stage1AuthError && error.status === 429) return { ok: false, reason: 'RATE_LIMITED' };
    return { ok: false, reason: 'UNAVAILABLE' };
  }
  const account = await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: {
    id: true, status: true, emailVerifiedAt: true, passwordHash: true, mustChangePassword: true, usernameSelectionRequired: true,
  } });
  // Same single message for an unknown address and a wrong password.
  if (!account || account.status !== 'ACTIVE' || !(await verifyPassword(password, account.passwordHash))) {
    await recordFailedAuthentication('alexa_signin_failed', email);
    return { ok: false, reason: 'INVALID' };
  }
  // Charged only after the password is right, so anonymous junk cannot exhaust it for everyone.
  try { await enforcePersistentRateLimit('alexa-signin:linked', 1200, 60 * 60 * 1000); }
  catch (error) { return { ok: false, reason: error instanceof Stage1AuthError && error.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE' }; }
  const policy = currentCustomerPolicy();
  const accepted = policy ? await prisma.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
    customerAccountId: account.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
  } }, select: { id: true } }) : null;
  if (!account.emailVerifiedAt || account.mustChangePassword || account.usernameSelectionRequired || !policy || !accepted) return { ok: false, reason: 'SETUP_REQUIRED' };

  const instant = reviewAccountEmails().has(email);
  const rawIntent = randomSecret(32);
  const approvalNumber = 10 + crypto.randomInt(90);
  const result = await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${account.id}::uuid FOR UPDATE`;
    const memberships = await eligibleAlexaTenantMemberships(tx, account.id);
    if (memberships.length === 0) return 'NOT_TENANT' as const;
    const phones = await tx.trustedDevice.count({ where: { customerAccountId: account.id, revokedAt: null } });
    if (phones === 0 && !instant) return 'NO_PHONE' as const;
    const now = new Date();
    await tx.alexaNativeConnectIntent.updateMany({ where: { customerAccountId: account.id, kind: 'SIGN_IN', consumedAt: null, revokedAt: null },
      data: { revokedAt: now } });
    const expiresAt = new Date(now.getTime() + ALEXA_SIGN_IN_TTL_MS);
    const row = await tx.alexaNativeConnectIntent.create({ data: {
      customerAccountId: account.id, homeId: memberships[0].homeId, membershipId: memberships[0].id, intentHash: sha256(rawIntent), kind: 'SIGN_IN',
      approvalNumber, approvedAt: instant ? now : null, oauthRequestHash: alexaRequestHash(input.request), expiresAt,
    }, select: { id: true, expiresAt: true } });
    return row;
  }, 2);
  if (result === 'NOT_TENANT' || result === 'NO_PHONE') return { ok: false, reason: result };
  if (!instant) await pushApprovalPrompt(account.id, result.id, result.expiresAt).catch(() => {});
  return { ok: true, rawIntent, approvalNumber };
}

async function findSignInIntent(rawIntent: string, request: AlexaOAuthRequest) {
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(rawIntent)) return null;
  const intent = await prisma.alexaNativeConnectIntent.findUnique({ where: { intentHash: sha256(rawIntent) }, select: {
    id: true, customerAccountId: true, kind: true, approvalNumber: true, approvedAt: true, declinedAt: true, consumedAt: true, revokedAt: true, expiresAt: true, oauthRequestHash: true,
  } });
  if (!intent || intent.kind !== 'SIGN_IN' || intent.oauthRequestHash !== alexaRequestHash(request)) return null;
  return intent;
}

export async function alexaSignInStatus(rawIntent: string, request: AlexaOAuthRequest): Promise<{ status: AlexaSignInStatus; approvalNumber: number | null }> {
  const intent = await findSignInIntent(rawIntent, request);
  if (!intent || intent.consumedAt || intent.revokedAt || intent.expiresAt <= new Date()) return { status: 'EXPIRED', approvalNumber: null };
  if (intent.declinedAt) return { status: 'DECLINED', approvalNumber: null };
  return { status: intent.approvedAt ? 'APPROVED' : 'PENDING', approvalNumber: intent.approvalNumber };
}

/** Turns an approved sign-in into a single-use authorization code. Returns null if anything is no longer valid. */
export async function completeAlexaSignIn(rawIntent: string, request: AlexaOAuthRequest, clientId: string): Promise<string | null> {
  const hint = await findSignInIntent(rawIntent, request);
  if (!hint) return null;
  const rawCode = randomSecret(32);
  try {
    await serializableTransaction(async (tx) => {
      // Same order as starting a sign-in and as the token exchange: account first, then the intent.
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${hint.customerAccountId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeConnectIntent" WHERE "id" = ${hint.id}::uuid FOR UPDATE`;
      const intent = await tx.alexaNativeConnectIntent.findUnique({ where: { id: hint.id }, select: {
        id: true, customerAccountId: true, kind: true, approvedAt: true, declinedAt: true, consumedAt: true, revokedAt: true, expiresAt: true,
      } });
      const now = new Date();
      if (!intent || intent.kind !== 'SIGN_IN' || !intent.approvedAt || intent.declinedAt || intent.consumedAt || intent.revokedAt || intent.expiresAt <= now) {
        throw new Stage1AuthError(400, 'alexa_connect_intent_invalid', 'The Alexa connection request is no longer valid');
      }
      const code = await tx.alexaOAuthAuthorizationCode.create({ data: {
        customerAccountId: intent.customerAccountId, clientId, redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge, codeChallengeMethod: request.codeChallengeMethod,
        codeHash: sha256(rawCode), expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      }, select: { id: true } });
      await tx.alexaOAuthAuthorizationCodeIntent.create({ data: { authorizationCodeId: code.id, intentId: intent.id } });
      await tx.alexaNativeConnectIntent.update({ where: { id: intent.id }, data: { consumedAt: now } });
    }, 2);
  } catch { return null; }
  return rawCode;
}

/** Locked re-validation at token exchange: the account must still be a tenant somewhere and the approval must be intact. */
export async function lockAndValidateAlexaSignInIntent(tx: Prisma.TransactionClient, intentId: string) {
  const hint = await tx.alexaNativeConnectIntent.findUnique({ where: { id: intentId }, select: { customerAccountId: true } });
  if (!hint) throw new Stage1AuthError(400, 'alexa_connect_intent_invalid', 'The Alexa connection request is no longer valid');
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${hint.customerAccountId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AlexaNativeConnectIntent" WHERE "id" = ${intentId}::uuid FOR UPDATE`;
  const intent = await tx.alexaNativeConnectIntent.findUnique({ where: { id: intentId }, select: {
    id: true, customerAccountId: true, kind: true, approvedAt: true, declinedAt: true, consumedAt: true, revokedAt: true,
    customerAccount: { select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true } },
  } });
  const policy = currentCustomerPolicy();
  const accepted = policy ? await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
    customerAccountId: hint.customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
  } }, select: { id: true } }) : null;
  const memberships = await eligibleAlexaTenantMemberships(tx, hint.customerAccountId);
  if (!intent || intent.kind !== 'SIGN_IN' || !intent.approvedAt || intent.declinedAt || !intent.consumedAt || intent.revokedAt
    || intent.customerAccount.status !== 'ACTIVE' || !intent.customerAccount.emailVerifiedAt
    || intent.customerAccount.mustChangePassword || intent.customerAccount.usernameSelectionRequired
    || !accepted || memberships.length === 0) {
    throw new Stage1AuthError(400, 'alexa_connect_intent_invalid', 'The Alexa connection request is no longer valid');
  }
  return { intent, now: new Date() };
}

// ---- Phone side ----

export type AlexaApprovalPrompt = { id: string; createdAt: string; expiresAt: string; choices: number[] };

/** Three numbers (the real one and two decoys) in ascending order, so the order reveals nothing. */
export function alexaApprovalChoices(intentId: string, approvalNumber: number): number[] {
  const choices = new Set<number>([approvalNumber]);
  for (let index = 0; choices.size < 3 && index < 64; index += 1) {
    const value = 10 + (crypto.createHash('sha256').update(`${intentId}:${index}`).digest().readUInt16BE(0) % 90);
    choices.add(value);
  }
  return [...choices].sort((left, right) => left - right);
}

export async function listAlexaApprovalPrompts(customerAccountId: string): Promise<AlexaApprovalPrompt[]> {
  const rows = await prisma.alexaNativeConnectIntent.findMany({ where: {
    customerAccountId, kind: 'SIGN_IN', approvedAt: null, declinedAt: null, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() },
  }, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, createdAt: true, expiresAt: true, approvalNumber: true } });
  return rows.filter((row) => row.approvalNumber !== null).map((row) => ({
    id: row.id, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), choices: alexaApprovalChoices(row.id, row.approvalNumber as number),
  }));
}

/** A wrong number or an explicit decline ends that request, so the number cannot be guessed. */
export async function decideAlexaApproval(tx: Prisma.TransactionClient, input: { customerAccountId: string; intentId: string; decision: { choice: number } | { decline: true } }): Promise<'APPROVED' | 'DECLINED' | 'WRONG_NUMBER' | 'EXPIRED'> {
  await tx.$queryRaw`SELECT "id" FROM "AlexaNativeConnectIntent" WHERE "id" = ${input.intentId}::uuid FOR UPDATE`;
  const intent = await tx.alexaNativeConnectIntent.findFirst({ where: { id: input.intentId, customerAccountId: input.customerAccountId, kind: 'SIGN_IN' }, select: {
    id: true, approvalNumber: true, approvedAt: true, declinedAt: true, consumedAt: true, revokedAt: true, expiresAt: true,
  } });
  const now = new Date();
  if (!intent || intent.approvedAt || intent.declinedAt || intent.consumedAt || intent.revokedAt || intent.expiresAt <= now || intent.approvalNumber === null) return 'EXPIRED';
  if ('decline' in input.decision) {
    await tx.alexaNativeConnectIntent.update({ where: { id: intent.id }, data: { declinedAt: now } });
    return 'DECLINED';
  }
  if (input.decision.choice !== intent.approvalNumber) {
    await tx.alexaNativeConnectIntent.update({ where: { id: intent.id }, data: { declinedAt: now } });
    return 'WRONG_NUMBER';
  }
  await tx.alexaNativeConnectIntent.update({ where: { id: intent.id }, data: { approvedAt: now } });
  return 'APPROVED';
}
