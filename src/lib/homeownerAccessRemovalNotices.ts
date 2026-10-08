import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { decryptPlatformEnvelope, encryptPlatformEnvelope } from './hubOperatorCredentials';

const APNS_TOKEN = /^(?:[A-Fa-f0-9]{2}){32,256}$/;
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Queue generic security notices before relationship cleanup can delete the
 * recipient account. The independent outbox is encrypted and has no account
 * or membership foreign key, so final-account deletion cannot erase notice
 * evidence or strand a plaintext recipient address/token.
 */
export async function queueHomeownerAccessRemovalNotices(tx: Prisma.TransactionClient, input: {
  homeId: string; membershipId: string; customerAccountId: string; revision: number;
  kind: 'TENANT' | 'PROPERTY_MANAGER' | 'OWNERSHIP_TRANSFER' | 'FULL_HOME_DEREGISTRATION'; now: Date;
}) {
  const [account, devices] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: input.customerAccountId }, select: { email: true, emailVerifiedAt: true, status: true } }),
    tx.trustedDevice.findMany({ where: { customerAccountId: input.customerAccountId, revokedAt: null,
      apnsTokenCiphertext: { not: null }, apnsTokenDigest: { not: null }, apnsEnvironment: { not: null }, apnsKeyVersion: 1 },
      select: { id: true, apnsTokenCiphertext: true, apnsEnvironment: true } }),
  ]);
  const expiresAt = new Date(input.now.getTime() + EXPIRY_MS);
  const type = input.kind === 'TENANT' ? 'TENANT_ACCESS_REMOVAL_NOTICE'
    : input.kind === 'PROPERTY_MANAGER' ? 'PROPERTY_MANAGER_ACCESS_REMOVAL_NOTICE'
      : input.kind === 'OWNERSHIP_TRANSFER' ? 'OWNERSHIP_TRANSFER_NOTICE' : 'HOME_DEREGISTRATION_NOTICE';
  const noticeId = crypto.randomUUID();
  const entries: Prisma.NativeDomainOutboxCreateManyInput[] = [];
  if (account?.status === 'ACTIVE' && account.emailVerifiedAt && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) {
    const sealed = encryptPlatformEnvelope(JSON.stringify({ version: 1, channel: 'EMAIL', recipient: account.email }));
    entries.push({ homeId: input.homeId, aggregateType: 'HomeownerAccessRemovalNotice', aggregateId: input.membershipId,
      eventType: type, idempotencyKey: `homeowner-removal:${input.membershipId}:${input.revision}:email`,
      payload: { noticeId, sealed }, expiresAt });
  }
  for (const device of devices) {
    if (!device.apnsTokenCiphertext || !device.apnsEnvironment) continue;
    try {
      const token = decryptPlatformEnvelope(device.apnsTokenCiphertext);
      if (!APNS_TOKEN.test(token)) continue;
      const sealed = encryptPlatformEnvelope(JSON.stringify({ version: 1, channel: 'PUSH', deviceToken: token,
        environment: device.apnsEnvironment, trustedDeviceId: device.id }));
      entries.push({ homeId: input.homeId, aggregateType: 'HomeownerAccessRemovalNotice', aggregateId: input.membershipId,
        eventType: type, idempotencyKey: `homeowner-removal:${input.membershipId}:${input.revision}:push:${device.id}`,
        payload: { noticeId, sealed }, expiresAt });
    } catch { /* Missing/invalid platform encryption material fails closed: no raw token is queued. */ }
  }
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}
