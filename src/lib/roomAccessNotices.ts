import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { decryptPlatformEnvelope, encryptPlatformEnvelope } from './hubOperatorCredentials';
import { PlatformDataEncryptionKeyError } from './platformDataEncryptionKey';
import type { NoticeDetails, NoticeDevice } from './noticeContent';

export const ROOM_ACCESS_REQUEST_NOTICE = 'ROOM_ACCESS_REQUEST_NOTICE';
export const ROOM_ACCESS_APPROVED_NOTICE = 'ROOM_ACCESS_APPROVED_NOTICE';
export const ROOM_ACCESS_DECLINED_NOTICE = 'ROOM_ACCESS_DECLINED_NOTICE';
export const ALEXA_LINKED_NOTICE = 'ALEXA_LINKED_NOTICE';
export const NEW_DEVICES_NOTICE = 'NEW_DEVICES_NOTICE';
export const MFA_ENABLED_NOTICE = 'MFA_ENABLED_NOTICE';
export const MFA_DISABLED_NOTICE = 'MFA_DISABLED_NOTICE';
/** Same independent, encrypted outbox the other access notices use, so one dispatcher delivers every kind. */
export const ACCESS_NOTICE_AGGREGATE = 'HomeownerAccessRemovalNotice';
/** Notice types added alongside the original removal notices; the dispatcher picks them up with the rest. */
export const ACCOUNT_NOTICE_TYPES = [ROOM_ACCESS_REQUEST_NOTICE, ROOM_ACCESS_APPROVED_NOTICE, ROOM_ACCESS_DECLINED_NOTICE, ALEXA_LINKED_NOTICE, NEW_DEVICES_NOTICE, MFA_ENABLED_NOTICE, MFA_DISABLED_NOTICE] as const;

const APNS_TOKEN = /^(?:[A-Fa-f0-9]{2}){32,256}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A request notice is only useful while the request is open; the rest stay useful a little longer.
const REQUEST_NOTICE_MS = 2 * 24 * 60 * 60 * 1000;
const NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
/** The optional preference families that can switch a notice off. Everything else is always sent. */
export const NEW_DEVICES_OWNER_FAMILY = 'new_permanent_devices';
export const NEW_DEVICES_TENANT_FAMILY = 'new_permanent_devices_in_authorized_areas';

/** A presentation name overrides the source name when one is set (same rule as the rest of the app). */
function displayName(original: string, override: string | null): string {
  return override?.normalize('NFC').trim() || original;
}

export function isAccountNoticeType(value: string): boolean {
  return (ACCOUNT_NOTICE_TYPES as readonly string[]).includes(value);
}

/** "12 High Street, London": how a Home is named in a notice. Falls back to "your Home" when no address is recorded. */
export async function homeLabelFor(tx: Pick<Prisma.TransactionClient, 'home'>, homeId: string): Promise<string> {
  const home = await tx.home.findUnique({ where: { id: homeId }, select: { addressLine1: true, city: true } });
  return [home?.addressLine1, home?.city].map((part) => (part ?? '').trim()).filter(Boolean).join(', ') || 'your Home';
}

/** Optional notices are on unless the member has saved a choice that leaves the family out. */
export async function optionalFamilyEnabled(tx: Pick<Prisma.TransactionClient, 'memberPreferenceDocument'>, membershipId: string, family: string): Promise<boolean> {
  const row = await tx.memberPreferenceDocument.findUnique({ where: { membershipId_kind: { membershipId, kind: 'NOTIFICATION_PREFERENCES' } }, select: { document: true } });
  const document = row?.document;
  if (!document || typeof document !== 'object' || Array.isArray(document)) return true;
  const families = (document as Record<string, unknown>).enabledFamilies;
  return !Array.isArray(families) || families.includes(family);
}

async function sealedEntries(tx: Prisma.TransactionClient, input: {
  accountId: string; homeId: string | null; aggregateId: string; type: string; keyBase: string; expiresAt: Date; details: NoticeDetails;
}): Promise<Prisma.NativeDomainOutboxCreateManyInput[]> {
  const [account, devices] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: input.accountId }, select: { email: true, emailVerifiedAt: true, status: true } }),
    tx.trustedDevice.findMany({ where: { customerAccountId: input.accountId, revokedAt: null,
      apnsTokenCiphertext: { not: null }, apnsTokenDigest: { not: null }, apnsEnvironment: { not: null }, apnsKeyVersion: 1 },
      select: { id: true, apnsTokenCiphertext: true, apnsEnvironment: true } }),
  ]);
  const entries: Prisma.NativeDomainOutboxCreateManyInput[] = [];
  if (account?.status === 'ACTIVE' && account.emailVerifiedAt && EMAIL.test(account.email) && account.email.length <= 320) {
    const sealed = encryptPlatformEnvelope(JSON.stringify({ version: 1, channel: 'EMAIL', recipient: account.email, details: input.details }));
    entries.push({ homeId: input.homeId, aggregateType: ACCESS_NOTICE_AGGREGATE, aggregateId: input.aggregateId, eventType: input.type,
      idempotencyKey: `${input.keyBase}:email`, payload: { noticeId: randomUUID(), sealed }, expiresAt: input.expiresAt });
  }
  if (account?.status !== 'ACTIVE') return entries;
  for (const device of devices) {
    if (!device.apnsTokenCiphertext || !device.apnsEnvironment) continue;
    try {
      const token = decryptPlatformEnvelope(device.apnsTokenCiphertext);
      if (!APNS_TOKEN.test(token)) continue;
      const sealed = encryptPlatformEnvelope(JSON.stringify({ version: 1, channel: 'PUSH', deviceToken: token,
        environment: device.apnsEnvironment, trustedDeviceId: device.id, details: input.details }));
      entries.push({ homeId: input.homeId, aggregateType: ACCESS_NOTICE_AGGREGATE, aggregateId: input.aggregateId, eventType: input.type,
        idempotencyKey: `${input.keyBase}:push:${device.id}`, payload: { noticeId: randomUUID(), sealed }, expiresAt: input.expiresAt });
    } catch (error) {
      if (error instanceof PlatformDataEncryptionKeyError) throw error;
      /* A stored envelope that cannot be read is skipped; a key-configuration failure aborts the transaction. */
    }
  }
  return entries;
}

async function requestDetails(tx: Prisma.TransactionClient, homeId: string, requestId: string): Promise<NoticeDetails> {
  const [request, homeLabel] = await Promise.all([
    tx.areaAccessRequest.findUnique({ where: { id: requestId }, select: {
      createdAt: true, requesterAccountId: true, requesterEmailNormalized: true,
      area: { select: { originalName: true, overrideName: true } },
      requester: { select: { displayName: true, email: true } },
    } }),
    homeLabelFor(tx, homeId),
  ]);
  const email = request?.requester?.email ?? request?.requesterEmailNormalized ?? undefined;
  return {
    homeLabel,
    roomName: request ? displayName(request.area.originalName, request.area.overrideName) : undefined,
    requesterName: request?.requester?.displayName || email, requesterEmail: email, at: request?.createdAt.toISOString(),
  };
}

/**
 * A new room request: tell everyone who can decide it (the homeowner and any property manager) by email and push, naming the
 * person, their email and the room. Call inside the transaction that created the request. Retried or coalesced requests do not
 * call it again.
 */
export async function queueRoomAccessRequestNotices(tx: Prisma.TransactionClient, input: { homeId: string; requestId: string; now: Date }) {
  const deciders = await tx.homeMembership.findMany({ where: { homeId: input.homeId, role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE',
    customerAccount: { is: { status: 'ACTIVE' } } }, select: { customerAccountId: true } });
  const details = await requestDetails(tx, input.homeId, input.requestId);
  const expiresAt = new Date(input.now.getTime() + REQUEST_NOTICE_MS);
  const entries: Prisma.NativeDomainOutboxCreateManyInput[] = [];
  for (const decider of deciders) {
    entries.push(...await sealedEntries(tx, { accountId: decider.customerAccountId, homeId: input.homeId, aggregateId: input.requestId,
      type: ROOM_ACCESS_REQUEST_NOTICE, keyBase: `room-access-request:${input.requestId}:${decider.customerAccountId}`, expiresAt, details }));
  }
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}

async function queueDecisionNotice(tx: Prisma.TransactionClient, type: string, keyPrefix: string, input: { homeId: string; requestId: string; requesterAccountId: string; now: Date }) {
  const details = await requestDetails(tx, input.homeId, input.requestId);
  const entries = await sealedEntries(tx, { accountId: input.requesterAccountId, homeId: input.homeId, aggregateId: input.requestId,
    type, keyBase: `${keyPrefix}:${input.requestId}:${input.requesterAccountId}`, expiresAt: new Date(input.now.getTime() + NOTICE_MS),
    details: { homeLabel: details.homeLabel, roomName: details.roomName, at: input.now.toISOString() } });
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}

/** An approved request for an existing account: tell the requester by email and push, with a link into the app. */
export function queueRoomAccessApprovedNotice(tx: Prisma.TransactionClient, input: { homeId: string; requestId: string; requesterAccountId: string; now: Date }) {
  return queueDecisionNotice(tx, ROOM_ACCESS_APPROVED_NOTICE, 'room-access-approved', input);
}

/** A declined request: the requester hears so by email and push rather than waiting. */
export function queueRoomAccessDeclinedNotice(tx: Prisma.TransactionClient, input: { homeId: string; requestId: string; requesterAccountId: string; now: Date }) {
  return queueDecisionNotice(tx, ROOM_ACCESS_DECLINED_NOTICE, 'room-access-declined', input);
}

/** Alexa was just linked to this account: a security confirmation by email and push, with how to undo it. */
export async function queueAlexaLinkedNotice(tx: Prisma.TransactionClient, input: { accountId: string; linkId: string; now: Date }) {
  const entries = await sealedEntries(tx, { accountId: input.accountId, homeId: null, aggregateId: input.linkId, type: ALEXA_LINKED_NOTICE,
    keyBase: `alexa-linked:${input.linkId}`, expiresAt: new Date(input.now.getTime() + NOTICE_MS), details: { at: input.now.toISOString() } });
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}

/** The devices Dinodia installed under one request, with the room each now sits in. Tenant-added devices are never listed. */
export async function installedDevicesForRequest(tx: Prisma.TransactionClient, homeId: string, requestId: string): Promise<Array<NoticeDevice & { areaId: string | null }>> {
  const rows = await tx.nativeDevice.findMany({ where: { homeId, installationRequestId: requestId, managementClass: 'PROPERTY_DEVICE', lifecycle: 'INSTALLED' },
    orderBy: [{ installedAt: 'asc' }, { id: 'asc' }], take: 200, select: { customerLabel: true, originalName: true, overrideName: true,
      assignments: { where: { validUntil: null }, take: 1, select: { areaId: true, area: { select: { originalName: true, overrideName: true } } } } } });
  return rows.map((row) => {
    const assignment = row.assignments[0];
    return { name: row.customerLabel || displayName(row.originalName, row.overrideName),
      room: assignment ? displayName(assignment.area.originalName, assignment.area.overrideName) : '', areaId: assignment?.areaId ?? null };
  });
}

/**
 * Dinodia finished an installation: each tenant hears about the new devices in the rooms they can use, by email and push
 * (owners and the requesting manager have their own completion notice). A tenant with nothing new in their rooms, or who has
 * switched the optional notice off, hears nothing.
 */
export async function queueNewDevicesTenantNotices(tx: Prisma.TransactionClient, input: { homeId: string; requestId: string; reference: string | null; now: Date }) {
  const devices = await installedDevicesForRequest(tx, input.homeId, input.requestId);
  if (devices.length === 0) return { queued: 0 };
  const tenants = await tx.homeMembership.findMany({ where: { homeId: input.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { is: { status: 'ACTIVE' } } },
    select: { id: true, customerAccountId: true, tenantAreaGrants: { where: { revokedAt: null }, select: { areaId: true } } } });
  const homeLabel = await homeLabelFor(tx, input.homeId);
  const entries: Prisma.NativeDomainOutboxCreateManyInput[] = [];
  for (const tenant of tenants) {
    const granted = new Set(tenant.tenantAreaGrants.map((grant) => grant.areaId));
    const visible = devices.filter((device) => device.areaId && granted.has(device.areaId)).map(({ name, room }) => ({ name, room }));
    if (visible.length === 0 || !await optionalFamilyEnabled(tx, tenant.id, NEW_DEVICES_TENANT_FAMILY)) continue;
    entries.push(...await sealedEntries(tx, { accountId: tenant.customerAccountId, homeId: input.homeId, aggregateId: input.requestId, type: NEW_DEVICES_NOTICE,
      keyBase: `new-devices:${input.requestId}:${tenant.customerAccountId}`, expiresAt: new Date(input.now.getTime() + NOTICE_MS),
      details: { homeLabel, devices: visible, audience: 'TENANT', at: input.now.toISOString() } }));
  }
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}

/** Notice details for the homeowner's (or requesting manager's) completion notice: what was installed, where, and under which request. */
export async function completionDetails(db: Prisma.TransactionClient, homeId: string, requestId: string, audience: 'OWNER' | 'TENANT', reference?: string): Promise<NoticeDetails> {
  const [devices, homeLabel, request] = await Promise.all([
    installedDevicesForRequest(db, homeId, requestId), homeLabelFor(db, homeId),
    db.permanentDeviceInstallationRequest.findUnique({ where: { id: requestId }, select: { customerReference: true, completedAt: true } }),
  ]);
  return { homeLabel, audience, devices: devices.map(({ name, room }) => ({ name, room })),
    reference: reference ?? request?.customerReference ?? undefined, at: request?.completedAt?.toISOString() };
}

/** Two-step verification was turned on or off: a confirmation by email and banner, so a stranger doing it is noticed. */
export async function queueMfaChangedNotice(tx: Prisma.TransactionClient, input: { accountId: string; enabled: boolean; now: Date }) {
  const entries = await sealedEntries(tx, { accountId: input.accountId, homeId: null, aggregateId: input.accountId, type: input.enabled ? MFA_ENABLED_NOTICE : MFA_DISABLED_NOTICE,
    keyBase: `mfa-${input.enabled ? 'on' : 'off'}:${input.accountId}:${input.now.getTime()}`, expiresAt: new Date(input.now.getTime() + NOTICE_MS), details: { at: input.now.toISOString() } });
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}
