import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type AreaAccessRequestStatus } from '@prisma/client';
import { prisma } from './prisma';
import { randomSecret, sha256 } from './stage1Crypto';
import { Stage1AuthError, type CustomerAccountSessionPrincipal } from './stage1Auth';
import { currentCustomerPolicy } from './customerPolicyConfig';
import { serializableTransaction } from './serializableTransaction';
import { enforcePersistentRateLimit } from './rateLimit';
import { sendRoomAccessVerificationCode } from './customerAuthEmail';
import { sendCustomerInvitationEmail } from './customerInvitationEmail';
import { hashPassword } from './passwords';

type Tx = Prisma.TransactionClient;
const REQUEST_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MS = 30 * 24 * 60 * 60 * 1000;

function iso(value: Date): string { return value.toISOString(); }
function keyDigest(accountId: string, key: string): string { return sha256(`${accountId}\n${key}`); }
function bodyDigest(value: unknown): string { return sha256(JSON.stringify(value)); }
function emailPepper(): string {
  const value = String(process.env.CLAIM_REFERENCE_PEPPER ?? '').trim();
  if (value.length < 32) throw new Stage1AuthError(503, 'INTERNAL_ERROR', 'Room email verification is unavailable');
  return value;
}
function privateDigest(domain: string, value: string): string {
  return createHmac('sha256', emailPepper()).update(`${domain}\n${value}`, 'utf8').digest('hex');
}
function normalizedEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim().normalize('NFKC').toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 320 ? email : '';
}

async function replay(tx: Tx, namespace: string, accountId: string, key: string, requestHash: string) {
  const saved = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash: keyDigest(accountId, key) } }, select: { actorId: true, requestHash: true, responseBody: true, expiresAt: true } });
  if (!saved) return null;
  if (saved.actorId !== accountId || saved.requestHash !== requestHash || saved.expiresAt <= new Date() || !saved.responseBody) {
    throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different or expired action');
  }
  return saved.responseBody as Record<string, unknown>;
}

async function remember(tx: Tx, input: { namespace: string; accountId: string; homeId: string; key: string; requestHash: string; body: Record<string, unknown>; status: number; now: Date }) {
  await tx.idempotencyRecord.create({ data: {
    namespace: input.namespace, keyHash: keyDigest(input.accountId, input.key), actorId: input.accountId,
    homeId: input.homeId, requestHash: input.requestHash, responseStatus: input.status,
    responseBody: input.body as Prisma.InputJsonValue, responseDigest: bodyDigest(input.body),
    expiresAt: new Date(input.now.getTime() + IDEMPOTENCY_MS),
  } });
}

async function resolveRoomQr(reference: string, tx: Tx = prisma) {
  const qr = await tx.areaQrCredential.findUnique({ where: { resolverHash: sha256(reference) }, select: {
    id: true, areaId: true, generation: true, status: true,
    area: { select: { id: true, originalName: true, status: true, homeId: true,
      home: { select: { id: true, lifecycle: true, installationStatus: true, postcode: true } } } },
  } });
  if (!qr || qr.area.id !== qr.areaId || qr.area.home.id !== qr.area.homeId) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Room QR is not available');
  return qr;
}

async function lockAndRevalidateAccountSession(tx: Tx, principal: CustomerAccountSessionPrincipal) {
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${principal.trustedDeviceId}::uuid FOR UPDATE`;
  const now = new Date();
  const [account, session, device] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, securityVersion: true, emailNormalized: true } }),
    tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, sessionFamilyId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
    tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
  ]);
  const exactCredential = principal.credentialKind === 'access'
    ? Boolean(principal.accessTokenHash && principal.accessTokenHash === session?.accessTokenHash && session?.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
    : principal.refreshTokenHash === session?.refreshTokenHash;
  if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword
    || account.securityVersion !== principal.securityVersion || account.emailNormalized !== principal.email.trim().toLowerCase()
    || !session || session.customerAccountId !== account.id || session.trustedDeviceId !== principal.trustedDeviceId
    || !exactCredential || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== principal.trustedDeviceSessionVersion
    || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
    || !device || device.customerAccountId !== account.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion) {
    throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
  }
  const policy = currentCustomerPolicy();
  if (!policy) throw new Stage1AuthError(503, 'policy_unavailable', 'The approved customer policy is not configured');
  const acceptance = await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: account.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } }, select: { id: true } });
  if (!acceptance) throw new Stage1AuthError(403, 'customer_policy_acceptance_required', 'Accept the current Dinodia policy before continuing');
  return { account, session, device, now };
}

export async function previewCustomerRoomQr(reference: string) {
  const qr = await resolveRoomQr(reference);
  if (qr.status !== 'ACTIVE' || qr.area.status !== 'ACTIVE') throw new Stage1AuthError(410, 'TOKEN_EXPIRED', 'This Room QR has been replaced or disabled');
  if (qr.area.home.lifecycle !== 'ACTIVE' || qr.area.home.installationStatus !== 'COMPLETE') {
    throw new Stage1AuthError(409, 'ROOM_ACCESS_HOME_NOT_READY', 'This property is not accepting Room access requests yet. Contact the person who shared this QR.');
  }
  const hasOwner = await prisma.homeMembership.findFirst({ where: { homeId: qr.area.home.id, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } });
  if (!hasOwner) throw new Stage1AuthError(409, 'ROOM_ACCESS_HOME_NOT_READY', 'This property is not accepting Room access requests yet. Contact the person who shared this QR.');
  return { schemaVersion: 'dinodia.v1' as const, ok: true as const, state: 'AVAILABLE' as const,
    areaLabel: qr.area.originalName, qrGeneration: qr.generation, requestValiditySeconds: REQUEST_MS / 1000 };
}

export async function beginProspectiveRoomAccess(input: { reference: unknown; expectedGeneration: unknown; email: unknown; idempotencyKey: unknown }) {
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  const email = normalizedEmail(input.email);
  const generation = Number(input.expectedGeneration);
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '';
  if (!/^dno_room_[A-Za-z0-9_-]{40,64}$/.test(reference) || !email || !Number.isSafeInteger(generation) || generation < 1
    || !/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Enter a valid email and scan a current Dinodia Room QR');
  }
  const preview = await previewCustomerRoomQr(reference);
  if (preview.qrGeneration !== generation) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room QR changed. Scan the current QR and retry.');
  const emailHash = privateDigest('room-access-requester-v1', email);
  const idempotencyKeyHash = privateDigest('room-access-idempotency-v1', idempotencyKey);
  const requestHash = bodyDigest({ qrReferenceHash: sha256(reference), generation, emailHash });
  await enforcePersistentRateLimit(`room-qr-email:${emailHash}`, 3, 60 * 60 * 1000);
  const qrInitial = await resolveRoomQr(reference);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AreaQrCredential" WHERE "id" = ${qrInitial.id}::uuid FOR UPDATE`;
    const now = new Date();
    const qr = await resolveRoomQr(reference, tx);
    if (qr.status !== 'ACTIVE' || qr.generation !== generation || qr.area.status !== 'ACTIVE'
      || qr.area.home.lifecycle !== 'ACTIVE' || qr.area.home.installationStatus !== 'COMPLETE') {
      throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room QR is no longer current');
    }
    const owner = await tx.homeMembership.findFirst({ where: { homeId: qr.area.home.id, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } });
    if (!owner) throw new Stage1AuthError(409, 'ROOM_ACCESS_HOME_NOT_READY', 'This property is not accepting Room access requests yet. Contact the person who shared this QR.');
    const priorKey = await tx.roomAccessEmailAttempt.findUnique({ where: { idempotencyKeyHash } });
    if (priorKey) {
      if (priorKey.requestHash !== requestHash) throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This Room request key was already used for a different request');
      const canonical = priorKey.coalescedIntoId
        ? await tx.roomAccessEmailAttempt.findUnique({ where: { id: priorKey.coalescedIntoId } })
        : priorKey;
      if (!canonical || canonical.expiresAt <= now && canonical.state !== 'VERIFIED') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room email attempt expired. Scan the current QR and start again.');
      if (canonical.state === 'VERIFIED' && canonical.areaAccessRequestId) {
        const request = await tx.areaAccessRequest.findUnique({ where: { id: canonical.areaAccessRequestId }, select: { id: true, expiresAt: true, updatedAt: true, status: true } });
        if (!request || request.status !== 'PENDING' || request.expiresAt <= now) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request is no longer pending');
        return { kind: 'ALREADY_PENDING' as const, requestId: request.id, expiresAt: request.expiresAt, revision: request.updatedAt };
      }
      const pendingChallenge = await tx.authChallenge.findFirst({ where: { targetResourceId: canonical.id, purpose: 'ROOM_ACCESS_REQUEST', consumedAt: null, revokedAt: null, expiresAt: { gt: now }, deliveryStatus: { in: ['PENDING', 'ACCEPTED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, expiresAt: true, deliveryStatus: true } });
      if (pendingChallenge) return { kind: 'CHALLENGE_EXISTS' as const, requestId: canonical.id, challengeId: pendingChallenge.id, expiresAt: pendingChallenge.expiresAt, emailSubmission: pendingChallenge.deliveryStatus };
    }

    const existingVerified = await tx.areaAccessRequest.findFirst({ where: {
      areaId: qr.areaId, homeId: qr.area.home.id, requesterEmailHash: emailHash, emailVerifiedAt: { not: null },
      status: 'PENDING', expiresAt: { gt: now },
    }, orderBy: { createdAt: 'desc' }, select: { id: true, expiresAt: true, updatedAt: true } });
    if (existingVerified) {
      const linked = await tx.roomAccessEmailAttempt.findUnique({ where: { areaAccessRequestId: existingVerified.id } });
      const canonical = linked ?? await tx.roomAccessEmailAttempt.create({ data: { areaQrCredentialId: qr.id, areaId: qr.areaId, homeId: qr.area.home.id, qrGeneration: qr.generation, requesterEmailNormalized: null, requesterEmailHash: emailHash, idempotencyKeyHash, requestHash, state: 'VERIFIED', expiresAt: existingVerified.expiresAt, verifiedAt: now, areaAccessRequestId: existingVerified.id } });
      if (linked) await tx.roomAccessEmailAttempt.create({ data: { areaQrCredentialId: qr.id, areaId: qr.areaId, homeId: qr.area.home.id, qrGeneration: qr.generation, requesterEmailNormalized: null, requesterEmailHash: emailHash, idempotencyKeyHash, requestHash, state: 'COALESCED', expiresAt: canonical.expiresAt, coalescedIntoId: canonical.id } });
      return { kind: 'ALREADY_PENDING' as const, requestId: existingVerified.id, expiresAt: existingVerified.expiresAt, revision: existingVerified.updatedAt };
    }

    // A verification attempt is bound to the exact QR generation that was
    // scanned. A request from an older/rotated label must never satisfy a new
    // QR submission, even when the canonical Area and email are unchanged.
    let attempt = await tx.roomAccessEmailAttempt.findFirst({ where: {
      areaQrCredentialId: qr.id, qrGeneration: qr.generation, areaId: qr.areaId,
      homeId: qr.area.home.id, requesterEmailHash: emailHash, state: 'PENDING',
      coalescedIntoId: null, expiresAt: { gt: now },
    }, orderBy: { createdAt: 'desc' } });
    if (attempt && attempt.idempotencyKeyHash !== idempotencyKeyHash) {
      await tx.roomAccessEmailAttempt.create({ data: { areaQrCredentialId: qr.id, areaId: qr.areaId, homeId: qr.area.home.id, qrGeneration: qr.generation, requesterEmailNormalized: null, requesterEmailHash: emailHash, idempotencyKeyHash, requestHash, state: 'COALESCED', expiresAt: attempt.expiresAt, coalescedIntoId: attempt.id } });
    }
    if (!attempt) {
      attempt = await tx.roomAccessEmailAttempt.create({ data: { areaQrCredentialId: qr.id, areaId: qr.areaId, homeId: qr.area.home.id, qrGeneration: qr.generation, requesterEmailNormalized: email, requesterEmailHash: emailHash, idempotencyKeyHash, requestHash, state: 'PENDING', expiresAt: new Date(now.getTime() + 10 * 60 * 1000) } });
    }
    const currentChallenge = await tx.authChallenge.findFirst({ where: { targetResourceId: attempt.id, purpose: 'ROOM_ACCESS_REQUEST', consumedAt: null, revokedAt: null, expiresAt: { gt: now }, deliveryStatus: { in: ['PENDING', 'ACCEPTED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, expiresAt: true, deliveryStatus: true } });
    if (currentChallenge) return { kind: 'CHALLENGE_EXISTS' as const, requestId: attempt.id, challengeId: currentChallenge.id, expiresAt: currentChallenge.expiresAt, emailSubmission: currentChallenge.deliveryStatus };
    await tx.authChallenge.updateMany({ where: { targetResourceId: attempt.id, purpose: 'ROOM_ACCESS_REQUEST', consumedAt: null, revokedAt: null }, data: { revokedAt: now, targetEmail: null } });
    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challengeExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    await tx.authChallenge.create({ data: {
      id: challengeId, customerAccountId: null, purpose: 'ROOM_ACCESS_REQUEST', targetEmail: email,
      targetResourceId: attempt.id, tokenHash: privateDigest('room-access-code-v1', `${challengeId}:${code}`),
      expiresAt: challengeExpiresAt, deliveryStatus: 'PENDING',
    } });
    return { kind: 'SEND' as const, requestId: attempt.id, challengeId, code, expiresAt: challengeExpiresAt };
  }, { isolationLevel: 'ReadCommitted' });

  if (result.kind === 'ALREADY_PENDING') return { schemaVersion: 'dinodia.v1' as const, ok: true as const, state: 'PENDING' as const, requestId: result.requestId, expiresAt: iso(result.expiresAt), revision: iso(result.revision), emailSubmission: 'NOT_REQUIRED' as const, idempotentReplay: true };
  if (result.kind === 'CHALLENGE_EXISTS') return { schemaVersion: 'dinodia.v1' as const, ok: true as const, state: 'VERIFY_EMAIL' as const, requestId: result.requestId, challengeId: result.challengeId, expiresAt: iso(result.expiresAt), emailSubmission: result.emailSubmission, idempotentReplay: true };
  try {
    await sendRoomAccessVerificationCode({ email, code: result.code, expiresAt: result.expiresAt });
    await prisma.authChallenge.update({ where: { id: result.challengeId }, data: { deliveryStatus: 'ACCEPTED', deliveryAttemptedAt: new Date() } });
    return { schemaVersion: 'dinodia.v1' as const, ok: true as const, state: 'VERIFY_EMAIL' as const, requestId: result.requestId, challengeId: result.challengeId, expiresAt: iso(result.expiresAt), emailSubmission: 'ACCEPTED' as const, idempotentReplay: false };
  } catch {
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.authChallenge.updateMany({ where: { id: result.challengeId, consumedAt: null }, data: { deliveryStatus: 'FAILED', deliveryAttemptedAt: now, revokedAt: now, targetEmail: null } });
      await tx.roomAccessEmailAttempt.updateMany({ where: { id: result.requestId, state: 'PENDING' }, data: { state: 'EXPIRED', expiresAt: now, requesterEmailNormalized: null } });
    });
    throw new Stage1AuthError(503, 'INTERNAL_ERROR', 'The verification email could not be submitted. Scan the current Room QR to try again.');
  }
}

export async function verifyProspectiveRoomAccess(input: { requestId: unknown; challengeId: unknown; code: unknown }) {
  const requestId = typeof input.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(input.requestId) ? input.requestId : '';
  const challengeId = typeof input.challengeId === 'string' && /^[0-9a-f-]{36}$/i.test(input.challengeId) ? input.challengeId : '';
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!requestId || !challengeId || !/^\d{6}$/.test(code)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Enter the six-digit Room email verification code');
  await enforcePersistentRateLimit(`room-qr-verify:${sha256(challengeId)}`, 5, 10 * 60 * 1000);
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AuthChallenge" WHERE "id" = ${challengeId}::uuid FOR UPDATE`;
    const attemptIdentity = await tx.roomAccessEmailAttempt.findUnique({ where: { id: requestId }, select: { id: true, areaQrCredentialId: true, areaId: true, homeId: true } });
    if (!attemptIdentity) return { kind: 'DENIED' as const };
    await tx.$queryRaw`SELECT "id" FROM "RoomAccessEmailAttempt" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AreaQrCredential" WHERE "id" = ${attemptIdentity.areaQrCredentialId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${attemptIdentity.homeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Area" WHERE "id" = ${attemptIdentity.areaId}::uuid FOR UPDATE`;
    const now = new Date();
    const [challenge, roomRequest] = await Promise.all([
      tx.authChallenge.findUnique({ where: { id: challengeId }, select: { id: true, purpose: true, targetEmail: true, targetResourceId: true, tokenHash: true, expiresAt: true, consumedAt: true, revokedAt: true, attemptCount: true, deliveryStatus: true } }),
      tx.roomAccessEmailAttempt.findUnique({ where: { id: requestId }, select: { id: true, requesterEmailNormalized: true, requesterEmailHash: true, areaId: true, homeId: true, areaQrCredentialId: true, qrGeneration: true, state: true, expiresAt: true, verifiedAt: true, areaAccessRequestId: true } }),
    ]);
    if (!challenge || challenge.purpose !== 'ROOM_ACCESS_REQUEST' || challenge.targetResourceId !== requestId || challenge.deliveryStatus !== 'ACCEPTED' || challenge.revokedAt) return { kind: 'DENIED' as const };
    const presented = Buffer.from(privateDigest('room-access-code-v1', `${challengeId}:${code}`), 'hex');
    const expected = Buffer.from(challenge.tokenHash, 'hex');
    const matches = expected.length === presented.length && timingSafeEqual(expected, presented);
    if (!matches) {
      const attempts = challenge.attemptCount + 1;
      await tx.authChallenge.update({ where: { id: challengeId }, data: { attemptCount: attempts, ...(attempts >= 5 ? { revokedAt: now, targetEmail: null } : {}) } });
      if (attempts >= 5) await tx.roomAccessEmailAttempt.updateMany({ where: { id: requestId, state: 'PENDING' }, data: { state: 'EXPIRED', expiresAt: now, requesterEmailNormalized: null } });
      return { kind: 'DENIED' as const };
    }
    if (challenge.consumedAt) {
      if (roomRequest?.state !== 'VERIFIED' || !roomRequest.areaAccessRequestId) return { kind: 'DENIED' as const };
      const existing = await tx.areaAccessRequest.findUnique({ where: { id: roomRequest.areaAccessRequestId }, select: { id: true, status: true, expiresAt: true, updatedAt: true } });
      if (!existing || existing.status !== 'PENDING' || existing.expiresAt <= now) return { kind: 'DENIED' as const };
      return { kind: 'VERIFIED' as const, requestId: existing.id, expiresAt: existing.expiresAt, revision: existing.updatedAt, replay: true };
    }
    if (!roomRequest || roomRequest.state !== 'PENDING' || roomRequest.requesterEmailNormalized !== challenge.targetEmail
      || !roomRequest.requesterEmailHash || roomRequest.expiresAt <= now || challenge.expiresAt <= now) {
      if (roomRequest?.state === 'PENDING') await tx.roomAccessEmailAttempt.update({ where: { id: requestId }, data: { state: 'EXPIRED', expiresAt: now, requesterEmailNormalized: null } });
      return { kind: 'DENIED' as const };
    }
    const currentQr = await resolveRoomQrById(tx, roomRequest.areaQrCredentialId);
    if (!currentQr || currentQr.id !== roomRequest.areaQrCredentialId || currentQr.generation !== roomRequest.qrGeneration || currentQr.areaId !== roomRequest.areaId || currentQr.area.home.id !== roomRequest.homeId
      || currentQr.status !== 'ACTIVE' || currentQr.area.status !== 'ACTIVE' || currentQr.area.home.lifecycle !== 'ACTIVE' || currentQr.area.home.installationStatus !== 'COMPLETE') {
      await tx.authChallenge.updateMany({ where: { id: challengeId, consumedAt: null, revokedAt: null }, data: { revokedAt: now, targetEmail: null } });
      await tx.roomAccessEmailAttempt.updateMany({ where: { id: requestId, state: 'PENDING' }, data: { state: 'EXPIRED', expiresAt: now, requesterEmailNormalized: null } });
      return { kind: 'DENIED' as const };
    }
    const owner = await tx.homeMembership.findFirst({ where: { homeId: roomRequest.homeId, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } });
    if (!owner) {
      await tx.authChallenge.updateMany({ where: { id: challengeId, consumedAt: null, revokedAt: null }, data: { revokedAt: now, targetEmail: null } });
      await tx.roomAccessEmailAttempt.updateMany({ where: { id: requestId, state: 'PENDING' }, data: { state: 'EXPIRED', expiresAt: now, requesterEmailNormalized: null } });
      return { kind: 'DENIED' as const };
    }
    const verifiedEmail = roomRequest.requesterEmailNormalized;
    if (!verifiedEmail) return { kind: 'DENIED' as const };
    const existingAccount = await tx.customerAccount.findUnique({ where: { emailNormalized: verifiedEmail }, select: { id: true, status: true, emailVerifiedAt: true } });
    const verifiedAccountId = existingAccount?.status === 'ACTIVE' && existingAccount.emailVerifiedAt ? existingAccount.id : null;
    const accessRequest = await tx.areaAccessRequest.create({ data: {
      areaQrCredentialId: currentQr.id, areaId: roomRequest.areaId, homeId: roomRequest.homeId,
      ...(verifiedAccountId ? { requesterAccountId: verifiedAccountId } : {}),
      requesterEmailNormalized: verifiedEmail, requesterEmailHash: roomRequest.requesterEmailHash,
      emailVerifiedAt: now, status: 'PENDING', expiresAt: new Date(now.getTime() + REQUEST_MS),
    }, select: { id: true, expiresAt: true, updatedAt: true } });
    const changed = await tx.roomAccessEmailAttempt.updateMany({ where: { id: requestId, state: 'PENDING', expiresAt: { gt: now }, verifiedAt: null }, data: { state: 'VERIFIED', verifiedAt: now, areaAccessRequestId: accessRequest.id, requesterEmailNormalized: null } });
    if (changed.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room email attempt changed. Scan the current QR and retry.');
    await tx.authChallenge.update({ where: { id: challengeId }, data: { consumedAt: now, approvedAt: now, targetEmail: null } });
    await tx.auditEvent.create({ data: { homeId: roomRequest.homeId, actorType: 'CUSTOMER', actorId: null, category: 'ACCESS', action: 'room_access_email_verified', targetType: 'AreaAccessRequest', targetId: accessRequest.id, metadata: { areaId: roomRequest.areaId }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return { kind: 'VERIFIED' as const, requestId: accessRequest.id, expiresAt: accessRequest.expiresAt, revision: accessRequest.updatedAt, replay: false };
  });
  if (outcome.kind !== 'VERIFIED') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The code is invalid, expired or the Room QR changed');
  return { schemaVersion: 'dinodia.v1' as const, ok: true as const, state: 'PENDING' as const, requestId: outcome.requestId, expiresAt: iso(outcome.expiresAt), revision: iso(outcome.revision), idempotentReplay: outcome.replay };
}

async function resolveRoomQrById(tx: Tx, credentialId: string) {
  return tx.areaQrCredential.findUnique({ where: { id: credentialId }, select: { id: true, areaId: true, generation: true, status: true, area: { select: { id: true, status: true, homeId: true, home: { select: { id: true, lifecycle: true, installationStatus: true } } } } } });
}

export async function requestCustomerRoomAccess(input: {
  reference: string; expectedGeneration: number; idempotencyKey: string; customer: CustomerAccountSessionPrincipal;
}) {
  const found = await resolveRoomQr(input.reference);
  const namespace = 'customer-room-access-request:v1';
  const requestHash = bodyDigest({ referenceHash: sha256(input.reference), generation: input.expectedGeneration, accountId: input.customer.id });
  return prisma.$transaction(async (tx) => {
    // Account-row locking serializes this account's scans. READ COMMITTED is
    // deliberate here: after a queued caller acquires the lock, its next read
    // must see the previous commit so it coalesces instead of creating a
    // second pending request from a stale serializable snapshot.
    await lockAndRevalidateAccountSession(tx, input.customer);
    await tx.$queryRaw`SELECT "id" FROM "AreaQrCredential" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
    const old = await replay(tx, namespace, input.customer.id, input.idempotencyKey, requestHash);
    if (old) return { ...old, idempotentReplay: true };
    const now = new Date();
    const [account, qr] = await Promise.all([
      tx.customerAccount.findUnique({ where: { id: input.customer.id }, select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, emailNormalized: true } }),
      resolveRoomQr(input.reference, tx),
    ]);
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword
      || account.emailNormalized !== input.customer.email.trim().toLowerCase()) throw new Stage1AuthError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email before requesting Room access');
    if (qr.status !== 'ACTIVE' || qr.generation !== input.expectedGeneration || qr.area.status !== 'ACTIVE') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room QR changed. Scan the current QR and retry.');
    if (qr.area.home.lifecycle !== 'ACTIVE' || qr.area.home.installationStatus !== 'COMPLETE') throw new Stage1AuthError(409, 'ROOM_ACCESS_HOME_NOT_READY', 'This property is not accepting Room access requests yet. Contact the person who shared this QR.');
    const owner = await tx.homeMembership.findFirst({ where: { homeId: qr.area.home.id, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } });
    if (!owner) throw new Stage1AuthError(409, 'ROOM_ACCESS_HOME_NOT_READY', 'This property is not accepting Room access requests yet. Contact the person who shared this QR.');
    const existingMembership = await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: account.id, homeId: qr.area.home.id } }, select: { id: true, role: true, status: true } });
    if (existingMembership?.status === 'ACTIVE' && existingMembership.role !== 'TENANT') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This account already has management access to this property');
    if (existingMembership?.status === 'ACTIVE' && existingMembership.role === 'TENANT') {
      const grant = await tx.tenantAreaGrant.findFirst({ where: { membershipId: existingMembership.id, areaId: qr.areaId, homeId: qr.area.home.id, revokedAt: null }, select: { id: true } });
      if (grant) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This account already has access to this Area');
    }
    const prior = await tx.areaAccessRequest.findFirst({ where: { requesterAccountId: account.id, homeId: qr.area.home.id, areaId: qr.areaId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, select: { id: true, expiresAt: true, updatedAt: true } });
    let requestId: string;
    let expiresAt: Date;
    let revision: Date;
    let coalesced = false;
    if (prior && prior.expiresAt > now) {
      requestId = prior.id; expiresAt = prior.expiresAt; revision = prior.updatedAt; coalesced = true;
    } else {
      if (prior) await tx.areaAccessRequest.update({ where: { id: prior.id }, data: { status: 'EXPIRED' } });
      const created = await tx.areaAccessRequest.create({ data: {
        areaQrCredentialId: qr.id, areaId: qr.areaId, homeId: qr.area.home.id, requesterAccountId: account.id,
        requesterEmailNormalized: account.emailNormalized, requesterEmailHash: privateDigest('room-access-requester-v1', account.emailNormalized),
        emailVerifiedAt: account.emailVerifiedAt, status: 'PENDING', expiresAt: new Date(now.getTime() + REQUEST_MS),
      }, select: { id: true, expiresAt: true, updatedAt: true } });
      requestId = created.id; expiresAt = created.expiresAt; revision = created.updatedAt;
    }
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, requestId, areaLabel: qr.area.originalName, state: 'PENDING', expiresAt: iso(expiresAt), revision: iso(revision), coalesced, idempotentReplay: false };
    await remember(tx, { namespace, accountId: account.id, homeId: qr.area.home.id, key: input.idempotencyKey, requestHash, body: receipt, status: coalesced ? 200 : 201, now });
    if (!coalesced) await tx.auditEvent.create({ data: { homeId: qr.area.home.id, actorType: 'CUSTOMER', actorId: account.id, category: 'ACCESS', action: 'room_access_requested', targetType: 'AreaAccessRequest', targetId: requestId, metadata: { areaId: qr.areaId, qrGeneration: qr.generation }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return receipt;
  }, { isolationLevel: 'ReadCommitted' });
}

export async function readCustomerRoomAccessRequest(requestId: string, accountId: string) {
  const request = await prisma.areaAccessRequest.findFirst({ where: { id: requestId, requesterAccountId: accountId }, select: {
    id: true, areaId: true, homeId: true, status: true, createdAt: true, expiresAt: true, updatedAt: true, cancelledAt: true,
    area: { select: { originalName: true } },
  } });
  if (!request) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Room access request is not available');
  const expired = request.status === 'PENDING' && request.expiresAt <= new Date();
  const state = expired ? 'EXPIRED' : request.status;
  return { schemaVersion: 'dinodia.v1' as const, ok: true as const, requestId: request.id,
    state, areaLabel: request.area.originalName, createdAt: iso(request.createdAt), expiresAt: iso(request.expiresAt),
    revision: iso(request.updatedAt), allowedActions: state === 'PENDING' ? ['VIEW_STATUS', 'CANCEL'] as const : ['VIEW_STATUS'] as const };
}

export async function cancelCustomerRoomAccessRequest(input: { requestId: string; customer: CustomerAccountSessionPrincipal; expectedRevision: string; idempotencyKey: string }) {
  const namespace = 'customer-room-access-cancel:v1';
  const requestHash = bodyDigest({ requestId: input.requestId, expectedRevision: input.expectedRevision, decision: 'CANCEL', accountId: input.customer.id });
  return serializableTransaction(async (tx) => {
    await lockAndRevalidateAccountSession(tx, input.customer);
    await tx.$queryRaw`SELECT "id" FROM "AreaAccessRequest" WHERE "id" = ${input.requestId}::uuid FOR UPDATE`;
    const old = await replay(tx, namespace, input.customer.id, input.idempotencyKey, requestHash);
    if (old) return { ...old, idempotentReplay: true };
    const now = new Date();
    const request = await tx.areaAccessRequest.findUnique({ where: { id: input.requestId }, select: { id: true, homeId: true, areaId: true, requesterAccountId: true, status: true, expiresAt: true, updatedAt: true } });
    if (!request || request.requesterAccountId !== input.customer.id) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Room access request is not available');
    if (request.status !== 'PENDING' || request.expiresAt <= now) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request is no longer pending');
    if (iso(request.updatedAt) !== input.expectedRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request changed. Refresh its status and retry.');
    const changed = await tx.areaAccessRequest.updateMany({ where: { id: request.id, status: 'PENDING', updatedAt: request.updatedAt, expiresAt: { gt: now } }, data: { status: 'CANCELLED', cancelledAt: now } });
    if (changed.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request changed. Refresh its status and retry.');
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, requestId: request.id, state: 'CANCELLED', idempotentReplay: false };
    await remember(tx, { namespace, accountId: input.customer.id, homeId: request.homeId, key: input.idempotencyKey, requestHash, body: receipt, status: 200, now });
    await tx.auditEvent.create({ data: { homeId: request.homeId, actorType: 'CUSTOMER', actorId: input.customer.id, category: 'ACCESS', action: 'room_access_request_cancelled', targetType: 'AreaAccessRequest', targetId: request.id, metadata: { areaId: request.areaId }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return receipt;
  });
}

export async function listHomeRoomAccessRequests(input: { homeId: string; customer: CustomerAccountSessionPrincipal }) {
  return serializableTransaction(async (tx) => {
    await lockAndRevalidateAccountSession(tx, input.customer);
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR SHARE`;
    const membership = await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: input.customer.id, homeId: input.homeId } }, select: { id: true, role: true, status: true, home: { select: { lifecycle: true, installationStatus: true } } } });
    if (!membership || membership.status !== 'ACTIVE' || !['OWNER', 'PROPERTY_MANAGER'].includes(membership.role)
      || membership.home.lifecycle !== 'ACTIVE' || membership.home.installationStatus !== 'COMPLETE') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Room access requests are not available');
    const now = new Date();
    const rows = await tx.areaAccessRequest.findMany({ where: { homeId: input.homeId, status: 'PENDING', expiresAt: { gt: now }, area: { status: 'ACTIVE' }, qrCredential: { status: 'ACTIVE' }, OR: [{ requesterAccountId: { not: null } }, { emailVerifiedAt: { not: null } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
      select: { id: true, areaId: true, createdAt: true, expiresAt: true, updatedAt: true, requesterEmailNormalized: true, area: { select: { originalName: true } }, requester: { select: { displayName: true } } } });
    return rows.map((row) => ({ schemaVersion: 'dinodia.v1' as const, requestId: row.id, areaId: row.areaId,
      areaLabel: row.area.originalName, requesterLabel: row.requester?.displayName || (row.requesterEmailNormalized ? `Verified requester ${row.requesterEmailNormalized.replace(/^(.).+(@.+)$/, '$1•••$2')}` : 'Verified Dinodia customer'),
      createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt), revision: iso(row.updatedAt), allowedActions: ['APPROVE', 'REJECT'] as const }));
  });
}

export async function decideHomeRoomAccessRequest(input: { requestId: string; homeId: string; customer: CustomerAccountSessionPrincipal; decision: 'APPROVE'|'REJECT'; expectedRevision: string; idempotencyKey: string }) {
  const namespace = `home-room-access-decision:v1:${input.homeId}`;
  const requestHash = bodyDigest({ requestId: input.requestId, homeId: input.homeId, decision: input.decision, expectedRevision: input.expectedRevision, accountId: input.customer.id });
  const outcome = await serializableTransaction(async (tx) => {
    await lockAndRevalidateAccountSession(tx, input.customer);
    // The route passes the account ID after authenticating; a fresh membership
    // is re-read under the property lock below before any grant is written.
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AreaAccessRequest" WHERE "id" = ${input.requestId}::uuid FOR UPDATE`;
    const old = await replay(tx, namespace, input.customer.id, input.idempotencyKey, requestHash);
    if (old) return { receipt: { ...old, idempotentReplay: true }, delivery: undefined, remember: undefined };
    const now = new Date();
    const [membership, request] = await Promise.all([
      tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: input.customer.id, homeId: input.homeId } }, select: { id: true, role: true, status: true } }),
      tx.areaAccessRequest.findUnique({ where: { id: input.requestId }, select: { id: true, homeId: true, areaId: true, areaQrCredentialId: true, requesterAccountId: true, requesterEmailNormalized: true, emailVerifiedAt: true, onboardingInvitationId: true, onboardingEmailStatus: true, status: true, expiresAt: true, updatedAt: true,
        area: { select: { originalName: true, status: true } }, qrCredential: { select: { status: true, areaId: true } } } }),
    ]);
    if (!membership || membership.status !== 'ACTIVE' || !['OWNER', 'PROPERTY_MANAGER'].includes(membership.role)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Room access requests are not available');
    const home = await tx.home.findUnique({ where: { id: input.homeId }, select: { lifecycle: true, installationStatus: true, managementRevision: true } });
    if (!request || request.homeId !== input.homeId || home?.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Room access request is not available');
    if (request.status === (input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED')) {
      if (input.decision === 'APPROVE' && request.onboardingInvitationId && request.onboardingEmailStatus !== 'ACCEPTED') {
        const invitation = await tx.membershipInvitation.findUnique({ where: { id: request.onboardingInvitationId }, select: { id: true, targetEmail: true, targetAccountId: true, expiresAt: true, home: { select: { postcode: true } } } });
        if (!invitation) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The verified Room onboarding invitation is no longer available');
        const temporaryPassword = invitation.targetAccountId ? null : randomSecret(24);
        if (temporaryPassword) await tx.membershipInvitation.update({ where: { id: invitation.id }, data: { temporaryCredentialHash: hashPassword(temporaryPassword) } });
        return { receipt: { schemaVersion: 'dinodia.v1' as const, ok: true as const, requestId: request.id, state: 'APPROVED' as const, membershipId: null, idempotentReplay: true }, delivery: { invitationId: invitation.id, email: invitation.targetEmail, postcode: invitation.home.postcode ?? '', expiresAt: invitation.expiresAt, temporaryPassword }, remember: undefined };
      }
      const existingMembership = request.requesterAccountId
        ? await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: request.requesterAccountId, homeId: request.homeId } }, select: { id: true } })
        : null;
      return { receipt: { schemaVersion: 'dinodia.v1' as const, ok: true as const, requestId: request.id, state: request.status, membershipId: existingMembership?.id ?? null, idempotentReplay: true }, delivery: undefined, remember: undefined };
    }
    if (request.status !== 'PENDING' || request.expiresAt <= now || request.area.status !== 'ACTIVE' || request.qrCredential.status !== 'ACTIVE' || request.qrCredential.areaId !== request.areaId) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request is no longer eligible for a decision');
    if (iso(request.updatedAt) !== input.expectedRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request changed. Refresh and retry.');
    let membershipId: string | null = null;
    let requesterAccountId = request.requesterAccountId;
    let onboardingInvitationId: string | null = null;
    let delivery: { invitationId: string; email: string; postcode: string; expiresAt: Date; temporaryPassword: string | null } | undefined;
    if (input.decision === 'APPROVE') {
      if (!requesterAccountId && (!request.emailVerifiedAt || !request.requesterEmailNormalized)) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The requester email is not verified');
      let requester = requesterAccountId
        ? await tx.customerAccount.findUnique({ where: { id: requesterAccountId }, select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, emailNormalized: true } })
        : null;
      if (!requester && request.requesterEmailNormalized) {
        requester = await tx.customerAccount.findUnique({ where: { emailNormalized: request.requesterEmailNormalized }, select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, emailNormalized: true } });
      }
      const canGrantExistingAccount = Boolean(requester?.status === 'ACTIVE' && requester.emailVerifiedAt && !requester.mustChangePassword);
      if (canGrantExistingAccount && requester) requesterAccountId = requester.id;
      if (!canGrantExistingAccount) {
        const recipientEmail = request.requesterEmailNormalized;
        if (!recipientEmail) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The requester is not currently eligible for Room access');
        const temporaryPassword = requester ? null : randomSecret(24);
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const invitation = await tx.membershipInvitation.create({ data: {
          homeId: input.homeId, inviterMembershipId: membership.id, targetAccountId: requester?.id ?? null, targetEmail: recipientEmail, targetEmailNormalized: recipientEmail,
          role: 'TENANT', state: 'PENDING', tokenHash: sha256(randomSecret(32)), temporaryCredentialHash: temporaryPassword ? hashPassword(temporaryPassword) : null, expiresAt,
          areas: { create: [{ areaId: request.areaId, homeId: input.homeId }] },
        }, select: { id: true, expiresAt: true, home: { select: { postcode: true } } } });
        onboardingInvitationId = invitation.id;
        delivery = { invitationId: invitation.id, email: recipientEmail, postcode: invitation.home.postcode ?? '', expiresAt: invitation.expiresAt, temporaryPassword };
      }
      if (canGrantExistingAccount && requester) {
      const current = await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: requester.id, homeId: input.homeId } }, select: { id: true, role: true, status: true, accessRevision: true } });
      if (current?.status === 'ACTIVE' && current.role !== 'TENANT') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This requester already has a different relationship with the property');
      const homeChanged = await tx.home.updateMany({ where: { id: input.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
      if (homeChanged.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Property access changed. Refresh and retry.');
      const policyRevision = home.managementRevision + 1;
      const granted = current
        ? await tx.homeMembership.update({ where: { id: current.id }, data: {
          role: 'TENANT', status: 'ACTIVE', activatedAt: current.status === 'REMOVED' ? now : undefined,
          removedAt: null, removalReason: null, accessRevision: { increment: 1 },
        }, select: { id: true } })
        : await tx.homeMembership.create({ data: { customerAccountId: requester.id, homeId: input.homeId, role: 'TENANT', status: 'ACTIVE', activatedAt: now }, select: { id: true } });
      // An existing tenant may request one additional Area. Preserve every
      // previously granted Area; only a removed relationship's stale grants
      // are revoked before that person rejoins through this fresh request.
      if (current?.status === 'REMOVED') await tx.tenantAreaGrant.updateMany({ where: { membershipId: granted.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'room_access_rejoin', policyRevision } });
      await tx.tenantAreaGrant.upsert({ where: { membershipId_areaId: { membershipId: granted.id, areaId: request.areaId } }, create: { membershipId: granted.id, areaId: request.areaId, homeId: input.homeId, policyRevision, grantedAt: now }, update: { homeId: input.homeId, policyRevision, grantedAt: now, revokedAt: null, revokeReason: null } });
      membershipId = granted.id;
      }
    }
    const state: AreaAccessRequestStatus = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const update = await tx.areaAccessRequest.updateMany({ where: { id: request.id, status: 'PENDING', updatedAt: request.updatedAt, expiresAt: { gt: now } }, data: { status: state,
      approvedByMembershipId: input.decision === 'APPROVE' ? membership.id : null, decidedAt: now,
      ...(requesterAccountId ? { requesterAccountId } : {}), ...(onboardingInvitationId ? { onboardingInvitationId, onboardingEmailStatus: 'PENDING' } : {}),
    } });
    if (update.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request changed. Refresh and retry.');
    await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.customer.id, category: 'ACCESS', action: input.decision === 'APPROVE' ? 'room_access_approved' : 'room_access_rejected', targetType: 'AreaAccessRequest', targetId: request.id, metadata: { areaId: request.areaId, requesterAccountId: request.requesterAccountId }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    const receipt = { schemaVersion: 'dinodia.v1' as const, ok: true as const, requestId: request.id, state, membershipId, idempotentReplay: false };
    if (!delivery) await remember(tx, { namespace, accountId: input.customer.id, homeId: input.homeId, key: input.idempotencyKey, requestHash, body: receipt, status: 200, now });
    return { receipt, delivery, remember: delivery ? { namespace, accountId: input.customer.id, homeId: input.homeId, key: input.idempotencyKey, requestHash, receipt } : undefined };
  });
  if (outcome.delivery) {
    try {
      await sendCustomerInvitationEmail({ email: outcome.delivery.email, invitationId: outcome.delivery.invitationId, role: 'TENANT', postcode: outcome.delivery.postcode, expiresAt: outcome.delivery.expiresAt, temporaryPassword: outcome.delivery.temporaryPassword });
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.areaAccessRequest.update({ where: { id: input.requestId }, data: { onboardingEmailStatus: 'ACCEPTED' } });
        if (outcome.remember) await remember(tx, { ...outcome.remember, body: outcome.remember.receipt, status: 200, now });
      });
    } catch {
      await prisma.areaAccessRequest.updateMany({ where: { id: input.requestId, onboardingInvitationId: outcome.delivery.invitationId }, data: { onboardingEmailStatus: 'FAILED' } });
      throw new Stage1AuthError(503, 'INTERNAL_ERROR', 'Access was approved, but the recipient email could not be submitted. Retry the same approval to send a fresh secure credential.');
    }
  }
  return outcome.receipt;
}
