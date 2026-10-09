import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { nextAllowedAutomationNotificationAt } from './notificationPolicy';

const FAILURE_FAMILY = 'automation_failure_or_skipped_run';
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^(?:[A-Fa-f0-9]{2}){32,256}$/;

/** Queue at most one optional push per current trusted installation for the owning tenant. */
export async function queueAutomationFailureNotices(tx: Prisma.TransactionClient, input: {
  homeId: string; automationId: string; membershipId: string | null; occurrenceKey: string; now: Date;
}) {
  if (!input.membershipId) return 0;
  const membership = await tx.homeMembership.findFirst({ where: {
    id: input.membershipId, homeId: input.homeId, role: 'TENANT', status: 'ACTIVE',
    customerAccount: { status: 'ACTIVE' },
  }, select: {
    id: true, customerAccountId: true,
    customerAccount: { select: { status: true } },
    preferences: { where: { kind: { in: ['NOTIFICATION_PREFERENCES', 'QUIET_HOURS'] } }, select: { kind: true, document: true } },
  } });
  if (!membership || membership.customerAccount.status !== 'ACTIVE') return 0;
  const preferences = membership.preferences.find((row) => row.kind === 'NOTIFICATION_PREFERENCES')?.document;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)
    || !Array.isArray((preferences as Record<string, unknown>).enabledFamilies)
    || !(preferences as { enabledFamilies: unknown[] }).enabledFamilies.includes(FAILURE_FAMILY)) return 0;
  const quietHours = membership.preferences.find((row) => row.kind === 'QUIET_HOURS')?.document;
  const deliverAfter = nextAllowedAutomationNotificationAt(input.now, quietHours);
  if (!deliverAfter) return 0;
  const devices = await tx.trustedDevice.findMany({ where: {
    customerAccountId: membership.customerAccountId, revokedAt: null, pushEnabledAt: { not: null }, pushRevokedAt: null,
    apnsTokenCiphertext: { not: null }, apnsTokenDigest: { not: null }, apnsEnvironment: { not: null }, apnsKeyVersion: 1,
  }, orderBy: { id: 'asc' }, take: 20, select: { id: true } });
  if (!devices.length) return 0;
  const occurrenceDigest = createHash('sha256').update(input.occurrenceKey).digest('hex');
  const expiresAt = new Date(input.now.getTime() + RECEIPT_TTL_MS);
  const result = await tx.nativeNotificationDeliveryReceipt.createMany({ data: devices.map((device) => ({
    customerAccountId: membership.customerAccountId, trustedDeviceId: device.id, membershipId: membership.id,
    homeId: input.homeId, family: 'TENANT_AUTOMATION_FAILURE' as const, channel: 'PUSH' as const,
    idempotencyKey: `automation-failure:${input.automationId}:${occurrenceDigest}:${device.id}`,
    deliverAfter, expiresAt,
  })), skipDuplicates: true });
  return result.count;
}

export function isAutomationFailureDeviceToken(value: string): boolean { return TOKEN_PATTERN.test(value); }
