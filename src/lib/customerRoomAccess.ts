import { Prisma, type AreaAccessRequestStatus } from '@prisma/client';
import { prisma } from './prisma';
import { sha256 } from './stage1Crypto';
import { Stage1AuthError, type CustomerAccountSessionPrincipal } from './stage1Auth';
import { currentCustomerPolicy } from './customerPolicyConfig';
import { serializableTransaction } from './serializableTransaction';

type Tx = Prisma.TransactionClient;
const REQUEST_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MS = 30 * 24 * 60 * 60 * 1000;

function iso(value: Date): string { return value.toISOString(); }
function keyDigest(accountId: string, key: string): string { return sha256(`${accountId}\n${key}`); }
function bodyDigest(value: unknown): string { return sha256(JSON.stringify(value)); }

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
      const created = await tx.areaAccessRequest.create({ data: { areaQrCredentialId: qr.id, areaId: qr.areaId, homeId: qr.area.home.id, requesterAccountId: account.id, status: 'PENDING', expiresAt: new Date(now.getTime() + REQUEST_MS) }, select: { id: true, expiresAt: true, updatedAt: true } });
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
    const rows = await tx.areaAccessRequest.findMany({ where: { homeId: input.homeId, status: 'PENDING', expiresAt: { gt: now }, area: { status: 'ACTIVE' }, qrCredential: { status: 'ACTIVE' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
      select: { id: true, areaId: true, createdAt: true, expiresAt: true, updatedAt: true, area: { select: { originalName: true } }, requester: { select: { displayName: true } } } });
    return rows.map((row) => ({ schemaVersion: 'dinodia.v1' as const, requestId: row.id, areaId: row.areaId,
      areaLabel: row.area.originalName, requesterLabel: row.requester.displayName || 'Verified Dinodia customer',
      createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt), revision: iso(row.updatedAt), allowedActions: ['APPROVE', 'REJECT'] as const }));
  });
}

export async function decideHomeRoomAccessRequest(input: { requestId: string; homeId: string; customer: CustomerAccountSessionPrincipal; decision: 'APPROVE'|'REJECT'; expectedRevision: string; idempotencyKey: string }) {
  const namespace = `home-room-access-decision:v1:${input.homeId}`;
  const requestHash = bodyDigest({ requestId: input.requestId, homeId: input.homeId, decision: input.decision, expectedRevision: input.expectedRevision, accountId: input.customer.id });
  return serializableTransaction(async (tx) => {
    await lockAndRevalidateAccountSession(tx, input.customer);
    // The route passes the account ID after authenticating; a fresh membership
    // is re-read under the property lock below before any grant is written.
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AreaAccessRequest" WHERE "id" = ${input.requestId}::uuid FOR UPDATE`;
    const old = await replay(tx, namespace, input.customer.id, input.idempotencyKey, requestHash);
    if (old) return { ...old, idempotentReplay: true };
    const now = new Date();
    const [membership, request] = await Promise.all([
      tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: input.customer.id, homeId: input.homeId } }, select: { id: true, role: true, status: true } }),
      tx.areaAccessRequest.findUnique({ where: { id: input.requestId }, select: { id: true, homeId: true, areaId: true, areaQrCredentialId: true, requesterAccountId: true, status: true, expiresAt: true, updatedAt: true,
        area: { select: { originalName: true, status: true } }, qrCredential: { select: { status: true, areaId: true } } } }),
    ]);
    if (!membership || membership.status !== 'ACTIVE' || !['OWNER', 'PROPERTY_MANAGER'].includes(membership.role)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Room access requests are not available');
    const home = await tx.home.findUnique({ where: { id: input.homeId }, select: { lifecycle: true, installationStatus: true, managementRevision: true } });
    if (!request || request.homeId !== input.homeId || home?.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Room access request is not available');
    if (request.status === (input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED')) return { schemaVersion: 'dinodia.v1' as const, ok: true as const, requestId: request.id, state: request.status, membershipId: input.decision === 'APPROVE' ? (await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: request.requesterAccountId, homeId: request.homeId } }, select: { id: true } }))?.id ?? null : null, idempotentReplay: true };
    if (request.status !== 'PENDING' || request.expiresAt <= now || request.area.status !== 'ACTIVE' || request.qrCredential.status !== 'ACTIVE' || request.qrCredential.areaId !== request.areaId) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request is no longer eligible for a decision');
    if (iso(request.updatedAt) !== input.expectedRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request changed. Refresh and retry.');
    let membershipId: string | null = null;
    if (input.decision === 'APPROVE') {
      const requester = await tx.customerAccount.findUnique({ where: { id: request.requesterAccountId }, select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true } });
      if (!requester || requester.status !== 'ACTIVE' || !requester.emailVerifiedAt || requester.mustChangePassword) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The requester is not currently eligible for Room access');
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
    const state: AreaAccessRequestStatus = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const update = await tx.areaAccessRequest.updateMany({ where: { id: request.id, status: 'PENDING', updatedAt: request.updatedAt, expiresAt: { gt: now } }, data: { status: state, approvedByMembershipId: input.decision === 'APPROVE' ? membership.id : null, decidedAt: now } });
    if (update.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request changed. Refresh and retry.');
    await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.customer.id, category: 'ACCESS', action: input.decision === 'APPROVE' ? 'room_access_approved' : 'room_access_rejected', targetType: 'AreaAccessRequest', targetId: request.id, metadata: { areaId: request.areaId, requesterAccountId: request.requesterAccountId }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, requestId: request.id, state, membershipId, idempotentReplay: false };
    await remember(tx, { namespace, accountId: input.customer.id, homeId: input.homeId, key: input.idempotencyKey, requestHash, body: receipt, status: 200, now });
    return receipt;
  });
}
