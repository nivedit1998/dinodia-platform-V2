import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { prisma } from './prisma';
import { decryptPlatformEnvelope } from './hubOperatorCredentials';
import { readApnsConfig, sendInstallationCompletePush, type ApnsConfig, type ApnsEnvironment, type ApnsResult } from './apnsDelivery';

const PORTAL_QUEUE = 'https://dinodia-platform-v2.vercel.app/installer/installation-requests';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OUTBOX_LIMIT = 20;
const RECEIPT_LIMIT = 20;

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

async function sendTextEmail(client: SESv2Client, source: string, recipient: string, subject: string, body: string): Promise<boolean> {
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [recipient] },
      Content: { Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: body, Charset: 'UTF-8' } },
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
  const counts = { accepted: 0, deferred: 0, failed: 0, suppressed: 0 };
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
    const claimed = await prisma.nativeNotificationDeliveryReceipt.updateMany({
      where: { id: receipt.id, status: 'PENDING', attemptCount: receipt.attemptCount, deliverAfter: { lte: now }, expiresAt: { gt: now } },
      data: { attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    let deviceToken: string;
    try { deviceToken = decryptPlatformEnvelope(device.apnsTokenCiphertext); }
    catch {
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
  configured?.client.destroy();
  return counts;
}
