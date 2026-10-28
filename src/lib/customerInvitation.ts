import { Stage1AuthError } from './stage1Auth';
import { isRetryableSerializationConflict, serializableTransaction } from './serializableTransaction';

type DecisionInput = {
  invitationId: string; decision: 'ACCEPT'|'DECLINE'; expectedUpdatedAt: string;
  accountId: string; email: string; sessionId: string; refreshTokenHash: string;
  securityVersion: number; trustedDeviceId: string; trustedDeviceSessionVersion: number;
  credentialKind: 'access'|'refresh'; accessTokenHash: string|null; accessTokenExpiresAt: Date|null;
};

/**
 * One serialized invitation decision owner. The invitation, account, session,
 * home and membership are revalidated after their locks; an exact retry returns
 * the already committed result and a different decision cannot reverse it.
 */
function isPostgresLockTimeout(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null
    ? error as { code?: unknown; meta?: { code?: unknown; sqlState?: unknown; sqlstate?: unknown } }
    : {};
  const prismaCode = String(record.code ?? '');
  const sqlState = String(record.meta?.code ?? record.meta?.sqlState ?? record.meta?.sqlstate ?? '');
  return prismaCode === '55P03' || prismaCode === 'P2010' && sqlState === '55P03';
}

export async function decideCustomerInvitation(input: DecisionInput, onPhase?: (phase: string) => void) {
  let currentPhase = 'transaction_setup';
  const setPhase = (phase: string) => { currentPhase = phase; onPhase?.(phase); };
  try {
  return await serializableTransaction(async (tx) => {
    setPhase('transaction_setup');
    await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '6500ms'`;
    setPhase('lock_customer_account');
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${input.accountId}::uuid FOR UPDATE`;
    setPhase('lock_customer_session');
    await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${input.sessionId}::uuid FOR UPDATE`;
    setPhase('lock_trusted_device');
    await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${input.trustedDeviceId}::uuid FOR UPDATE`;

    // Invitation issue/replacement locks the Home before the old invitation.
    // Read the immutable foreign key first, then take those locks in the same
    // order. Re-read the invitation after both locks and verify the Home ID.
    setPhase('invitation_home_lookup');
    const initial = await tx.membershipInvitation.findUnique({ where: { id: input.invitationId }, select: { homeId: true } });
    if (!initial) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This invitation is no longer available');
    setPhase('lock_home');
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${initial.homeId}::uuid FOR UPDATE`;
    setPhase('lock_invitation');
    await tx.$queryRaw`SELECT "id" FROM "MembershipInvitation" WHERE "id" = ${input.invitationId}::uuid FOR UPDATE`;

    setPhase('authority_revalidation');
    const now = new Date();
    const [account, session, device, invitation] = await Promise.all([
      tx.customerAccount.findUnique({ where: { id: input.accountId }, select: { id: true, emailNormalized: true, emailVerifiedAt: true, status: true, mustChangePassword: true, securityVersion: true } }),
      tx.customerSession.findUnique({ where: { id: input.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
      tx.trustedDevice.findUnique({ where: { id: input.trustedDeviceId }, select: { id: true, customerAccountId: true, sessionVersion: true, revokedAt: true } }),
      tx.membershipInvitation.findUnique({ where: { id: input.invitationId }, select: {
        id: true, homeId: true, inviterMembershipId: true, targetAccountId: true, targetEmailNormalized: true,
        role: true, state: true, expiresAt: true, updatedAt: true, acceptedAt: true, declinedAt: true,
        areas: { select: { areaId: true, homeId: true, area: { select: { status: true } } } },
        home: { select: { lifecycle: true, installationStatus: true, managementRevision: true } },
        inviter: { select: { id: true, homeId: true, customerAccountId: true, status: true, role: true,
          customerAccount: { select: { status: true } } } },
      } }),
    ]);
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword || account.emailNormalized !== input.email.trim().toLowerCase()
      || account.securityVersion !== input.securityVersion || !session || session.customerAccountId !== account.id
      || session.trustedDeviceId !== input.trustedDeviceId || session.refreshTokenHash !== input.refreshTokenHash
      || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== input.trustedDeviceSessionVersion
      || input.credentialKind === 'access' && (!input.accessTokenHash || session.accessTokenHash !== input.accessTokenHash || !session.accessTokenExpiresAt || session.accessTokenExpiresAt <= now)
      || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
      || !device || device.customerAccountId !== account.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion
      || !invitation || invitation.homeId !== initial.homeId
      || invitation.targetAccountId && invitation.targetAccountId !== account.id
      || invitation.targetEmailNormalized !== account.emailNormalized) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This invitation is no longer available');
    }

    const stateForDecision = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
    if (invitation.state === stateForDecision) {
      setPhase('idempotent_receipt');
      const membership = input.decision === 'ACCEPT'
        ? await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: account.id, homeId: invitation.homeId } }, select: { id: true, status: true } })
        : null;
      if (input.decision === 'ACCEPT' && (!membership || membership.status !== 'ACTIVE' || !invitation.acceptedAt)
        || input.decision === 'DECLINE' && !invitation.declinedAt) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The invitation decision is no longer current');
      return { schemaVersion: 'dinodia.v1' as const, ok: true as const, invitationId: invitation.id,
        decision: input.decision, state: stateForDecision, homeMembershipId: membership?.id ?? null, idempotentReplay: true };
    }
    if (invitation.state === 'ACCEPTED' || invitation.state === 'DECLINED') {
      throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This invitation already has a different terminal decision');
    }
    if (invitation.state !== 'PENDING' || invitation.expiresAt <= now) {
      throw new Stage1AuthError(410, 'TOKEN_EXPIRED', 'This invitation has expired or is no longer available');
    }
    if (invitation.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This invitation changed; refresh Pending access and setup');
    if (input.decision === 'DECLINE') {
      setPhase('decline_commit');
      await tx.membershipInvitation.update({ where: { id: invitation.id }, data: { state: 'DECLINED', declinedAt: now, targetAccountId: account.id } });
      await tx.auditEvent.create({ data: { homeId: invitation.homeId, actorType: 'CUSTOMER', actorId: account.id, category: 'ACCESS', action: 'membership_invitation_declined', targetType: 'MembershipInvitation', targetId: invitation.id, metadata: { role: invitation.role }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { schemaVersion: 'dinodia.v1' as const, ok: true as const, invitationId: invitation.id,
        decision: input.decision, state: stateForDecision, homeMembershipId: null, idempotentReplay: false };
    }

    const inviterMayIssueRole = invitation.role === 'PROPERTY_MANAGER'
      ? invitation.inviter.role === 'OWNER'
      : ['OWNER', 'PROPERTY_MANAGER'].includes(invitation.inviter.role);
    if (invitation.home.lifecycle !== 'ACTIVE' || invitation.home.installationStatus !== 'COMPLETE'
      || invitation.inviter.homeId !== invitation.homeId || invitation.inviter.status !== 'ACTIVE'
      || invitation.inviter.customerAccount.status !== 'ACTIVE' || !inviterMayIssueRole) {
      throw new Stage1AuthError(409, 'SCOPE_DENIED', 'This invitation is not currently eligible for acceptance');
    }
    const invitedAreaIds = invitation.areas.map((area) => area.areaId).sort();
    if (invitation.role === 'TENANT' && (!invitedAreaIds.length || invitation.areas.some((area) => area.homeId !== invitation.homeId || area.area.status !== 'ACTIVE'))
      || invitation.role === 'PROPERTY_MANAGER' && invitedAreaIds.length) {
      throw new Stage1AuthError(409, 'SCOPE_DENIED', 'The invitation access scope is no longer valid');
    }

    const existing = await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: account.id, homeId: invitation.homeId } }, select: { id: true, role: true, status: true, accessRevision: true } });
    if (existing && existing.status !== 'REMOVED') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This account already has an active or pending relationship with the Home');
    setPhase('accept_commit');
    const changedHome = await tx.home.updateMany({ where: { id: invitation.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', managementRevision: invitation.home.managementRevision }, data: { managementRevision: { increment: 1 } } });
    if (changedHome.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The Home access policy changed; refresh and retry');
    const nextPolicyRevision = invitation.home.managementRevision + 1;
    const membership = existing
      ? await tx.homeMembership.update({ where: { id: existing.id }, data: { role: invitation.role, status: 'ACTIVE', activatedAt: now, removedAt: null, removalReason: null, accessRevision: { increment: 1 } }, select: { id: true } })
      : await tx.homeMembership.create({ data: { customerAccountId: account.id, homeId: invitation.homeId, role: invitation.role, status: 'ACTIVE', activatedAt: now }, select: { id: true } });
    await tx.tenantAreaGrant.updateMany({ where: { membershipId: membership.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'invitation_scope_replaced', policyRevision: nextPolicyRevision } });
    if (invitation.role === 'TENANT') for (const areaId of invitedAreaIds) {
      await tx.tenantAreaGrant.upsert({ where: { membershipId_areaId: { membershipId: membership.id, areaId } },
        create: { membershipId: membership.id, areaId, homeId: invitation.homeId, policyRevision: nextPolicyRevision, grantedAt: now },
        update: { homeId: invitation.homeId, policyRevision: nextPolicyRevision, grantedAt: now, revokedAt: null, revokeReason: null } });
    }
    await tx.membershipInvitation.update({ where: { id: invitation.id }, data: { state: 'ACCEPTED', acceptedAt: now, targetAccountId: account.id } });
    await tx.auditEvent.create({ data: { homeId: invitation.homeId, actorType: 'CUSTOMER', actorId: account.id, category: 'ACCESS', action: 'membership_invitation_accepted', targetType: 'MembershipInvitation', targetId: invitation.id, metadata: { role: invitation.role, areaGrantCount: invitedAreaIds.length, managementRevision: nextPolicyRevision }, occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return { schemaVersion: 'dinodia.v1' as const, ok: true as const, invitationId: invitation.id,
      decision: input.decision, state: stateForDecision, homeMembershipId: membership.id, idempotentReplay: false };
  }, 3, { maxWaitMs: 2000, timeoutMs: 8000 });
  } catch (error) {
    if (isPostgresLockTimeout(error)) {
      setPhase(`lock_timeout_after_${currentPhase}`);
      throw new Stage1AuthError(503, 'internal_error', 'The invitation service is temporarily busy');
    }
    // Two decisions on one invitation at the same moment can both abort on a serialization conflict even after
    // the retries. That is a lost race, not a server fault: the other decision won, so report the current state.
    if (isRetryableSerializationConflict(error)) {
      setPhase(`serialization_conflict_after_${currentPhase}`);
      throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The invitation decision is no longer current');
    }
    throw error;
  }
}
