import crypto from 'node:crypto';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { enforcePersistentRateLimit } from './rateLimit';
import { sha256 } from './stage1Crypto';
import { hashPassword, verifyPassword } from './passwords';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Bind a new tenant account only after the invitee proves possession of the
 * one-time credential delivered to the invitation's exact email address.
 * The temporary username is an inaccessible placeholder; the app requires a
 * unique user-selected username after the mandatory password replacement. */
export async function startInvitedTenantRegistration(input: { invitationId: string; email: string; temporaryPassword: string }): Promise<string | null> {
  const email = input.email.trim().toLowerCase();
  if (!UUID.test(input.invitationId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320
    || input.temporaryPassword.length < 12 || input.temporaryPassword.length > 1024) {
    throw new Stage1AuthError(400, 'customer_registration_invalid', 'The invitation sign-in details are invalid');
  }
  // AuthRateLimitBucket.bucketKey is bounded to 160 characters. Hash the
  // complete invitation/email tuple once instead of concatenating two
  // 64-character digests beyond the persisted column limit.
  await enforcePersistentRateLimit(`customer-invitation-registration:${sha256(`${input.invitationId}:${email}`)}`, 8, 60 * 60 * 1000);

  const invitation = await prisma.membershipInvitation.findFirst({
    where: { id: input.invitationId, targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: new Date() }, temporaryCredentialHash: { not: null } },
    select: { id: true, temporaryCredentialHash: true },
  });
  if (!invitation?.temporaryCredentialHash || !verifyPassword(input.temporaryPassword, invitation.temporaryCredentialHash)) return null;
  const candidateIds = await prisma.membershipInvitation.findMany({ where: {
    targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: new Date() },
  }, select: { id: true }, orderBy: { id: 'asc' }, take: 20 });
  const lockIds = [...new Set([...candidateIds.map((row) => row.id), input.invitationId])].sort();
  const passwordHash = hashPassword(input.temporaryPassword);

  try {
    const result = await prisma.$transaction(async (tx) => {
      for (const id of lockIds) await tx.$queryRaw`SELECT "id" FROM "MembershipInvitation" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const now = new Date();
      const current = await tx.membershipInvitation.findUnique({ where: { id: input.invitationId }, select: {
        id: true, targetEmailNormalized: true, role: true, state: true, expiresAt: true,
        temporaryCredentialHash: true, targetAccountId: true,
      } });
      if (!current || current.targetEmailNormalized !== email || current.role !== 'TENANT' || current.state !== 'PENDING'
        || current.expiresAt <= now || !current.temporaryCredentialHash
        || !verifyPassword(input.temporaryPassword, current.temporaryCredentialHash)) return null;
      const existing = await tx.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true } });
      if (existing) return null;

      const username = `setup-${crypto.randomUUID()}`;
      const account = await tx.customerAccount.create({ data: {
        displayName: 'Dinodia customer', username, usernameNormalized: username,
        email, emailNormalized: email, passwordHash,
        mustChangePassword: true, usernameSelectionRequired: true, status: 'ACTIVE',
      }, select: { id: true } });
      const invitations = await tx.membershipInvitation.findMany({ where: {
        targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: now },
      }, select: { id: true } });
      await tx.membershipInvitation.updateMany({ where: { id: { in: invitations.map((row) => row.id) }, state: 'PENDING', expiresAt: { gt: now } },
        data: { targetAccountId: account.id, temporaryCredentialHash: null } });
      await tx.auditEvent.create({ data: {
        actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_invitation_registration_started',
        targetType: 'CustomerAccount', targetId: account.id,
        metadata: { outcome: 'email_verification_pending', invitationCount: invitations.length, usernameSelectionRequired: true },
        occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      } });
      return account.id;
    }, { isolationLevel: 'Serializable' });
    return result;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['P2002', 'P2034'].includes(String((error as { code?: unknown }).code))) return null;
    throw error;
  }
}
