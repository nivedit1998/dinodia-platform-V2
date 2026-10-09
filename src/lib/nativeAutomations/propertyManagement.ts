import { serializableTransaction } from '@/lib/serializableTransaction';
import { homeownerIdempotencyIdentity, homeownerRequestHash, runIdempotentHomeMutation } from '@/lib/homeownerIdempotency';
import { consumeStepUpInTransaction } from '@/lib/sensitiveOperationStepUp';
import { automationDefinitionChecksum, NativeAutomationError } from './validation';
import { retireNativeAutomations } from './lifecycle';
import { refreshNativeAutomationCloudRevision } from './delivery';
import { queueTenantAutomationManagementNotice } from '@/lib/homeownerAccessRemovalNotices';
import { Stage1AuthError } from '@/lib/stage1Auth';

type SelectedActor = {
  id: string; homeId: string; membershipId: string; trustedDeviceId: string; sessionId: string;
  hubInstallationId: string; role: string; policyRevision: number; tokenHash: string;
  tokenExpiresAt?: number; credentialKind?: string; trustedDevicePublicKey: string;
};

export async function mutatePropertyAutomation(input: {
  actor: SelectedActor; automationId: string; operation: 'disable' | 'delete';
  expectedAutomationRevision: number; expectedManagementRevision: number; reason: string;
  proof: string; idempotencyKey: string;
}) {
  const { actor } = input;
  if (!['OWNER', 'PROPERTY_MANAGER'].includes(actor.role) || actor.credentialKind !== 'account_access') {
    throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Property automation management is unavailable for this Home');
  }
  const action = input.operation;
  const operationKind = action === 'disable' ? 'home.tenant_automation_disable' : 'home.tenant_automation_delete';
  const proofValue = { action, expectedAutomationRevision: input.expectedAutomationRevision,
    expectedManagementRevision: input.expectedManagementRevision, reason: input.reason };
  const identity = homeownerIdempotencyIdentity(actor.id, input.idempotencyKey,
    `property-automation-${action}:${actor.homeId}:${input.automationId}`);
  return serializableTransaction(async (tx) => runIdempotentHomeMutation(tx, {
    ...identity, actorId: actor.id, homeId: actor.homeId,
    // Proof is a one-use authorization credential, not part of the logical
    // request body. Excluding it lets a fresh proof reconcile a lost response
    // under the same idempotency key; the proof is consumed only on first use.
    requestHash: homeownerRequestHash(proofValue),
    operation: async () => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-automation-home:${actor.homeId}`}, 0)) IS NULL AS acquired`;
      await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${actor.homeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${actor.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${actor.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${actor.trustedDeviceId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${actor.membershipId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "NativeAutomation" WHERE "id" = ${input.automationId}::uuid FOR UPDATE`;
      const now = new Date();
      const [membership, home, hub, account, session, trusted, automation] = await Promise.all([
        tx.homeMembership.findFirst({ where: { id: actor.membershipId, customerAccountId: actor.id, homeId: actor.homeId,
          role: actor.role as 'OWNER' | 'PROPERTY_MANAGER', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { id: true, accessRevision: true } }),
        tx.home.findFirst({ where: { id: actor.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, managementRevision: true, activeHubInstallationId: true } }),
        tx.hubInstallation.findFirst({ where: { id: actor.hubInstallationId, homeId: actor.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true, accessPolicyRevision: true } }),
        tx.customerAccount.findUnique({ where: { id: actor.id }, select: { status: true, securityVersion: true } }),
        tx.customerSession.findUnique({ where: { id: actor.sessionId }, select: { customerAccountId: true, trustedDeviceId: true, accessTokenHash: true,
          accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: actor.trustedDeviceId }, select: { customerAccountId: true, publicKey: true, sessionVersion: true, revokedAt: true } }),
        tx.nativeAutomation.findFirst({ where: { id: input.automationId, homeId: actor.homeId, propertyImpact: true,
          status: action === 'disable' ? { in: ['ACTIVE', 'NEEDS_ATTENTION'] } : { not: 'RETIRED' },
          actions: { some: { device: { managementClass: 'PROPERTY_DEVICE' } } } }, select: { id: true, name: true, status: true, revision: true,
          timezone: true, propertyImpact: true, createdByMembershipId: true,
          createdBy: { select: { id: true, customerAccountId: true, role: true } },
          triggers: { orderBy: { id: 'asc' }, take: 1, select: { id: true, configuration: true } },
          actions: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, deviceId: true, areaId: true, controlId: true, sortOrder: true, descriptorRevision: true, actionValue: true } } } }),
      ]);
      const policyRevision = membership && hub ? Math.max(membership.accessRevision, hub.accessPolicyRevision) : -1;
      if (!membership || !home || !hub || home.activeHubInstallationId !== hub.id || !account || account.status !== 'ACTIVE'
        || !session || session.customerAccountId !== actor.id || session.trustedDeviceId !== actor.trustedDeviceId
        || session.accessTokenHash !== actor.tokenHash || !session.accessTokenExpiresAt || session.accessTokenExpiresAt <= now
        || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== trusted?.sessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !trusted || trusted.customerAccountId !== actor.id || trusted.revokedAt || trusted.publicKey !== actor.trustedDevicePublicKey
        || !actor.tokenExpiresAt || actor.tokenExpiresAt <= now.getTime() || !automation
        || home.managementRevision !== input.expectedManagementRevision || automation.revision !== input.expectedAutomationRevision
        || policyRevision !== actor.policyRevision) {
        throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'The selected Home, rule or trusted session changed. Refresh before confirming.');
      }
      if (!automation.createdByMembershipId || !automation.createdBy || automation.createdBy.role !== 'TENANT') {
        throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation no longer has a current tenant owner');
      }
      await consumeStepUpInTransaction(tx, { proof: input.proof, customerAccountId: actor.id,
        customerSessionId: actor.sessionId, trustedDeviceId: actor.trustedDeviceId, homeId: actor.homeId,
        membershipId: membership.id, hubInstallationId: hub.id, operationKind, targetIds: [automation.id],
        value: proofValue, policyRevision });

      const revision = automation.revision + 1;
      if (action === 'disable') {
        const checksum = automationDefinitionChecksum({ id: automation.id, revision, status: 'PAUSED', name: automation.name,
          timezone: automation.timezone, trigger: automation.triggers[0]?.configuration ?? null,
          actions: automation.actions.map(({ id, deviceId, areaId, controlId, sortOrder, descriptorRevision, actionValue }) => ({ id, deviceId, areaId, controlId, sortOrder, descriptorRevision, actionValue })) });
        const changed = await tx.nativeAutomation.updateMany({ where: { id: automation.id, homeId: actor.homeId, revision: automation.revision, status: { in: ['ACTIVE', 'NEEDS_ATTENTION'] } },
          data: { status: 'PAUSED', revision, enabledAt: null, definitionChecksum: checksum } });
        if (changed.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation changed before it could be disabled');
      } else {
        await retireNativeAutomations(tx, { homeId: actor.homeId, automationIds: [automation.id], now,
          actorId: actor.id, reason: `property_manager_${input.reason}` });
      }
      const changedHome = await tx.home.updateMany({ where: { id: actor.homeId, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
      if (changedHome.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'The Home changed before the intervention was saved');
      const delivery = await refreshNativeAutomationCloudRevision(tx, { homeId: actor.homeId, hubInstallationId: hub.id });
      const notice = await queueTenantAutomationManagementNotice(tx, { homeId: actor.homeId, automationId: automation.id,
        membershipId: automation.createdByMembershipId, customerAccountId: automation.createdBy.customerAccountId, revision, now });
      await tx.auditEvent.create({ data: { homeId: actor.homeId, actorType: 'CUSTOMER', actorId: actor.id,
        category: 'ACCESS', action: action === 'disable' ? 'property_manager_disabled_tenant_automation' : 'property_manager_deleted_tenant_automation',
        targetType: 'NativeAutomation', targetId: automation.id,
        metadata: { operation: action, reason: input.reason, revision, managementRevision: home.managementRevision + 1,
          deliveryPending: delivery.changed, tenantNoticeIntents: notice.queued },
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { ok: true, homeId: actor.homeId, automationId: automation.id, revision,
        status: action === 'disable' ? (delivery.changed ? 'disabled_waiting_for_hub' : 'disabled') : (delivery.changed ? 'removal_pending' : 'removed'),
        managementRevision: home.managementRevision + 1, tenantNoticeQueued: notice.queued > 0 };
    },
  }));
}
