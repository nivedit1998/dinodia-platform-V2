import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { prisma } from './prisma';
import { decryptPlatformEnvelope } from './hubOperatorCredentials';
import { getPlatformDataEncryptionKey, PlatformDataEncryptionKeyError } from './platformDataEncryptionKey';
import { readApnsConfig, sendHomeAccessChangedPush, sendInstallationCompletePush, sendRoomAccessApprovedPush, sendRoomAccessRequestPush, sendTenantAutomationFailurePush, sendTenantAutomationManagementPush, type ApnsConfig, type ApnsEnvironment, type ApnsResult } from './apnsDelivery';
import { nextAllowedAutomationNotificationAt } from './nativeAutomations/notificationPolicy';
import { isAutomationFailureDeviceToken } from './nativeAutomations/failureNotifications';
import { ROOM_ACCESS_NOTICE_CONTENT, ROOM_ACCESS_NOTICE_TYPES, isRoomAccessNoticeType, roomAccessEmail } from './roomAccessNotices';

const PORTAL_QUEUE = 'https://dinodia-platform-v2.vercel.app/installer/installation-requests';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OUTBOX_LIMIT = 20;
const RECEIPT_LIMIT = 20;
const ACCESS_NOTICE_EVENT_TYPES = ['TENANT_ACCESS_REMOVAL_NOTICE', 'PROPERTY_MANAGER_ACCESS_REMOVAL_NOTICE', 'OWNERSHIP_TRANSFER_NOTICE', 'HOME_DEREGISTRATION_NOTICE', 'TENANT_AUTOMATION_MANAGEMENT_NOTICE', ...ROOM_ACCESS_NOTICE_TYPES];

type DeliveryCounts = {
  operationsAccepted: number;
  operationsDeferred: number;
  operationsFailed: number;
  completionAccepted: number;
  completionDeferred: number;
  completionSuppressed: number;
  pushAccepted: number;
  pushDeferred: number;
  pushFailed: number;
  pushSuppressed: number;
  accessRemovalAccepted: number;
  accessRemovalDeferred: number;
  accessRemovalFailed: number;
  accessRemovalSuppressed: number;
  accessRemovalExpired: number;
  automationFailureAccepted: number;
  automationFailureDeferred: number;
  automationFailureFailed: number;
  automationFailureSuppressed: number;
};

function configuration(): { client: SESv2Client; source: string; operationsAddress: string | null } | null {
  const region = String(process.env.AWS_REGION ?? '').trim();
  const source = String(process.env.SES_FROM_EMAIL ?? '').trim();
  const operationsAddress = String(process.env.DINODIA_INSTALLATION_OPERATIONS_EMAIL ?? '').trim();
  const testEndpoint = String(process.env.SES_TEST_ENDPOINT ?? '').trim();
  const testEnvironment = String(process.env.V2_ENVIRONMENT ?? '') === 'test';
  if (!region || !EMAIL.test(source) || source.length > 320) return null;
  if (testEndpoint && !testEnvironment) return null;
  if (testEnvironment && !testEndpoint) return null;
  if (testEndpoint) {
    let parsed: URL;
    try { parsed = new URL(testEndpoint); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return null;
  }
  return { client: new SESv2Client({ region, ...(testEndpoint ? { endpoint: testEndpoint } : {}) }), source,
    operationsAddress: EMAIL.test(operationsAddress) && operationsAddress.length <= 320 ? operationsAddress : null };
}

async function sendTextEmail(client: SESv2Client, source: string, recipient: string, subject: string, body: string, html?: string): Promise<boolean> {
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [recipient] },
      Content: { Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: body, Charset: 'UTF-8' }, ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}) },
      } },
    }), { abortSignal: AbortSignal.timeout(10_000) });
    return Boolean(result.MessageId);
  } catch {
    return false;
  }
}

type InstallationPushReceipt = {
  id: string; idempotencyKey: string; homeId: string; customerAccountId: string;
  trustedDeviceId: string | null; membershipId: string | null; attemptCount: number; expiresAt: Date;
};

/** Rechecks the exact current homeowner/requester authority before each generic device push. */
export async function dispatchInstallationPushReceipts(
  now = new Date(),
  dependencies: { config?: ApnsConfig | null; send?: (input: { config: ApnsConfig; environment: ApnsEnvironment; deviceToken: string; requestId: string; expiresAt: Date }) => Promise<ApnsResult> } = {},
) {
  const counts = { accepted: 0, deferred: 0, failed: 0, suppressed: 0, expired: 0 };
  const receipts = await prisma.nativeNotificationDeliveryReceipt.findMany({
    where: { family: 'OWNER_INSTALLATION_UPDATE', channel: 'PUSH', status: 'PENDING', deliverAfter: { lte: now }, expiresAt: { gt: now }, attemptCount: { lt: 8 }, idempotencyKey: { startsWith: 'installation-request:' } },
    orderBy: [{ deliverAfter: 'asc' }, { id: 'asc' }], take: RECEIPT_LIMIT,
    select: { id: true, idempotencyKey: true, homeId: true, customerAccountId: true, trustedDeviceId: true, membershipId: true, attemptCount: true, expiresAt: true },
  }) as InstallationPushReceipt[];
  const config = Object.hasOwn(dependencies, 'config') ? dependencies.config ?? null : readApnsConfig();
  const send = dependencies.send ?? sendInstallationCompletePush;
  for (const receipt of receipts) {
    const match = /^installation-request:([0-9a-f-]{36}):completion:push:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(receipt.idempotencyKey);
    if (!match || match[2] !== receipt.customerAccountId || match[3] !== receipt.trustedDeviceId || !receipt.membershipId) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING' }, data: { status: 'SUPPRESSED', lastErrorCode: 'INVALID_REFERENCE' } });
      counts.suppressed += 1;
      continue;
    }
    const request = await prisma.permanentDeviceInstallationRequest.findFirst({
      where: { id: match[1], homeId: receipt.homeId, status: 'COMPLETED' },
      select: { id: true, requesterAccountId: true, requesterMembershipId: true },
    });
    const permittedMemberships = request ? [
      { role: 'OWNER' as const },
      ...(request.requesterMembershipId && request.requesterAccountId
        ? [{ id: request.requesterMembershipId, customerAccountId: request.requesterAccountId, role: 'PROPERTY_MANAGER' as const }]
        : []),
    ] : [];
    const membership = request && await prisma.homeMembership.findFirst({ where: {
      id: receipt.membershipId, homeId: receipt.homeId, customerAccountId: receipt.customerAccountId,
      status: 'ACTIVE', customerAccount: { is: { status: 'ACTIVE', emailVerifiedAt: { not: null } } },
      OR: permittedMemberships,
    }, select: { id: true } });
    const device = membership && await prisma.trustedDevice.findFirst({ where: {
      id: receipt.trustedDeviceId ?? undefined, customerAccountId: receipt.customerAccountId,
      revokedAt: null, apnsTokenCiphertext: { not: null }, apnsTokenDigest: { not: null },
      apnsEnvironment: { not: null }, apnsKeyVersion: 1,
    }, select: { id: true, apnsTokenCiphertext: true, apnsTokenDigest: true, apnsEnvironment: true, apnsTokenRevision: true } });
    if (!request || !membership || !device || !device.apnsTokenCiphertext || !device.apnsTokenDigest || !device.apnsEnvironment) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { status: 'SUPPRESSED', lastErrorCode: 'NO_CURRENT_PUSH_AUTHORITY' } });
      counts.suppressed += 1;
      continue;
    }
    if (!config) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { lastErrorCode: 'PUSH_PROVIDER_NOT_CONFIGURED' } });
      counts.deferred += 1;
      continue;
    }
    // Fail before claiming/advancing the receipt if the shared encryption
    // dependency is malformed; a configuration error is not a bad token.
    getPlatformDataEncryptionKey();
    const claimed = await prisma.nativeNotificationDeliveryReceipt.updateMany({
      where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount, deliverAfter: { lte: now }, expiresAt: { gt: now } },
      data: { attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    let deviceToken: string;
    try { deviceToken = decryptPlatformEnvelope(device.apnsTokenCiphertext); }
    catch (error) {
      if (error instanceof PlatformDataEncryptionKeyError) throw error;
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount + 1 }, data: { status: 'FAILED', lastErrorCode: 'PUSH_TOKEN_DECRYPTION_FAILED' } });
      counts.failed += 1;
      continue;
    }
    let result: ApnsResult;
    try {
      result = await send({ config, environment: device.apnsEnvironment, deviceToken, requestId: request.id, expiresAt: receipt.expiresAt });
    } catch { result = { outcome: 'RETRY' }; }
    const attempt = receipt.attemptCount + 1;
    if (result.outcome === 'INVALID_TOKEN') {
      await prisma.$transaction(async (tx) => {
        await tx.trustedDevice.updateMany({ where: { id: device.id, customerAccountId: receipt.customerAccountId, revokedAt: null, apnsTokenDigest: device.apnsTokenDigest, apnsTokenRevision: device.apnsTokenRevision }, data: {
          apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null,
          apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'INVALID_TOKEN',
        } });
        await tx.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: attempt }, data: { status: 'SUPPRESSED', lastErrorCode: 'APNS_TOKEN_INVALID' } });
      });
      counts.suppressed += 1;
    } else if (result.outcome === 'ACCEPTED') {
      await prisma.$transaction(async (tx) => {
        await tx.trustedDevice.updateMany({ where: { id: device.id, customerAccountId: receipt.customerAccountId, revokedAt: null, apnsTokenDigest: device.apnsTokenDigest, apnsTokenRevision: device.apnsTokenRevision }, data: { lastDeliveryHealth: 'APNS_ACCEPTED' } });
        await tx.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: attempt }, data: { status: 'SENT', lastErrorCode: null } });
      });
      counts.accepted += 1;
    } else {
      const terminal = result.outcome === 'FAILED' || attempt >= 8;
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: attempt }, data: {
        status: terminal ? 'FAILED' : 'PENDING', deliverAfter: terminal ? now : nextAttempt(now, attempt),
        lastErrorCode: result.outcome === 'FAILED' ? 'APNS_REJECTED' : terminal ? 'APNS_RETRY_EXHAUSTED' : 'APNS_TEMPORARY_FAILURE',
      } });
      if (terminal) counts.failed += 1; else counts.deferred += 1;
    }
  }
  return counts;
}

function nextAttempt(now: Date, attempt: number): Date {
  const delayMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.max(0, attempt - 1)));
  return new Date(now.getTime() + delayMs);
}

/**
 * Delivers the generic tenant/property-manager removal notice from the same
 * two-minute operations dispatcher. Recipient email/APNs values are encrypted
 * in the independent outbox so a final-account cleanup cannot erase the notice
 * before delivery. Provider acceptance is not represented as inbox delivery.
 */
export async function dispatchHomeownerAccessRemovalNotices(now = new Date(), dependencies: {
  sendEmail?: (input: { recipient: string; noticeId: string }) => Promise<boolean>;
  sendPush?: (input: { environment: ApnsEnvironment; deviceToken: string; noticeId: string; expiresAt: Date }) => Promise<ApnsResult>;
} = {}) {
  const counts = { accepted: 0, deferred: 0, failed: 0, suppressed: 0, expired: 0 };
  const stale = new Date(now.getTime() - 5 * 60_000);
  await prisma.nativeDomainOutbox.updateMany({ where: { aggregateType: 'HomeownerAccessRemovalNotice',
    eventType: { in: ACCESS_NOTICE_EVENT_TYPES }, state: 'PROCESSING',
    updatedAt: { lt: stale }, expiresAt: { gt: now }, attempts: { lt: 8 } }, data: { state: 'PENDING', nextAttemptAt: now } });
  await prisma.nativeDomainOutbox.updateMany({ where: { aggregateType: 'HomeownerAccessRemovalNotice',
    eventType: { in: ACCESS_NOTICE_EVENT_TYPES }, state: 'PROCESSING',
    attempts: { gte: 8 }, expiresAt: { gt: now } }, data: { state: 'FAILED' } });
  const abandonedExpired = await prisma.nativeDomainOutbox.updateMany({ where: { aggregateType: 'HomeownerAccessRemovalNotice',
    eventType: { in: ACCESS_NOTICE_EVENT_TYPES }, state: 'PROCESSING', expiresAt: { lte: now } }, data: { state: 'EXPIRED' } });
  const expired = await prisma.nativeDomainOutbox.updateMany({ where: { aggregateType: 'HomeownerAccessRemovalNotice',
    eventType: { in: ACCESS_NOTICE_EVENT_TYPES }, state: 'PENDING', expiresAt: { lte: now } }, data: { state: 'EXPIRED' } });
  counts.expired += expired.count + abandonedExpired.count;
  const rows = await prisma.nativeDomainOutbox.findMany({ where: { aggregateType: 'HomeownerAccessRemovalNotice',
    eventType: { in: ACCESS_NOTICE_EVENT_TYPES }, state: 'PENDING',
    nextAttemptAt: { lte: now }, expiresAt: { gt: now }, attempts: { lt: 8 } },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: RECEIPT_LIMIT,
    select: { id: true, eventType: true, expiresAt: true, attempts: true, payload: true } });
  if (rows.length) getPlatformDataEncryptionKey();
  const configured = dependencies.sendEmail && dependencies.sendPush ? null : configuration();
  const apns = dependencies.sendPush ? null : readApnsConfig();
  for (const row of rows) {
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown> : null;
    let noticeId = '';
    let decoded: Record<string, unknown> | null = null;
    try {
      const sealed = payload?.sealed;
      if (!sealed || typeof sealed !== 'object' || Array.isArray(sealed)) throw new Error('sealed payload invalid');
      decoded = JSON.parse(decryptPlatformEnvelope(JSON.stringify(sealed))) as Record<string, unknown>;
      noticeId = String(payload?.noticeId ?? '');
    } catch (error) {
      if (error instanceof PlatformDataEncryptionKeyError) throw error;
      /* Invalid stored envelopes are suppressed; configuration failures are not. */
    }
    if (!decoded || decoded.version !== 1 || !/^[0-9a-f-]{36}$/i.test(noticeId)) {
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING', attempts: row.attempts }, data: { state: 'FAILED' } });
      counts.suppressed += 1;
      continue;
    }
    const channel = decoded.channel;
    const isEmail = channel === 'EMAIL' && typeof decoded.recipient === 'string' && EMAIL.test(decoded.recipient) && decoded.recipient.length <= 320;
    const isPush = channel === 'PUSH' && typeof decoded.deviceToken === 'string'
      && /^(?:[A-Fa-f0-9]{2}){32,256}$/.test(decoded.deviceToken)
      && (decoded.environment === 'DEVELOPMENT' || decoded.environment === 'PRODUCTION')
      && typeof decoded.trustedDeviceId === 'string' && /^[0-9a-f-]{36}$/i.test(decoded.trustedDeviceId);
    if (!isEmail && !isPush) {
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING', attempts: row.attempts }, data: { state: 'FAILED' } });
      counts.suppressed += 1;
      continue;
    }
    if (isEmail && !dependencies.sendEmail && (!configured || !configured.source)) {
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING', attempts: row.attempts },
        data: { nextAttemptAt: nextAttempt(now, Math.max(1, row.attempts + 1)) } });
      counts.deferred += 1; continue;
    }
    if (isPush && !dependencies.sendPush && !apns) {
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING', attempts: row.attempts },
        data: { nextAttemptAt: nextAttempt(now, Math.max(1, row.attempts + 1)) } });
      counts.deferred += 1; continue;
    }
    const claimed = await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING', attempts: row.attempts,
      nextAttemptAt: { lte: now }, expiresAt: { gt: now } }, data: { state: 'PROCESSING', attempts: { increment: 1 } } });
    if (claimed.count !== 1) continue;
    let accepted = false;
    let invalidToken = false;
    try {
      if (isEmail) {
        const room = isRoomAccessNoticeType(row.eventType) ? roomAccessEmail(row.eventType) : null;
        accepted = dependencies.sendEmail
          ? await dependencies.sendEmail({ recipient: decoded.recipient as string, noticeId })
          : Boolean(configured && await (room
            ? sendTextEmail(configured.client, configured.source, decoded.recipient as string, room.subject, room.text, room.html)
            : sendTextEmail(configured.client, configured.source, decoded.recipient as string,
              row.eventType === 'TENANT_AUTOMATION_MANAGEMENT_NOTICE' ? 'A Home automation was updated' : 'Dinodia Smart Living access changed',
              row.eventType === 'TENANT_AUTOMATION_MANAGEMENT_NOTICE'
                ? 'A property manager changed an automation. Sign in to review its current status. This message contains no Home, rule or device details.'
                : 'Access to one of your Dinodia Smart Living homes has changed. Sign in to review your active homes. This message contains no property or device details.')));
      } else {
        const result = dependencies.sendPush
          ? await dependencies.sendPush({ environment: decoded.environment as ApnsEnvironment, deviceToken: decoded.deviceToken as string, noticeId, expiresAt: row.expiresAt })
          : isRoomAccessNoticeType(row.eventType)
            ? await (row.eventType === 'ROOM_ACCESS_REQUEST_NOTICE' ? sendRoomAccessRequestPush : sendRoomAccessApprovedPush)({
              config: apns!, environment: decoded.environment as ApnsEnvironment, deviceToken: decoded.deviceToken as string,
              requestId: noticeId, expiresAt: row.expiresAt }, { title: ROOM_ACCESS_NOTICE_CONTENT[row.eventType].pushTitle, body: ROOM_ACCESS_NOTICE_CONTENT[row.eventType].pushBody })
            : row.eventType === 'TENANT_AUTOMATION_MANAGEMENT_NOTICE'
            ? await sendTenantAutomationManagementPush({ config: apns!, environment: decoded.environment as ApnsEnvironment,
              deviceToken: decoded.deviceToken as string, requestId: noticeId, expiresAt: row.expiresAt })
            : await sendHomeAccessChangedPush({ config: apns!, environment: decoded.environment as ApnsEnvironment,
              deviceToken: decoded.deviceToken as string, requestId: noticeId, expiresAt: row.expiresAt });
        accepted = result.outcome === 'ACCEPTED';
        invalidToken = result.outcome === 'INVALID_TOKEN';
      }
    } catch { accepted = false; }
    const attempt = row.attempts + 1;
    const terminal = invalidToken || attempt >= 8;
    await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PROCESSING', attempts: attempt }, data: accepted
      ? { state: 'DELIVERED' }
      : terminal ? { state: 'FAILED' } : { state: 'PENDING', nextAttemptAt: nextAttempt(now, attempt) } });
    if (accepted) counts.accepted += 1;
    else if (terminal) counts.failed += 1;
    else counts.deferred += 1;
  }
  configured?.client.destroy();
  return counts;
}

/**
 * Sends only bounded, non-sensitive installation notices from the existing
 * two-minute operations dispatcher. Provider acceptance is recorded as SENT;
 * it is not represented as inbox delivery. Missing SES/recipient configuration
 * leaves rows pending and never logs the configured address or message body.
 */
export async function dispatchInstallationRequestNotifications(now = new Date()) {
  const counts: DeliveryCounts = {
    operationsAccepted: 0, operationsDeferred: 0, operationsFailed: 0,
    completionAccepted: 0, completionDeferred: 0, completionSuppressed: 0,
    pushAccepted: 0, pushDeferred: 0, pushFailed: 0, pushSuppressed: 0,
    accessRemovalAccepted: 0, accessRemovalDeferred: 0, accessRemovalFailed: 0, accessRemovalSuppressed: 0, accessRemovalExpired: 0,
    automationFailureAccepted: 0, automationFailureDeferred: 0, automationFailureFailed: 0, automationFailureSuppressed: 0,
  };
  const configured = configuration();
  // A dispatcher process can disappear after claiming an outbox row. Reopen a
  // bounded old lease on the existing two-minute task; the stable request
  // reference lets operations recognize a retry without exposing Home data.
  const staleLease = new Date(now.getTime() - 5 * 60_000);
  await prisma.nativeDomainOutbox.updateMany({ where: {
    aggregateType: 'PermanentDeviceInstallationRequest', eventType: 'INSTALLATION_REQUEST_EMAIL', state: 'PROCESSING',
    updatedAt: { lt: staleLease }, expiresAt: { gt: now }, attempts: { lt: 12 },
  }, data: { state: 'PENDING', nextAttemptAt: now } });
  await prisma.nativeDomainOutbox.updateMany({ where: {
    aggregateType: 'PermanentDeviceInstallationRequest', eventType: 'INSTALLATION_REQUEST_EMAIL', state: 'PROCESSING',
    OR: [{ expiresAt: { lte: now } }, { attempts: { gte: 12 } }],
  }, data: { state: 'FAILED' } });
  const outbox = await prisma.nativeDomainOutbox.findMany({
    where: {
      aggregateType: 'PermanentDeviceInstallationRequest',
      eventType: { in: ['INSTALLATION_REQUEST_EMAIL', 'INSTALLATION_REQUEST_COMPLETED'] },
      state: 'PENDING', nextAttemptAt: { lte: now }, expiresAt: { gt: now }, attempts: { lt: 12 },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: OUTBOX_LIMIT,
    select: { id: true, aggregateId: true, eventType: true, expiresAt: true, attempts: true, homeId: true },
  });
  if (!configured || !configured.operationsAddress) counts.operationsDeferred += outbox.filter((row) => row.eventType === 'INSTALLATION_REQUEST_EMAIL').length;

  for (const row of outbox) {
    const request = await prisma.permanentDeviceInstallationRequest.findUnique({
      where: { id: row.aggregateId },
      select: { id: true, customerReference: true, category: true, status: true },
    });
    if (!request) {
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING' }, data: { state: 'FAILED', attempts: { increment: 1 } } });
      counts.operationsFailed += row.eventType === 'INSTALLATION_REQUEST_EMAIL' ? 1 : 0;
      continue;
    }
    if (row.eventType === 'INSTALLATION_REQUEST_COMPLETED') {
      if (request.status !== 'COMPLETED' || !row.homeId) continue;
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING', expiresAt: { gt: now } }, data: { state: 'DELIVERED', attempts: { increment: 1 } } });
      continue;
    }
    if (request.status === 'CANCELLED') {
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PENDING' }, data: { state: 'CANCELLED' } });
      continue;
    }
    if (!configured || !configured.operationsAddress) { counts.operationsDeferred += 1; continue; }
    const claimed = await prisma.nativeDomainOutbox.updateMany({
      where: { id: row.id, eventType: 'INSTALLATION_REQUEST_EMAIL', state: 'PENDING', expiresAt: { gt: now }, attempts: { lt: 12 } },
      data: { state: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    const accepted = await sendTextEmail(configured.client, configured.source, configured.operationsAddress,
      'New Dinodia Smart Living installation request',
      `A permanent-device installation request is ready for staff review.\nReference: ${request.customerReference}\nCategory: ${request.category}\nCurrent status: ${request.status}\n\nOpen the protected Company Portal queue: ${PORTAL_QUEUE}\n\nThis notice contains no household notes, address, device details or commissioning credentials.`);
    if (accepted) {
      await prisma.nativeDomainOutbox.updateMany({ where: { id: row.id, state: 'PROCESSING' }, data: { state: 'DELIVERED' } });
      counts.operationsAccepted += 1;
    } else {
      const exhausted = row.attempts + 1 >= 12;
      await prisma.nativeDomainOutbox.updateMany({
        where: { id: row.id, state: 'PROCESSING' },
        data: { state: exhausted ? 'FAILED' : 'PENDING', nextAttemptAt: nextAttempt(now, row.attempts + 1) },
      });
      if (exhausted) counts.operationsFailed += 1;
      else counts.operationsDeferred += 1;
    }
  }

  const pendingEmails = await prisma.nativeNotificationDeliveryReceipt.findMany({
    where: { family: 'OWNER_INSTALLATION_UPDATE', channel: 'EMAIL', status: 'PENDING', deliverAfter: { lte: now }, expiresAt: { gt: now }, attemptCount: { lt: 8 }, idempotencyKey: { startsWith: 'installation-request:' } },
    orderBy: [{ deliverAfter: 'asc' }, { id: 'asc' }], take: RECEIPT_LIMIT,
    select: { id: true, idempotencyKey: true, homeId: true, customerAccountId: true, membershipId: true, attemptCount: true },
  });
  if (!configured) counts.completionDeferred += pendingEmails.length;
  if (configured) for (const receipt of pendingEmails) {
    const match = /^installation-request:([0-9a-f-]{36}):completion:email:([0-9a-f-]{36})$/i.exec(receipt.idempotencyKey);
    if (!match || match[2] !== receipt.customerAccountId) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING' }, data: { status: 'SUPPRESSED', lastErrorCode: 'INVALID_REFERENCE' } });
      counts.completionSuppressed += 1;
      continue;
    }
    const request = await prisma.permanentDeviceInstallationRequest.findFirst({ where: { id: match[1], homeId: receipt.homeId, status: 'COMPLETED' }, select: { customerReference: true, requesterAccountId: true, requesterMembershipId: true } });
    const permittedMemberships = request ? [
      { role: 'OWNER' as const },
      ...(request.requesterMembershipId && request.requesterAccountId
        ? [{ id: request.requesterMembershipId, customerAccountId: request.requesterAccountId, role: 'PROPERTY_MANAGER' as const }]
        : []),
    ] : [];
    const current = request && await prisma.homeMembership.findFirst({ where: {
      id: receipt.membershipId ?? undefined, homeId: receipt.homeId, customerAccountId: receipt.customerAccountId,
      status: 'ACTIVE', customerAccount: { is: { status: 'ACTIVE', emailVerifiedAt: { not: null } } },
      OR: permittedMemberships,
    }, select: { id: true, customerAccount: { select: { email: true } } } });
    if (!current || !request || !EMAIL.test(current.customerAccount.email)) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING' }, data: { status: 'SUPPRESSED', lastErrorCode: 'NO_CURRENT_RECIPIENT' } });
      counts.completionSuppressed += 1;
      continue;
    }
    const claimed = await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { attemptCount: { increment: 1 } } });
    if (claimed.count !== 1) continue;
    const accepted = await sendTextEmail(configured.client, configured.source, current.customerAccount.email,
      'Dinodia Smart Living installation request complete',
      `The permanent-device installation request for your Home is complete.\nReference: ${request.customerReference}\n\nOpen the Dinodia Smart Living app or sign in to the canonical account portal to view your Home. This message contains no device, tenant or commissioning details. Provider acceptance does not confirm inbox delivery.`);
    await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount + 1 }, data: accepted
      ? { status: 'SENT', lastErrorCode: null }
      : { status: receipt.attemptCount + 1 >= 8 ? 'FAILED' : 'PENDING', deliverAfter: nextAttempt(now, receipt.attemptCount + 1), lastErrorCode: 'PROVIDER_NOT_ACCEPTED' } });
    if (accepted) counts.completionAccepted += 1;
    else counts.completionDeferred += 1;
  }
  const push = await dispatchInstallationPushReceipts(now);
  counts.pushAccepted += push.accepted;
  counts.pushDeferred += push.deferred;
  counts.pushFailed += push.failed;
  counts.pushSuppressed += push.suppressed;
  const removal = await dispatchHomeownerAccessRemovalNotices(now);
  counts.accessRemovalAccepted += removal.accepted;
  counts.accessRemovalDeferred += removal.deferred;
  counts.accessRemovalFailed += removal.failed;
  counts.accessRemovalSuppressed += removal.suppressed;
  counts.accessRemovalExpired += removal.expired;
  const automationFailures = await dispatchTenantAutomationFailureNotifications(now);
  counts.automationFailureAccepted += automationFailures.accepted;
  counts.automationFailureDeferred += automationFailures.deferred;
  counts.automationFailureFailed += automationFailures.failed;
  counts.automationFailureSuppressed += automationFailures.suppressed;
  configured?.client.destroy();
  return counts;
}

/** Optional failure/skipped notices are delivered only to the active owning tenant's opted-in trusted installations. */
export async function dispatchTenantAutomationFailureNotifications(now = new Date(), dependencies: {
  config?: ApnsConfig | null;
  send?: (input: { config: ApnsConfig; environment: ApnsEnvironment; deviceToken: string; requestId: string; expiresAt: Date }) => Promise<ApnsResult>;
} = {}) {
  const counts = { accepted: 0, deferred: 0, failed: 0, suppressed: 0 };
  const expired = await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: {
    family: 'TENANT_AUTOMATION_FAILURE', channel: 'PUSH', status: 'PENDING', expiresAt: { lte: now },
  }, data: { status: 'EXPIRED', lastErrorCode: 'NOTICE_EXPIRED' } });
  counts.suppressed += expired.count;
  const receipts = await prisma.nativeNotificationDeliveryReceipt.findMany({ where: {
    family: 'TENANT_AUTOMATION_FAILURE', channel: 'PUSH', status: 'PENDING', deliverAfter: { lte: now }, expiresAt: { gt: now }, attemptCount: { lt: 8 },
  }, orderBy: [{ deliverAfter: 'asc' }, { id: 'asc' }], take: RECEIPT_LIMIT,
  select: { id: true, customerAccountId: true, trustedDeviceId: true, membershipId: true, homeId: true, idempotencyKey: true, attemptCount: true, expiresAt: true } });
  const config = Object.hasOwn(dependencies, 'config') ? dependencies.config ?? null : readApnsConfig();
  const send = dependencies.send ?? sendTenantAutomationFailurePush;
  for (const receipt of receipts) {
    const match = /^automation-failure:([0-9a-f-]{36}):([0-9a-f]{64}):([0-9a-f-]{36})$/i.exec(receipt.idempotencyKey);
    if (!match || match[3] !== receipt.trustedDeviceId || !receipt.membershipId || !receipt.trustedDeviceId) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { status: 'SUPPRESSED', lastErrorCode: 'INVALID_REFERENCE' } });
      counts.suppressed += 1;
      continue;
    }
    const automation = await prisma.nativeAutomation.findFirst({ where: {
      id: match[1], homeId: receipt.homeId, createdByMembershipId: receipt.membershipId, status: { not: 'RETIRED' },
    }, select: { id: true } });
    const membership = automation && await prisma.homeMembership.findFirst({ where: {
      id: receipt.membershipId, homeId: receipt.homeId, customerAccountId: receipt.customerAccountId, role: 'TENANT', status: 'ACTIVE',
      customerAccount: { status: 'ACTIVE' },
    }, select: { id: true, preferences: { where: { kind: { in: ['NOTIFICATION_PREFERENCES', 'QUIET_HOURS'] } }, select: { kind: true, document: true } } } });
    const preferences = membership?.preferences.find((row) => row.kind === 'NOTIFICATION_PREFERENCES')?.document;
    if (!automation || !membership || !preferences || typeof preferences !== 'object' || Array.isArray(preferences)
      || !Array.isArray((preferences as Record<string, unknown>).enabledFamilies)
      || !(preferences as { enabledFamilies: unknown[] }).enabledFamilies.includes('automation_failure_or_skipped_run')) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { status: 'SUPPRESSED', lastErrorCode: 'NO_CURRENT_OPT_IN' } });
      counts.suppressed += 1;
      continue;
    }
    const quietHours = membership.preferences.find((row) => row.kind === 'QUIET_HOURS')?.document;
    const deliverAfter = nextAllowedAutomationNotificationAt(now, quietHours);
    if (!deliverAfter) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { status: 'SUPPRESSED', lastErrorCode: 'INVALID_QUIET_HOURS' } });
      counts.suppressed += 1;
      continue;
    }
    if (deliverAfter.getTime() > now.getTime()) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { deliverAfter } });
      counts.deferred += 1;
      continue;
    }
    if (!config && !dependencies.send) { counts.deferred += 1; continue; }
    const device = await prisma.trustedDevice.findFirst({ where: {
      id: receipt.trustedDeviceId, customerAccountId: receipt.customerAccountId, revokedAt: null,
      pushEnabledAt: { not: null }, pushRevokedAt: null, apnsTokenCiphertext: { not: null }, apnsTokenDigest: { not: null },
      apnsEnvironment: { not: null }, apnsKeyVersion: 1,
    }, select: { id: true, apnsTokenCiphertext: true, apnsTokenDigest: true, apnsEnvironment: true, apnsTokenRevision: true } });
    let token = '';
    if (device?.apnsTokenCiphertext) {
      getPlatformDataEncryptionKey();
      try { token = decryptPlatformEnvelope(device.apnsTokenCiphertext); }
      catch (error) {
        if (error instanceof PlatformDataEncryptionKeyError) throw error;
        token = '';
      }
    }
    if (!device || !device.apnsEnvironment || !device.apnsTokenCiphertext || !device.apnsTokenDigest || !isAutomationFailureDeviceToken(token)) {
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount }, data: { status: 'SUPPRESSED', lastErrorCode: 'NO_CURRENT_PUSH_AUTHORITY' } });
      counts.suppressed += 1;
      continue;
    }
    const claimed = await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount, deliverAfter: { lte: now }, expiresAt: { gt: now } }, data: { attemptCount: { increment: 1 } } });
    if (claimed.count !== 1) continue;
    let result: ApnsResult;
    try { result = await send({ config: config!, environment: device.apnsEnvironment as ApnsEnvironment, deviceToken: token, requestId: receipt.id, expiresAt: receipt.expiresAt }); }
    catch { result = { outcome: 'RETRY' }; }
    const attempt = receipt.attemptCount + 1;
    if (result.outcome === 'INVALID_TOKEN') {
      await prisma.$transaction(async (tx) => {
        await tx.trustedDevice.updateMany({ where: { id: device.id, customerAccountId: receipt.customerAccountId, revokedAt: null, apnsTokenDigest: device.apnsTokenDigest, apnsTokenRevision: device.apnsTokenRevision }, data: {
          apnsTokenCiphertext: null, apnsTokenDigest: null, apnsEnvironment: null, apnsKeyVersion: null,
          apnsTokenRevision: { increment: 1 }, pushEnabledAt: null, pushRevokedAt: now, lastDeliveryHealth: 'INVALID_TOKEN',
        } });
        await tx.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: attempt }, data: { status: 'SUPPRESSED', lastErrorCode: 'APNS_TOKEN_INVALID' } });
      });
      counts.suppressed += 1;
    } else if (result.outcome === 'ACCEPTED') {
      await prisma.$transaction(async (tx) => {
        await tx.trustedDevice.updateMany({ where: { id: device.id, customerAccountId: receipt.customerAccountId, revokedAt: null, apnsTokenDigest: device.apnsTokenDigest, apnsTokenRevision: device.apnsTokenRevision }, data: { lastDeliveryHealth: 'APNS_ACCEPTED' } });
        await tx.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: attempt }, data: { status: 'SENT', lastErrorCode: null } });
      });
      counts.accepted += 1;
    } else {
      const terminal = result.outcome === 'FAILED' || attempt >= 8;
      await prisma.nativeNotificationDeliveryReceipt.updateMany({ where: { id: receipt.id, status: 'PENDING', attemptCount: attempt }, data: {
        status: terminal ? 'FAILED' : 'PENDING', deliverAfter: terminal ? now : nextAttempt(now, attempt),
        lastErrorCode: result.outcome === 'FAILED' ? 'APNS_REJECTED' : terminal ? 'APNS_RETRY_EXHAUSTED' : 'APNS_TEMPORARY_FAILURE',
      } });
      if (terminal) counts.failed += 1; else counts.deferred += 1;
    }
  }
  return counts;
}
