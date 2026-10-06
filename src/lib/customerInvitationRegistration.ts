import crypto from 'node:crypto';
import { prisma } from './prisma';
import { enforcePersistentRateLimit } from './rateLimit';
import { sha256 } from './stage1Crypto';
import { verifyPassword } from './passwords';

/**
 * A tenant's one-time password is delivered only to the invited email address.
 * Its first successful use is therefore the email-possession proof: create a
 * minimal verified account at sign-in, require password replacement and a
 * user-chosen username, and do not create Home membership until invitation
 * acceptance. No plaintext credential is persisted or returned.
 */
export async function consumeInvitedTenantCredentialForLogin(input: { email: string; password: string }): Promise<string | null> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320
    || input.password.length < 12 || input.password.length > 1024) return null;
  await enforcePersistentRateLimit(`customer-invited-login:${sha256(email)}`, 8, 15 * 60 * 1000);

  const candidates = await prisma.membershipInvitation.findMany({ where: {
    targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: new Date() },
    temporaryCredentialHash: { not: null },
  }, select: { id: true, temporaryCredentialHash: true }, orderBy: { id: 'asc' }, take: 20 });
  if (!candidates.some((row) => row.temporaryCredentialHash && verifyPassword(input.password, row.temporaryCredentialHash))) return null;
  const lockIds = candidates.map((row) => row.id).sort();
  try {
    return await prisma.$transaction(async (tx) => {
      for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "MembershipInvitation" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const now = new Date();
      const current = await tx.membershipInvitation.findMany({ where: {
        id: { in: lockIds }, targetEmailNormalized: email, role: 'TENANT', state: 'PENDING',
        expiresAt: { gt: now }, temporaryCredentialHash: { not: null },
      }, select: { id: true, temporaryCredentialHash: true }, orderBy: { id: 'asc' } });
      const accepted = current.find((row) => row.temporaryCredentialHash && verifyPassword(input.password, row.temporaryCredentialHash));
      if (!accepted?.temporaryCredentialHash) return null;
      const existing = await tx.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true } });
      if (existing) return existing.id;

      const username = `setup-${crypto.randomUUID()}`;
      const account = await tx.customerAccount.create({ data: {
        displayName: 'Dinodia customer', username, usernameNormalized: username,
        email, emailNormalized: email, emailVerifiedAt: now,
        passwordHash: accepted.temporaryCredentialHash,
        mustChangePassword: true, usernameSelectionRequired: true, status: 'ACTIVE',
      }, select: { id: true } });
      await tx.membershipInvitation.updateMany({ where: {
        targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: now },
      }, data: { targetAccountId: account.id, temporaryCredentialHash: null } });
      await tx.auditEvent.create({ data: {
        actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_invitation_temporary_login',
        targetType: 'CustomerAccount', targetId: account.id,
        metadata: { outcome: 'verified_email_possession', mustChangePassword: true, usernameSelectionRequired: true },
        occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      } });
      return account.id;
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['P2002', 'P2034'].includes(String((error as { code?: unknown }).code))) {
      return (await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true } }))?.id ?? null;
    }
    throw error;
  }
}
