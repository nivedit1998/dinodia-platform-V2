import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { constantTimeEqual, randomSecret, sha256 } from './stage1Crypto';
import { enforcePersistentRateLimit } from './rateLimit';
import { Stage1AuthError } from './stage1Auth';
import { sendMfaCodeEmail } from './customerAuthEmail';
import { serializableTransaction } from './serializableTransaction';
import { MFA_CODE_MINUTES, type MfaCodePurpose } from './noticeContent';

/**
 * Two-step verification by emailed code.
 *
 * Who needs it: a homeowner or property manager (any active OWNER or PROPERTY_MANAGER membership) always; a tenant only if
 * they turned it on. A code is asked for on every new password sign-in (the app, and the Alexa page) and never on a silent
 * session refresh. The code is tied to the exact sign-in attempt: when the password is accepted the app is handed a second
 * secret that only it holds, and both the secret and the code are needed to finish, so a code from the mailbox alone is useless.
 *
 * Codes are never stored (only a keyed hash), never logged and never put in a banner.
 */
export const MFA_PURPOSE = {
  SIGN_IN: 'MFA_SIGN_IN', ALEXA_SIGN_IN: 'MFA_ALEXA_SIGN_IN', ENABLE: 'MFA_ENABLE', DISABLE: 'MFA_DISABLE',
} as const;
export type MfaPurpose = (typeof MFA_PURPOSE)[keyof typeof MFA_PURPOSE];

const CODE_TTL_MS = MFA_CODE_MINUTES * 60 * 1000;
export const MFA_MAX_ATTEMPTS = 5;
export const MFA_RESEND_COOLDOWN_MS = 30_000;
const MAX_RESENDS = 3;
const ISSUE_LIMIT = 5;
const ISSUE_WINDOW_MS = 60 * 60 * 1000;
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const MFA_PROMPT_MAX_DISMISSALS = 3;
const CHALLENGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const CODE = /^\d{6}$/;

/** Off unless explicitly switched on, so a deploy never changes anyone's sign-in by itself. */
export function mfaEnforced(): boolean { return process.env.DINODIA_MFA_ENFORCED === 'true'; }

function pepper(): string {
  const value = String(process.env.CLAIM_REFERENCE_PEPPER ?? '').trim();
  if (value.length < 32) throw new Stage1AuthError(503, 'MFA_EMAIL_UNAVAILABLE', 'Two-step verification is unavailable right now');
  return value;
}
function digest(domain: string, value: string): string {
  return crypto.createHmac('sha256', pepper()).update(`${domain}\n${value}`, 'utf8').digest('hex');
}
const codeDigest = (challengeId: string, code: string) => digest('mfa-code-v1', `${challengeId}:${code}`);

/** What ties a challenge to one sign-in attempt: the phone (installation + key) or the Alexa request, or the signed-in session. */
export function deviceBinding(deviceInstallationId: string, publicKeyThumbprint: string): string {
  return sha256(`mfa-device-v1\n${deviceInstallationId}\n${publicKeyThumbprint}`);
}
export function sessionBinding(sessionId: string): string { return sha256(`mfa-session-v1\n${sessionId}`); }
export function alexaBinding(requestHash: string): string { return sha256(`mfa-alexa-v1\n${requestHash}`); }

export type MfaRequirement = { requirement: 'REQUIRED' | 'ENABLED' | 'NONE'; reason: 'OWNER' | 'PROPERTY_MANAGER' | 'OPT_IN' | null };

export async function accountMfaRequirement(db: Pick<Prisma.TransactionClient, 'homeMembership' | 'customerAccount'>, accountId: string): Promise<MfaRequirement> {
  const [roles, account] = await Promise.all([
    db.homeMembership.findMany({ where: { customerAccountId: accountId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] } }, select: { role: true } }),
    db.customerAccount.findUnique({ where: { id: accountId }, select: { mfaEnabledAt: true } }),
  ]);
  if (roles.some((row) => row.role === 'OWNER')) return { requirement: 'REQUIRED', reason: 'OWNER' };
  if (roles.length > 0) return { requirement: 'REQUIRED', reason: 'PROPERTY_MANAGER' };
  if (account?.mfaEnabledAt) return { requirement: 'ENABLED', reason: 'OPT_IN' };
  return { requirement: 'NONE', reason: null };
}

/** "j***@gmail.com": enough to recognise the mailbox, not enough to reveal the address to a bystander. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return 'your email';
  return `${local[0]}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`;
}

export type MfaChallengeIssue = { challengeId: string; clientSecret: string; expiresAt: Date; resendAvailableAt: Date; maskedEmail: string };

async function sendCode(input: { email: string; code: string; purpose: MfaCodePurpose }): Promise<void> {
  try { await sendMfaCodeEmail(input); }
  catch { throw new Stage1AuthError(503, 'MFA_EMAIL_UNAVAILABLE', 'We could not send your code right now. Please try again in a moment.'); }
}
const emailPurpose = (purpose: MfaPurpose): MfaCodePurpose => purpose === MFA_PURPOSE.ALEXA_SIGN_IN ? 'ALEXA_SIGN_IN' : purpose === MFA_PURPOSE.ENABLE ? 'ENABLE' : purpose === MFA_PURPOSE.DISABLE ? 'DISABLE' : 'SIGN_IN';
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** Start a challenge and email the code. Fails closed: if the email cannot be sent the challenge is discarded and nothing proceeds. */
export async function issueMfaChallenge(input: { accountId: string; email: string; purpose: MfaPurpose; bindingHash: string }): Promise<MfaChallengeIssue> {
  try { await enforcePersistentRateLimit(`mfa-issue:${input.accountId}`, ISSUE_LIMIT, ISSUE_WINDOW_MS); }
  catch (error) {
    if (error instanceof Stage1AuthError && error.status === 429) throw new Stage1AuthError(429, 'mfa_rate_limited', 'Too many codes were requested. Please wait a little while and try again.');
    throw error;
  }
  const now = new Date();
  const id = crypto.randomUUID();
  const code = newCode();
  const clientSecret = randomSecret(32);
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.authChallenge.updateMany({ where: { customerAccountId: input.accountId, purpose: input.purpose, bindingHash: input.bindingHash, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now } });
    await tx.authChallenge.create({ data: { id, customerAccountId: input.accountId, purpose: input.purpose, targetEmail: input.email, tokenHash: codeDigest(id, code),
      clientSecretHash: sha256(clientSecret), bindingHash: input.bindingHash, expiresAt, deliveryStatus: 'PENDING' } });
  });
  try { await sendCode({ email: input.email, code, purpose: emailPurpose(input.purpose) }); }
  catch (error) {
    await prisma.authChallenge.updateMany({ where: { id }, data: { revokedAt: new Date(), deliveryStatus: 'FAILED', deliveryAttemptedAt: new Date() } });
    throw error;
  }
  const sentAt = new Date();
  await prisma.authChallenge.updateMany({ where: { id }, data: { deliveryStatus: 'ACCEPTED', deliveryAttemptedAt: sentAt } });
  return { challengeId: id, clientSecret, expiresAt, resendAvailableAt: new Date(sentAt.getTime() + MFA_RESEND_COOLDOWN_MS), maskedEmail: maskEmail(input.email) };
}

/** A fresh code for the same challenge (the old code stops working). At most three resends, with a short pause between. */
export async function resendMfaChallenge(input: { challengeId: unknown; clientSecret: unknown }): Promise<{ expiresAt: Date; resendAvailableAt: Date; maskedEmail: string }> {
  if (typeof input.challengeId !== 'string' || !CHALLENGE_ID.test(input.challengeId) || typeof input.clientSecret !== 'string' || !CLIENT_SECRET.test(input.clientSecret)) {
    throw new Stage1AuthError(400, 'MFA_CHALLENGE_INVALID', 'Please start again.');
  }
  const challengeId = input.challengeId;
  const challenge = await prisma.authChallenge.findUnique({ where: { id: challengeId }, select: {
    id: true, purpose: true, customerAccountId: true, targetEmail: true, clientSecretHash: true, consumedAt: true, revokedAt: true, expiresAt: true, resendCount: true, deliveryAttemptedAt: true } });
  const now = new Date();
  if (!challenge || !challenge.purpose.startsWith('MFA_') || !challenge.clientSecretHash || !challenge.customerAccountId || !challenge.targetEmail
    || !constantTimeEqual(challenge.clientSecretHash, sha256(input.clientSecret)) || challenge.consumedAt || challenge.revokedAt || challenge.expiresAt <= now) {
    throw new Stage1AuthError(400, 'MFA_CHALLENGE_INVALID', 'That code has expired. Please start again.');
  }
  if (challenge.resendCount >= MAX_RESENDS) throw new Stage1AuthError(429, 'mfa_resend_limit', 'You have asked for too many codes. Please start again.');
  const waitUntil = (challenge.deliveryAttemptedAt?.getTime() ?? 0) + MFA_RESEND_COOLDOWN_MS;
  if (waitUntil > now.getTime()) throw new Stage1AuthError(429, 'mfa_resend_too_soon', `Please wait ${Math.max(1, Math.ceil((waitUntil - now.getTime()) / 1000))} seconds before asking for another code.`);
  try { await enforcePersistentRateLimit(`mfa-issue:${challenge.customerAccountId}`, ISSUE_LIMIT * 2, ISSUE_WINDOW_MS); }
  catch (error) {
    if (error instanceof Stage1AuthError && error.status === 429) throw new Stage1AuthError(429, 'mfa_rate_limited', 'Too many codes were requested. Please wait a little while and try again.');
    throw error;
  }
  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const swapped = await prisma.authChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, revokedAt: null, resendCount: challenge.resendCount },
    data: { tokenHash: codeDigest(challenge.id, code), expiresAt, attemptCount: 0, resendCount: { increment: 1 }, deliveryAttemptedAt: now, deliveryStatus: 'PENDING' } });
  if (swapped.count !== 1) throw new Stage1AuthError(409, 'MFA_CHALLENGE_INVALID', 'Please try again.');
  try { await sendCode({ email: challenge.targetEmail, code, purpose: emailPurpose(challenge.purpose as MfaPurpose) }); }
  catch (error) {
    await prisma.authChallenge.updateMany({ where: { id: challenge.id }, data: { deliveryStatus: 'FAILED' } });
    throw error;
  }
  await prisma.authChallenge.updateMany({ where: { id: challenge.id }, data: { deliveryStatus: 'ACCEPTED' } });
  return { expiresAt, resendAvailableAt: new Date(now.getTime() + MFA_RESEND_COOLDOWN_MS), maskedEmail: maskEmail(challenge.targetEmail) };
}

export type MfaVerifyResult =
  | { ok: true; accountId: string; challengeId: string }
  | { ok: false; reason: 'INVALID_CODE'; attemptsRemaining: number }
  | { ok: false; reason: 'EXPIRED' | 'LOCKED' | 'INVALID' };

/**
 * Check a code against a challenge. The code, the app's secret and the sign-in attempt it belongs to must all match. A wrong
 * code costs one of five tries; the fifth locks the challenge. A right code is used up in the same step.
 */
export async function verifyMfaChallenge(input: { challengeId: unknown; clientSecret: unknown; code: unknown; purpose: MfaPurpose; bindingHash: string }): Promise<MfaVerifyResult> {
  if (typeof input.challengeId !== 'string' || !CHALLENGE_ID.test(input.challengeId) || typeof input.clientSecret !== 'string' || !CLIENT_SECRET.test(input.clientSecret)
    || typeof input.code !== 'string' || !CODE.test(input.code)) return { ok: false, reason: 'INVALID' };
  const challengeId = input.challengeId;
  const hint = await prisma.authChallenge.findUnique({ where: { id: challengeId }, select: { customerAccountId: true } });
  if (!hint?.customerAccountId) return { ok: false, reason: 'INVALID' };
  try { await enforcePersistentRateLimit(`mfa-verify:${hint.customerAccountId}`, 40, 15 * 60 * 1000); }
  catch (error) {
    if (error instanceof Stage1AuthError && error.status === 429) return { ok: false, reason: 'LOCKED' };
    throw error;
  }
  return serializableTransaction(async (tx): Promise<MfaVerifyResult> => {
    await tx.$queryRaw`SELECT "id" FROM "AuthChallenge" WHERE "id" = ${challengeId}::uuid FOR UPDATE`;
    const row = await tx.authChallenge.findUnique({ where: { id: challengeId }, select: {
      id: true, purpose: true, customerAccountId: true, tokenHash: true, clientSecretHash: true, bindingHash: true,
      attemptCount: true, consumedAt: true, revokedAt: true, expiresAt: true } });
    const now = new Date();
    if (!row || row.purpose !== input.purpose || !row.customerAccountId || !row.clientSecretHash || !row.bindingHash
      || !constantTimeEqual(row.clientSecretHash, sha256(input.clientSecret as string)) || !constantTimeEqual(row.bindingHash, input.bindingHash)
      || row.consumedAt) return { ok: false, reason: 'INVALID' };
    if (row.revokedAt) return { ok: false, reason: row.attemptCount >= MFA_MAX_ATTEMPTS ? 'LOCKED' : 'INVALID' };
    if (row.expiresAt <= now) return { ok: false, reason: 'EXPIRED' };
    if (row.attemptCount >= MFA_MAX_ATTEMPTS) return { ok: false, reason: 'LOCKED' };
    if (!constantTimeEqual(row.tokenHash, codeDigest(row.id, input.code as string))) {
      const attempts = row.attemptCount + 1;
      await tx.authChallenge.update({ where: { id: row.id }, data: { attemptCount: attempts, ...(attempts >= MFA_MAX_ATTEMPTS ? { revokedAt: now } : {}) } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: row.customerAccountId, category: 'SECURITY', action: attempts >= MFA_MAX_ATTEMPTS ? 'mfa_challenge_locked' : 'mfa_code_rejected',
        targetType: 'AuthChallenge', targetId: row.id, metadata: { purpose: row.purpose, attempts }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return attempts >= MFA_MAX_ATTEMPTS ? { ok: false, reason: 'LOCKED' } : { ok: false, reason: 'INVALID_CODE', attemptsRemaining: MFA_MAX_ATTEMPTS - attempts };
    }
    await tx.authChallenge.update({ where: { id: row.id }, data: { consumedAt: now, approvedAt: now } });
    await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: row.customerAccountId, category: 'SECURITY', action: 'mfa_code_accepted',
      targetType: 'AuthChallenge', targetId: row.id, metadata: { purpose: row.purpose }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return { ok: true, accountId: row.customerAccountId, challengeId: row.id };
  }, 3);
}

/** The error a route returns for a failed check, in plain words the app shows as they are. */
export function mfaFailureError(result: Exclude<MfaVerifyResult, { ok: true }>): Stage1AuthError {
  if (result.reason === 'INVALID_CODE') {
    return new Stage1AuthError(401, 'MFA_CODE_INVALID', `That code isn’t right. You have ${result.attemptsRemaining} ${result.attemptsRemaining === 1 ? 'try' : 'tries'} left.`);
  }
  if (result.reason === 'EXPIRED') return new Stage1AuthError(401, 'MFA_CODE_EXPIRED', 'That code has expired. Ask for a new one.');
  if (result.reason === 'LOCKED') return new Stage1AuthError(429, 'MFA_LOCKED', 'Too many wrong codes. Please start again.');
  return new Stage1AuthError(400, 'MFA_CHALLENGE_INVALID', 'That code can’t be used. Please start again.');
}

export function mfaPromptState(account: { mfaPromptSnoozedUntil: Date | null; mfaPromptDismissCount: number }, requirement: MfaRequirement, now = new Date()): boolean {
  return requirement.requirement === 'NONE' && account.mfaPromptDismissCount < MFA_PROMPT_MAX_DISMISSALS
    && (!account.mfaPromptSnoozedUntil || account.mfaPromptSnoozedUntil <= now);
}
export const MFA_SNOOZE_MS = SNOOZE_MS;
