import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NativeSupportCategory } from '@prisma/client';
import { prisma } from './prisma';
import { enforcePersistentRateLimit } from './rateLimit';
import { sendPublicSupportVerificationCode } from './customerAuthEmail';
import { Stage1AuthError } from './stage1Auth';
import { sha256 } from './stage1Crypto';

const categories = new Set<NativeSupportCategory>([
  'ACCOUNT_OR_SIGN_IN', 'ACCESS_OR_PERMISSIONS', 'DEVICE_PROBLEM', 'HUB_OR_CONNECTION', 'AUTOMATION', 'ALEXA', 'OTHER',
]);

function pepper(): string {
  const value = String(process.env.CLAIM_REFERENCE_PEPPER ?? '').trim();
  if (value.length < 32) throw new Stage1AuthError(503, 'SUPPORT_UNAVAILABLE', 'Public support verification is unavailable');
  return value;
}

function keyedDigest(domain: string, value: string): string {
  return createHmac('sha256', pepper()).update(`${domain}\n${value}`, 'utf8').digest('hex');
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().normalize('NFKC').toLowerCase();
  return /^\S+@\S+\.\S+$/.test(normalized) && normalized.length <= 320 ? normalized : '';
}

function normalizeTicketText(category: unknown, description: unknown): { category: NativeSupportCategory; description: string } | null {
  const text = typeof description === 'string' ? description.trim() : '';
  if (typeof category !== 'string' || !categories.has(category as NativeSupportCategory)
    || !text || [...text].length > 4000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return null;
  return { category: category as NativeSupportCategory, description: text };
}

export async function beginPublicSupportVerification(input: { replyEmail: unknown; category: unknown; description: unknown }) {
  const email = normalizeEmail(input.replyEmail);
  const ticket = normalizeTicketText(input.category, input.description);
  if (!email || !ticket) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Enter a reply email, approved category and description');
  const emailHash = keyedDigest('public-support-email-v1', email);
  await enforcePersistentRateLimit(`public-support-email:${emailHash}`, 3, 60 * 60 * 1000);
  const challengeId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const tokenHash = keyedDigest('public-support-code-v1', `${challengeId}:${code}`);
  await prisma.$transaction(async (tx) => {
    await tx.authChallenge.updateMany({
      where: { customerAccountId: null, targetEmail: email, purpose: 'PUBLIC_SUPPORT_TICKET', consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, targetEmail: null },
    });
    await tx.authChallenge.create({ data: {
      id: challengeId, customerAccountId: null, targetEmail: email, purpose: 'PUBLIC_SUPPORT_TICKET',
      tokenHash, expiresAt, deliveryStatus: 'PENDING',
    } });
  });
  try {
    await sendPublicSupportVerificationCode({ email, code, expiresAt });
    await prisma.authChallenge.update({ where: { id: challengeId }, data: { deliveryStatus: 'ACCEPTED', deliveryAttemptedAt: new Date() } });
    return { challengeId, expiresAt, emailSubmission: 'ACCEPTED' as const };
  } catch {
    await prisma.authChallenge.update({ where: { id: challengeId }, data: { deliveryStatus: 'FAILED', deliveryAttemptedAt: new Date(), revokedAt: new Date(), targetEmail: null } });
    return { challengeId, expiresAt, emailSubmission: 'FAILED' as const };
  }
}

export async function verifyAndCreatePublicSupportTicket(input: {
  challengeId: unknown; code: unknown; category: unknown; description: unknown;
}) {
  const challengeId = typeof input.challengeId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.challengeId) ? input.challengeId : '';
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const ticketInput = normalizeTicketText(input.category, input.description);
  if (!challengeId || !/^\d{6}$/.test(code) || !ticketInput) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid verification code and support request are required');
  await enforcePersistentRateLimit(`public-support-challenge:${sha256(challengeId)}`, 5, 10 * 60 * 1000);

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AuthChallenge" WHERE "id" = ${challengeId}::uuid FOR UPDATE`;
    const challenge = await tx.authChallenge.findUnique({ where: { id: challengeId }, select: {
      id: true, customerAccountId: true, purpose: true, targetEmail: true, tokenHash: true,
      expiresAt: true, consumedAt: true, revokedAt: true, attemptCount: true, deliveryStatus: true,
    } });
    // Capture time after obtaining the row lock: lock wait must not preserve an
    // already expired email proof.
    const now = new Date();
    if (!challenge || challenge.customerAccountId !== null || challenge.purpose !== 'PUBLIC_SUPPORT_TICKET'
      || (!challenge.targetEmail && !challenge.consumedAt) || challenge.deliveryStatus !== 'ACCEPTED' || challenge.revokedAt
      || (!challenge.consumedAt && challenge.expiresAt <= now)) {
      if (challenge && challenge.purpose === 'PUBLIC_SUPPORT_TICKET' && !challenge.consumedAt && challenge.expiresAt <= now && challenge.targetEmail) {
        await tx.authChallenge.update({ where: { id: challengeId }, data: { revokedAt: now, targetEmail: null } });
      }
      return { kind: 'DENIED' as const };
    }
    const presentedHash = keyedDigest('public-support-code-v1', `${challengeId}:${code}`);
    const expected = Buffer.from(challenge.tokenHash, 'hex');
    const presented = Buffer.from(presentedHash, 'hex');
    const matches = expected.length === presented.length && timingSafeEqual(expected, presented);
    if (!matches) {
      const attempts = challenge.attemptCount + 1;
      await tx.authChallenge.update({ where: { id: challengeId }, data: {
        attemptCount: attempts,
        ...(attempts >= 5 ? { revokedAt: now } : {}),
      } });
      return { kind: 'DENIED' as const };
    }

    const publicReference = `DNO-${keyedDigest('public-support-reference-v1', challengeId).slice(0, 16).toUpperCase()}`;
    const submissionDigest = keyedDigest('public-support-submission-v1', `${ticketInput.category}\n${ticketInput.description}`);
    if (challenge.consumedAt) {
      const prior = await tx.supportTicket.findUnique({ where: { publicReference }, select: { category: true, timeline: { where: { eventCode: 'PUBLIC_CREATED' }, select: { safeMetadata: true }, take: 1 } } });
      const metadata = prior?.timeline[0]?.safeMetadata;
      const priorDigest = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.submissionDigest : undefined;
      if (!prior || prior.category !== ticketInput.category || priorDigest !== submissionDigest) return { kind: 'CONFLICT' as const };
      return { kind: 'CREATED' as const, publicReference, replay: true };
    }

    const purgeAt = new Date(now);
    purgeAt.setUTCMonth(purgeAt.getUTCMonth() + 12);
    const requesterEmailHash = keyedDigest('public-support-requester-v1', challenge.targetEmail!);
    await tx.supportTicket.create({ data: {
      publicReference, customerAccountId: null, homeId: null, selectedMembershipId: null,
      requesterEmailHash, nativeCategory: ticketInput.category, category: ticketInput.category,
      description: ticketInput.description, purgeAt,
      timeline: { create: {
        homeId: null, eventCode: 'PUBLIC_CREATED', actorType: 'CUSTOMER', actorId: null,
        customerVisible: false, safeSummary: 'Reply address verified; standalone public support request created',
        safeMetadata: { submissionDigest }, purgeAt, createdAt: now,
      } },
    } });
    await tx.authChallenge.update({ where: { id: challengeId }, data: { consumedAt: now, approvedAt: now, targetEmail: null } });
    return { kind: 'CREATED' as const, publicReference, replay: false };
  });

  if (outcome.kind === 'DENIED') throw new Stage1AuthError(409, 'SUPPORT_VERIFICATION_INVALID', 'The code is invalid, expired or already used');
  if (outcome.kind === 'CONFLICT') throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This verification was already used for a different request');
  return { schemaVersion: 'dinodia.v1' as const, ok: true as const, state: 'SUBMITTED' as const, publicReference: outcome.publicReference, idempotentReplay: outcome.replay };
}
