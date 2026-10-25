import { prisma } from './prisma';
import { randomSecret, sha256 } from './stage1Crypto';
import { sendCustomerAuthEmail } from './customerAuthEmail';

export type CustomerAuthChallengePurpose = 'CUSTOMER_EMAIL_VERIFY' | 'CUSTOMER_PASSWORD_RESET' | 'CUSTOMER_EMAIL_CHANGE';

export async function issueCustomerAuthChallenge(input: {
  accountId: string | null;
  email: string;
  purpose: CustomerAuthChallengePurpose;
}): Promise<{ id: string; expiresAt: Date; deliveryStatus: 'PENDING' | 'ACCEPTED' | 'FAILED' }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const secret = randomSecret(32);
  const challenge = await prisma.$transaction(async (tx) => {
    await tx.authChallenge.updateMany({
      where: { customerAccountId: input.accountId, purpose: input.purpose, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    return tx.authChallenge.create({ data: {
      customerAccountId: input.accountId,
      purpose: input.purpose,
      targetEmail: input.accountId ? input.email : null,
      tokenHash: sha256(secret),
      expiresAt,
      deliveryStatus: 'PENDING',
    }, select: { id: true, expiresAt: true } });
  });

  if (!input.accountId) return { ...challenge, deliveryStatus: 'PENDING' };
  try {
    await sendCustomerAuthEmail({
      email: input.email,
      purpose: input.purpose === 'CUSTOMER_EMAIL_VERIFY' ? 'verify' : input.purpose === 'CUSTOMER_EMAIL_CHANGE' ? 'change' : 'reset',
      token: secret,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
    });
    await prisma.authChallenge.update({ where: { id: challenge.id }, data: { deliveryStatus: 'ACCEPTED', deliveryAttemptedAt: new Date() } });
    return { ...challenge, deliveryStatus: 'ACCEPTED' };
  } catch {
    await prisma.authChallenge.update({ where: { id: challenge.id }, data: { deliveryStatus: 'FAILED', deliveryAttemptedAt: new Date(), revokedAt: new Date() } });
    return { ...challenge, deliveryStatus: 'FAILED' };
  }
}

export async function customerChallengeState(challengeId: string, now = new Date()): Promise<'PENDING' | 'VERIFIED' | 'COMPLETED' | 'EXPIRED'> {
  const challenge = await prisma.authChallenge.findUnique({ where: { id: challengeId }, select: { purpose: true, expiresAt: true, consumedAt: true, revokedAt: true, deliveryStatus: true } });
  if (!challenge || !['CUSTOMER_EMAIL_VERIFY', 'CUSTOMER_PASSWORD_RESET', 'CUSTOMER_EMAIL_CHANGE'].includes(challenge.purpose)) return 'EXPIRED';
  if (challenge.consumedAt) return challenge.purpose === 'CUSTOMER_EMAIL_VERIFY' ? 'VERIFIED' : 'COMPLETED';
  // Delivery failure remains an honest pending/retry state without exposing
  // whether the submitted address belongs to an account.
  if (challenge.revokedAt && challenge.deliveryStatus === 'FAILED' && challenge.expiresAt > now) return 'PENDING';
  if (challenge.revokedAt || challenge.expiresAt <= now) return 'EXPIRED';
  return 'PENDING';
}
