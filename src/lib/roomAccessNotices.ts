import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { decryptPlatformEnvelope, encryptPlatformEnvelope } from './hubOperatorCredentials';
import { PlatformDataEncryptionKeyError } from './platformDataEncryptionKey';

export const ROOM_ACCESS_REQUEST_NOTICE = 'ROOM_ACCESS_REQUEST_NOTICE';
export const ROOM_ACCESS_APPROVED_NOTICE = 'ROOM_ACCESS_APPROVED_NOTICE';
export const ROOM_ACCESS_NOTICE_TYPES = [ROOM_ACCESS_REQUEST_NOTICE, ROOM_ACCESS_APPROVED_NOTICE] as const;
/** Same independent, encrypted outbox the other access notices use, so one dispatcher delivers every kind. */
export const ACCESS_NOTICE_AGGREGATE = 'HomeownerAccessRemovalNotice';

const APNS_TOKEN = /^(?:[A-Fa-f0-9]{2}){32,256}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A request notice is only useful while the request is open; an approval notice stays useful a little longer.
const REQUEST_NOTICE_MS = 2 * 24 * 60 * 60 * 1000;
const APPROVED_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const APP_LINK = 'https://dinodia-platform-v2.vercel.app/app';

export type RoomAccessNoticeType = typeof ROOM_ACCESS_NOTICE_TYPES[number];

export function isRoomAccessNoticeType(value: string): value is RoomAccessNoticeType {
  return (ROOM_ACCESS_NOTICE_TYPES as readonly string[]).includes(value);
}

/** Wording is deliberately free of names, rooms and addresses: it appears on lock screens and in shared inboxes. */
export const ROOM_ACCESS_NOTICE_CONTENT: Record<RoomAccessNoticeType, {
  pushTitle: string; pushBody: string; subject: string; heading: string; paragraphs: string[]; button: string;
}> = {
  ROOM_ACCESS_REQUEST_NOTICE: {
    pushTitle: 'New room access request',
    pushBody: 'Someone would like to use a room in your Home. Tap to review and approve.',
    subject: 'Someone has requested access to a room in your Home',
    heading: 'A new room access request',
    paragraphs: [
      'Someone has asked for access to a room in your Dinodia Smart Living Home.',
      'Open the app to see the request and choose to approve or decline it. It only takes a moment.',
      'If you were not expecting this, simply decline it in the app and nothing will change.',
    ],
    button: 'Review the request',
  },
  ROOM_ACCESS_APPROVED_NOTICE: {
    pushTitle: 'Room access approved',
    pushBody: 'Good news, your request was approved. Tap to open Dinodia and choose your Home.',
    subject: 'Your room access has been approved',
    heading: 'You’re all set',
    paragraphs: [
      'Good news, your request for room access has been approved.',
      'Open the Dinodia Smart Living app, choose your Home and you can start controlling your room straight away.',
    ],
    button: 'Open Dinodia',
  },
};

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Plain-text and HTML bodies for one notice; the HTML is a single clean card with one button. */
export function roomAccessEmail(type: RoomAccessNoticeType): { subject: string; text: string; html: string } {
  const content = ROOM_ACCESS_NOTICE_CONTENT[type];
  const text = `${content.heading}\n\n${content.paragraphs.join('\n\n')}\n\n${content.button}: ${APP_LINK}\n\nDinodia Smart Living`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px;">`
    + `<tr><td style="font-size:13px;font-weight:600;letter-spacing:.04em;color:#0a84ff;text-transform:uppercase;">Dinodia Smart Living</td></tr>`
    + `<tr><td style="padding-top:12px;font-size:22px;font-weight:700;line-height:1.3;">${escapeHtml(content.heading)}</td></tr>`
    + content.paragraphs.map((paragraph) => `<tr><td style="padding-top:14px;font-size:16px;line-height:1.5;color:#3a3a3c;">${escapeHtml(paragraph)}</td></tr>`).join('')
    + `<tr><td style="padding-top:24px;"><a href="${APP_LINK}" style="display:inline-block;background:#0a84ff;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 24px;border-radius:12px;">${escapeHtml(content.button)}</a></td></tr>`
    + `</table></td></tr></table></body></html>`;
  return { subject: content.subject, text, html };
}

async function sealedEntries(tx: Prisma.TransactionClient, input: {
  accountId: string; homeId: string; aggregateId: string; type: RoomAccessNoticeType; keyBase: string; expiresAt: Date;
}): Promise<Prisma.NativeDomainOutboxCreateManyInput[]> {
  const [account, devices] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: input.accountId }, select: { email: true, emailVerifiedAt: true, status: true } }),
    tx.trustedDevice.findMany({ where: { customerAccountId: input.accountId, revokedAt: null,
      apnsTokenCiphertext: { not: null }, apnsTokenDigest: { not: null }, apnsEnvironment: { not: null }, apnsKeyVersion: 1 },
      select: { id: true, apnsTokenCiphertext: true, apnsEnvironment: true } }),
  ]);
  const entries: Prisma.NativeDomainOutboxCreateManyInput[] = [];
  if (account?.status === 'ACTIVE' && account.emailVerifiedAt && EMAIL.test(account.email) && account.email.length <= 320) {
    const sealed = encryptPlatformEnvelope(JSON.stringify({ version: 1, channel: 'EMAIL', recipient: account.email }));
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
        environment: device.apnsEnvironment, trustedDeviceId: device.id }));
      entries.push({ homeId: input.homeId, aggregateType: ACCESS_NOTICE_AGGREGATE, aggregateId: input.aggregateId, eventType: input.type,
        idempotencyKey: `${input.keyBase}:push:${device.id}`, payload: { noticeId: randomUUID(), sealed }, expiresAt: input.expiresAt });
    } catch (error) {
      if (error instanceof PlatformDataEncryptionKeyError) throw error;
      /* A stored envelope that cannot be read is skipped; a key-configuration failure aborts the transaction. */
    }
  }
  return entries;
}

/**
 * A new room request: tell everyone who can decide it (the homeowner and any property manager) by email and push.
 * Call inside the transaction that created the request. Retried or coalesced requests do not call it again.
 */
export async function queueRoomAccessRequestNotices(tx: Prisma.TransactionClient, input: { homeId: string; requestId: string; now: Date }) {
  const deciders = await tx.homeMembership.findMany({ where: { homeId: input.homeId, role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE',
    customerAccount: { is: { status: 'ACTIVE' } } }, select: { customerAccountId: true } });
  const expiresAt = new Date(input.now.getTime() + REQUEST_NOTICE_MS);
  const entries: Prisma.NativeDomainOutboxCreateManyInput[] = [];
  for (const decider of deciders) {
    entries.push(...await sealedEntries(tx, { accountId: decider.customerAccountId, homeId: input.homeId, aggregateId: input.requestId,
      type: ROOM_ACCESS_REQUEST_NOTICE, keyBase: `room-access-request:${input.requestId}:${decider.customerAccountId}`, expiresAt }));
  }
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}

/** An approved request for an existing account: tell the requester by email and push, with a link into the app. */
export async function queueRoomAccessApprovedNotice(tx: Prisma.TransactionClient, input: { homeId: string; requestId: string; requesterAccountId: string; now: Date }) {
  const entries = await sealedEntries(tx, { accountId: input.requesterAccountId, homeId: input.homeId, aggregateId: input.requestId,
    type: ROOM_ACCESS_APPROVED_NOTICE, keyBase: `room-access-approved:${input.requestId}:${input.requesterAccountId}`,
    expiresAt: new Date(input.now.getTime() + APPROVED_NOTICE_MS) });
  if (entries.length) await tx.nativeDomainOutbox.createMany({ data: entries, skipDuplicates: true });
  return { queued: entries.length };
}
