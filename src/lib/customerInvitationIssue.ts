import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { currentCustomerPolicy } from './customerPolicyConfig';
import { Stage1AuthError, type CustomerAccountSessionPrincipal } from './stage1Auth';
import { randomSecret, sha256 } from './stage1Crypto';
import { hashPassword } from './passwords';
import { sendCustomerInvitationEmail } from './customerInvitationEmail';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
type Role = 'PROPERTY_MANAGER' | 'TENANT';
type Input = { homeId: string; email: string; role: Role; areaIds: string[]; expectedManagementRevision: number; resendInvitationId: string | null; idempotencyKey: string };
type SafeReceipt = { schemaVersion: 'dinodia.v1'; ok: true; invitationId: string; homeId: string; role: Role; state: 'PENDING'|'REVOKED'; expiresAt: string; emailSubmission: 'PENDING'|'ACCEPTED'|'NOT_SENT'|'FAILED'; idempotentReplay: boolean };
type IssueResult = { status: number; body: SafeReceipt; delivery?: { email: string; postcode: string; expiresAt: Date; temporaryPassword: string | null } };

function bodyHash(input: Input): string {
  return sha256(JSON.stringify({ homeId: input.homeId, email: input.email, role: input.role, areaIds: input.areaIds, expectedManagementRevision: input.expectedManagementRevision, resendInvitationId: input.resendInvitationId }));
}

function safeReceipt(invitationId: string, homeId: string, role: Role, expiresAt: Date, emailSubmission: SafeReceipt['emailSubmission'], idempotentReplay: boolean, state: SafeReceipt['state'] = 'PENDING'): SafeReceipt {
  return { schemaVersion: 'dinodia.v1', ok: true, invitationId, homeId, role, state, expiresAt: expiresAt.toISOString(), emailSubmission, idempotentReplay };
}

export async function issueCustomerMembershipInvitation(input: Input, customer: CustomerAccountSessionPrincipal): Promise<IssueResult> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const areaIds = [...new Set(input.areaIds)].sort();
  const normalizedInput = { ...input, email: normalizedEmail, areaIds };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 320
    || !Number.isSafeInteger(input.expectedManagementRevision) || input.expectedManagementRevision < 0
    || !/^[A-Za-z0-9._:-]{16,160}$/.test(input.idempotencyKey)
    || areaIds.length !== input.areaIds.length || areaIds.length > 64
    || areaIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The invitation details are invalid');
  }
  if (input.role === 'TENANT' && areaIds.length === 0 || input.role === 'PROPERTY_MANAGER' && areaIds.length !== 0) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose at least one current Area for a tenant invitation');
  }
  const policy = currentCustomerPolicy();
  if (!policy) throw new Stage1AuthError(503, 'customer_policy_unavailable', 'Customer access is unavailable until the current policy is configured');
  const keyHash = sha256(`${customer.id}\n${input.idempotencyKey}`);
  const requestHash = bodyHash(normalizedInput);
  // The password exists only in process memory and the SES message. The database
  // stores its password hash in the existing invitation field; it is never
  // returned to the inviter or written to logs.
  const generatedTemporaryPassword = input.role === 'TENANT' ? randomSecret(24) : null;
  const generatedTemporaryPasswordHash = generatedTemporaryPassword ? hashPassword(generatedTemporaryPassword) : null;
  const invitationSecretHash = sha256(randomSecret(32));

  const result = await prisma.$transaction(async (tx): Promise<IssueResult> => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${customer.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${customer.sessionId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${customer.trustedDeviceId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${input.homeId}::uuid FOR UPDATE`;
    const now = new Date();
    const priorKey = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: 'customer-membership-invitation:v1', keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseStatus: true, responseBody: true, expiresAt: true } });
    if (priorKey) {
      if (priorKey.actorId !== customer.id || priorKey.homeId !== input.homeId || priorKey.requestHash !== requestHash || priorKey.expiresAt <= now || !priorKey.responseBody || typeof priorKey.responseBody !== 'object' || Array.isArray(priorKey.responseBody)) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This invitation request key was used for a different or expired request');
      }
      return { status: priorKey.responseStatus, body: { ...(priorKey.responseBody as SafeReceipt), idempotentReplay: true } };
    }

    const [account, session, device, home, membership, acceptance] = await Promise.all([
      tx.customerAccount.findUnique({ where: { id: customer.id }, select: { id: true, emailNormalized: true, emailVerifiedAt: true, status: true, mustChangePassword: true, securityVersion: true } }),
      tx.customerSession.findUnique({ where: { id: customer.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
      tx.trustedDevice.findUnique({ where: { id: customer.trustedDeviceId }, select: { id: true, customerAccountId: true, sessionVersion: true, revokedAt: true } }),
      tx.home.findUnique({ where: { id: input.homeId }, select: { id: true, postcode: true, lifecycle: true, installationStatus: true, managementRevision: true } }),
      tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: customer.id, homeId: input.homeId } }, select: { id: true, role: true, status: true } }),
      tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: customer.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } }, select: { id: true } }),
    ]);
    const exactCredential = customer.credentialKind === 'access'
      ? Boolean(customer.accessTokenHash && customer.accessTokenHash === session?.accessTokenHash && session?.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
      : customer.refreshTokenHash === session?.refreshTokenHash;
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword || account.emailNormalized !== customer.email.trim().toLowerCase()
      || account.securityVersion !== customer.securityVersion || !session || session.customerAccountId !== account.id || session.trustedDeviceId !== customer.trustedDeviceId
      || !exactCredential || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== customer.trustedDeviceSessionVersion
      || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
      || !device || device.customerAccountId !== account.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion
      || !acceptance || !home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE'
      || home.managementRevision !== input.expectedManagementRevision || !membership || membership.status !== 'ACTIVE'
      || !['OWNER', 'PROPERTY_MANAGER'].includes(membership.role) || input.role === 'PROPERTY_MANAGER' && membership.role !== 'OWNER') {
      throw new Stage1AuthError(403, 'SCOPE_DENIED', 'The current account cannot issue this invitation');
    }
    if (input.role === 'TENANT') {
      const areas = await tx.area.findMany({ where: { id: { in: areaIds }, homeId: input.homeId, status: 'ACTIVE' }, select: { id: true } });
      if (areas.length !== areaIds.length) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'One or more selected Areas are no longer available');
    }
    const target = await tx.customerAccount.findUnique({ where: { emailNormalized: normalizedEmail }, select: { id: true, status: true } });
    if (target && target.status !== 'ACTIVE') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This invitation cannot be issued for the current account state');
    if (target) {
      const relationship = await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: target.id, homeId: input.homeId } }, select: { status: true } });
      if (relationship && relationship.status !== 'REMOVED') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This account already has a relationship with the Home');
    }

    let replacement: { id: string } | null = null;
    if (input.resendInvitationId) {
      await tx.$queryRaw`SELECT "id" FROM "MembershipInvitation" WHERE "id" = ${input.resendInvitationId}::uuid FOR UPDATE`;
      replacement = await tx.membershipInvitation.findFirst({ where: { id: input.resendInvitationId, homeId: input.homeId, state: 'PENDING', expiresAt: { gt: now }, targetEmailNormalized: normalizedEmail }, select: { id: true } });
      if (!replacement) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The invitation to resend is no longer current');
      await tx.membershipInvitation.update({ where: { id: replacement.id }, data: { state: 'REPLACED', revokedAt: now } });
    } else {
      const pending = await tx.membershipInvitation.findFirst({ where: { homeId: input.homeId, targetEmailNormalized: normalizedEmail, state: 'PENDING', expiresAt: { gt: now } }, select: { id: true, role: true, areas: { select: { areaId: true } } } });
      if (pending) {
        const priorAreas = pending.areas.map((area) => area.areaId).sort();
        if (pending.role !== input.role || JSON.stringify(priorAreas) !== JSON.stringify(areaIds)) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'A different invitation is already pending; explicitly resend it to replace its generation');
        const body = safeReceipt(pending.id, input.homeId, input.role, (await tx.membershipInvitation.findUniqueOrThrow({ where: { id: pending.id }, select: { expiresAt: true } })).expiresAt, 'NOT_SENT', true);
        await tx.idempotencyRecord.create({ data: { namespace: 'customer-membership-invitation:v1', keyHash, actorId: customer.id, homeId: input.homeId, requestHash, responseStatus: 200, responseBody: body as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(body)), expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
        return { status: 200, body };
      }
    }

    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const invitation = await tx.membershipInvitation.create({ data: {
      homeId: input.homeId, inviterMembershipId: membership.id, targetAccountId: target?.id ?? null,
      targetEmail: normalizedEmail, targetEmailNormalized: normalizedEmail, role: input.role,
      tokenHash: invitationSecretHash, temporaryCredentialHash: !target && input.role === 'TENANT' ? generatedTemporaryPasswordHash : null,
      expiresAt, replacementOfId: replacement?.id ?? null,
      areas: { create: areaIds.map((areaId) => ({ areaId, homeId: input.homeId })) },
    }, select: { id: true, expiresAt: true } });
    const body = safeReceipt(invitation.id, input.homeId, input.role, expiresAt, 'PENDING', false);
    await tx.idempotencyRecord.create({ data: { namespace: 'customer-membership-invitation:v1', keyHash, actorId: customer.id, homeId: input.homeId, requestHash, responseStatus: 202, responseBody: body as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(body)), expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
    await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: customer.id, category: 'ACCESS', action: 'membership_invitation_issued', targetType: 'MembershipInvitation', targetId: invitation.id, metadata: { role: input.role, areaCount: areaIds.length, replacement: Boolean(replacement) }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return { status: 202, body, delivery: { email: normalizedEmail, postcode: home.postcode ?? '', expiresAt, temporaryPassword: !target && input.role === 'TENANT' ? generatedTemporaryPassword : null } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (!result.delivery) return result;
  try {
    await sendCustomerInvitationEmail({ email: result.delivery.email, invitationId: result.body.invitationId, role: result.body.role, postcode: result.delivery.postcode, expiresAt: result.delivery.expiresAt, temporaryPassword: result.delivery.temporaryPassword });
    const body = { ...result.body, emailSubmission: 'ACCEPTED' as const };
    await prisma.idempotencyRecord.update({ where: { namespace_keyHash: { namespace: 'customer-membership-invitation:v1', keyHash } }, data: { responseStatus: 201, responseBody: body as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(body)) } });
    return { status: 201, body };
  } catch {
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.membershipInvitation.updateMany({ where: { id: result.body.invitationId, state: 'PENDING' }, data: { state: 'REVOKED', revokedAt: now } });
      const body = { ...result.body, state: 'REVOKED' as const, emailSubmission: 'FAILED' as const };
      await tx.idempotencyRecord.update({ where: { namespace_keyHash: { namespace: 'customer-membership-invitation:v1', keyHash } }, data: { responseStatus: 503, responseBody: body as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(body)) } });
    });
    throw new Stage1AuthError(503, 'customer_policy_unavailable', 'The invitation email could not be submitted; no active invitation remains');
  }
}
