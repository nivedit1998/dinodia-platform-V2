import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { currentCustomerPolicy } from './customerPolicyConfig';
import { homeownerDeregistrationEnabled } from './homeownerLifecycleAvailability';
import { consumeStepUpInTransaction } from './sensitiveOperationStepUp';
import { Stage1AuthError } from './stage1Auth';
import { deleteTenantPrivateDeviceCloudData } from './nativeTenantDeviceCleanup';
import { queueHomeDeregistrationAccountCleanup, resumeHomeDeregistrationAccountCleanup } from './homeDeregistrationCleanup';
import { serializableTransaction } from './serializableTransaction';
import { sha256 } from './stage1Crypto';
import { queueHomeownerAccessRemovalNotices } from './homeownerAccessRemovalNotices';

const NAMESPACE = 'homeowner-full-home-deregistration:v1';
const KEY = /^[A-Za-z0-9._:-]{16,160}$/;
export const FULL_HOME_DEREGISTRATION_CONFIRMATION = 'DEREGISTER FULL HOME';

export type DeregistrationPrincipal = {
  id: string; sessionId: string; trustedDeviceId: string; tokenHash: string;
  credentialKind: 'access' | 'refresh'; securityVersion: number;
  trustedDeviceSessionVersion: number; homeId: string; membershipId: string;
  hubInstallationId: string; policyRevision: number;
};

export type DeregistrationRequest = {
  expectedManagementRevision: number;
  confirmation: typeof FULL_HOME_DEREGISTRATION_CONFIRMATION;
  proof: string;
  idempotencyKey: string;
};

function conflict(): never {
  throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The Home or its authority changed. Refresh before continuing.');
}

export async function previewFullHomeDeregistration(input: { homeId: string; principal: DeregistrationPrincipal }) {
  const [home, owner, hub] = await Promise.all([
    prisma.home.findUnique({ where: { id: input.homeId }, select: {
      id: true, lifecycle: true, installationStatus: true, managementRevision: true,
      addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, timezone: true,
      areas: { where: { status: 'ACTIVE' }, select: { id: true } },
      devices: { where: { lifecycle: { notIn: ['REMOVED', 'RETIRED'] } }, select: { id: true, managementClass: true } },
      workItems: { where: { state: 'IN_PROGRESS' }, select: { id: true } },
    } }),
    prisma.homeMembership.findFirst({ where: { id: input.principal.membershipId, homeId: input.homeId,
      customerAccountId: input.principal.id, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } }),
    prisma.hubInstallation.findFirst({ where: { id: input.principal.hubInstallationId, homeId: input.homeId,
      lifecycleStatus: 'ACTIVE' }, select: { id: true, cleanupState: true, cleanupGeneration: true } }),
  ]);
  if (!home || !owner || !hub || input.principal.homeId !== input.homeId
    || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE') {
    throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Full-home deregistration is not available for this selected Home');
  }
  const [membershipCount, pendingInvitations, invitationRecordsPurged, pendingRoomRequests, supportAccess] = await Promise.all([
    prisma.homeMembership.count({ where: { homeId: input.homeId, status: 'ACTIVE' } }),
    prisma.membershipInvitation.count({ where: { homeId: input.homeId, state: 'PENDING' } }),
    prisma.membershipInvitation.count({ where: { homeId: input.homeId } }),
    prisma.areaAccessRequest.count({ where: { homeId: input.homeId, status: 'PENDING' } }),
    prisma.supportAccessRequest.count({ where: { homeId: input.homeId, status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED'] } } }),
  ]);
  const address = [home.addressLine1, home.addressLine2, home.city, home.region, home.postcode, home.country]
    .filter((part): part is string => Boolean(part?.trim())).join(', ');
  return {
    schemaVersion: 'dinodia.v1', ok: true, homeId: input.homeId,
    managementRevision: home.managementRevision, state: 'PREVIEW',
    actionAvailable: homeownerDeregistrationEnabled(),
    retainedAddress: address || null, retainsTimezone: Boolean(home.timezone),
    effects: {
      activeMembershipsRemoved: membershipCount, pendingInvitationsCancelled: pendingInvitations,
      invitationRecordsPurged,
      pendingRoomRequestsCancelled: pendingRoomRequests, supportAccessRevoked: supportAccess,
      privateDevicesRemoved: home.devices.filter((device) => device.managementClass === 'TENANT_DEVICE').length,
      permanentDevicesPreserved: home.devices.filter((device) => device.managementClass === 'PROPERTY_DEVICE').length,
      areasPreserved: home.areas.length, inProgressInstallationWorkPreserved: home.workItems.length,
      hubCleanupGeneration: hub.cleanupGeneration + 1,
    },
    warning: 'This removes all customer access and customer-created Home data. The physical Home, registered address, paired hub, tunnel, Room QR labels, original Areas, permanent devices and in-progress installation work remain. Hub credential/offline cleanup is reported as pending until the hub acknowledges it.',
  };
}

export async function deregisterFullHome(input: {
  homeId: string; principal: DeregistrationPrincipal; request: DeregistrationRequest;
}) {
  const { homeId, principal, request } = input;
  if (principal.homeId !== homeId
    || request.confirmation !== FULL_HOME_DEREGISTRATION_CONFIRMATION
    || !Number.isSafeInteger(request.expectedManagementRevision) || request.expectedManagementRevision < 1
    || typeof request.proof !== 'string' || request.proof.length < 40 || request.proof.length > 8192
    || !KEY.test(request.idempotencyKey)) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current Home revision, exact confirmation, fresh phone proof and idempotency key are required');
  }
  const keyHash = sha256(`${principal.id}:${homeId}:${request.idempotencyKey}`);
  const requestHash = sha256(JSON.stringify({ homeId, expectedManagementRevision: request.expectedManagementRevision,
    confirmation: request.confirmation }));
  let phase = 'begin';
  let receipt: Record<string, unknown>;
  try {
  receipt = await serializableTransaction(async (tx) => {
    phase = 'lock_and_revalidate';
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${homeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${principal.trustedDeviceId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "homeId" = ${homeId}::uuid ORDER BY "id" FOR UPDATE`;

    const now = new Date();
    const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: NAMESPACE, keyHash } },
      select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
    if (prior) {
      if (prior.actorId !== principal.id || prior.homeId !== homeId || prior.requestHash !== requestHash
        || prior.expiresAt <= now || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)) {
        throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This Home deregistration key was used for another request');
      }
      return { ...(prior.responseBody as Record<string, unknown>), idempotentReplay: true };
    }

    const policy = currentCustomerPolicy();
    const [home, owner, hub, account, session, device, acceptedPolicy] = await Promise.all([
      tx.home.findUnique({ where: { id: homeId }, select: { id: true, lifecycle: true, installationStatus: true,
        managementRevision: true, activeHubInstallationId: true, authorityGeneration: true, customerDataGeneration: true } }),
      tx.homeMembership.findFirst({ where: { id: principal.membershipId, homeId, customerAccountId: principal.id,
        role: 'OWNER', status: 'ACTIVE' }, select: { id: true, accessRevision: true } }),
      tx.hubInstallation.findFirst({ where: { id: principal.hubInstallationId, homeId, lifecycleStatus: 'ACTIVE' },
        select: { id: true, accessPolicyRevision: true, cleanupGeneration: true } }),
      tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, status: true, securityVersion: true } }),
      tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true,
        accessTokenHash: true, accessTokenExpiresAt: true, refreshTokenHash: true, securityVersion: true, trustedDeviceSessionVersion: true,
        revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
      tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { id: true, customerAccountId: true,
        sessionVersion: true, revokedAt: true } }),
      policy ? tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
        customerAccountId: principal.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
      } }, select: { id: true } }) : Promise.resolve(null),
    ]);
    const credentialCurrent = principal.credentialKind === 'access'
      ? session?.accessTokenHash === principal.tokenHash && Boolean(session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
      : session?.refreshTokenHash === principal.tokenHash;
    if (!policy || !acceptedPolicy || !home || !owner || !hub || !account || account.status !== 'ACTIVE'
      || account.securityVersion !== principal.securityVersion || !session || session.customerAccountId !== principal.id
      || session.trustedDeviceId !== principal.trustedDeviceId || !credentialCurrent || session.securityVersion !== account.securityVersion
      || session.trustedDeviceSessionVersion !== principal.trustedDeviceSessionVersion || session.revokedAt
      || session.expiresAt <= now || session.absoluteExpiresAt <= now || !device || device.customerAccountId !== principal.id
      || device.revokedAt || device.sessionVersion !== principal.trustedDeviceSessionVersion
      || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE'
      || home.activeHubInstallationId !== hub.id || home.managementRevision !== request.expectedManagementRevision
      || Math.max(owner.accessRevision, hub.accessPolicyRevision) !== principal.policyRevision) conflict();

    const value = { confirmation: request.confirmation, expectedManagementRevision: request.expectedManagementRevision };
    await consumeStepUpInTransaction(tx, {
      proof: request.proof, customerAccountId: principal.id, customerSessionId: principal.sessionId,
      trustedDeviceId: principal.trustedDeviceId, homeId, membershipId: owner.id, hubInstallationId: hub.id,
      operationKind: 'home.deregister', targetIds: [homeId, owner.id], value, policyRevision: principal.policyRevision,
    }, now);

    const memberships = await tx.homeMembership.findMany({ where: { homeId, status: 'ACTIVE' },
      select: { id: true, customerAccountId: true, role: true, accessRevision: true, customerAccount: { select: { emailNormalized: true } } } });
    const membershipIds = memberships.map((membership) => membership.id);
    const accountIds = [...new Set(memberships.map((membership) => membership.customerAccountId))].sort();
    if (accountIds.length) await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" IN (${Prisma.join(accountIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`;
    await queueHomeDeregistrationAccountCleanup(tx, { homeId, accountIds, now });
    for (const membership of memberships) {
      if (membership.role === 'OWNER' || membership.role === 'PROPERTY_MANAGER') {
        await queueHomeownerAccessRemovalNotices(tx, { homeId, membershipId: membership.id,
          customerAccountId: membership.customerAccountId, revision: membership.accessRevision + 1,
          kind: 'FULL_HOME_DEREGISTRATION', role: membership.role, now });
      }
    }

    const nextManagementRevision = home.managementRevision + 1;
    const nextCleanupGeneration = hub.cleanupGeneration + 1;
    const updated = await tx.home.updateMany({ where: { id: homeId, lifecycle: 'ACTIVE', managementRevision: home.managementRevision },
      data: { lifecycle: 'WAITING_FOR_HUB_CLEANUP', managementRevision: { increment: 1 },
        authorityGeneration: { increment: 1 }, customerDataGeneration: { increment: 1 } } });
    if (updated.count !== 1) conflict();
    await tx.hubInstallation.update({ where: { id: hub.id }, data: {
      accessPolicyRevision: { increment: 1 }, cloudConfigurationRevision: { increment: 1 },
      cleanupState: 'WAITING_FOR_FULL_HOME_DEREGISTRATION', cleanupGeneration: { increment: 1 },
    } });

    // Preserve the physical Home and canonical installation identity. Only
    // household-created presentation and relationship authority is removed.
    if (membershipIds.length) {
      await tx.homeMembership.updateMany({ where: { id: { in: membershipIds }, homeId, status: 'ACTIVE' }, data: {
        status: 'REMOVED', removedAt: now, removalReason: 'full_home_deregistration', accessRevision: { increment: 1 },
      } });
      await tx.tenantAreaGrant.updateMany({ where: { homeId, membershipId: { in: membershipIds }, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'full_home_deregistration', policyRevision: { increment: 1 } } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { homeId, membershipId: { in: membershipIds }, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'full_home_deregistration' } });
      await tx.stepUpChallenge.updateMany({ where: { homeId, membershipId: { in: membershipIds }, consumedAt: null, cancelledAt: null },
        data: { cancelledAt: now } });
      await tx.stepUpAuthorization.updateMany({ where: { homeId, membershipId: { in: membershipIds }, consumedAt: null, revokedAt: null },
        data: { revokedAt: now } });
      await tx.memberPreferenceDocument.deleteMany({ where: { membershipId: { in: membershipIds } } });
      await tx.alexaNativeEndpointProjection.deleteMany({ where: { homeId, membershipId: { in: membershipIds } } });
      await tx.alexaNativeHomeScope.deleteMany({ where: { homeId, membershipId: { in: membershipIds } } });
      await tx.nativeTenantDeviceRecovery.deleteMany({ where: { homeId, ownerMembershipId: { in: membershipIds } } });
    }

    phase = 'purge_home_relationship_data';
    const invitationRecordsPurged = await tx.membershipInvitation.count({ where: { homeId } });
    const exceptionalTransferCasesPurged = await tx.exceptionalOwnershipTransfer.count({ where: { homeId } });
    await tx.membershipInvitation.updateMany({ where: { homeId, state: 'PENDING' }, data: { state: 'REVOKED', revokedAt: now } });
    // The invitation's inviterMembershipId is deliberately RESTRICT, including
    // for already-cancelled history. Once the Home is fully deregistered those
    // recipient identifiers and tokens are customer data with no remaining
    // access purpose. Purge the Home-scoped invitation rows before orphaned
    // accounts/memberships are removed; the audit retains aggregate counts only.
    await tx.membershipInvitation.deleteMany({ where: { homeId } });
    await tx.areaAccessRequest.updateMany({ where: { homeId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: now } });
    await tx.exceptionalOwnershipTransfer.updateMany({ where: { homeId, status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] } },
      data: { status: 'CANCELLED', cancelledAt: now, decidedAt: now, revision: { increment: 1 } } });
    // Exceptional cases contain encrypted recipient details and retain a
    // restrictive outgoing-owner membership relationship. After cancellation
    // and claim invalidation, purge their Home-scoped private records so the
    // later account cleanup can remove its former membership. The audit keeps
    // only the aggregate count, never the case contents or recipient.
    await tx.exceptionalOwnershipTransfer.deleteMany({ where: { homeId } });
    const transferClaims = await tx.homeClaimReference.findMany({ where: { homeId, purpose: 'OWNERSHIP_TRANSFER', state: { in: ['AVAILABLE', 'RESERVED'] } }, select: { id: true } });
    if (transferClaims.length) {
      const transferIds = transferClaims.map((claim) => claim.id);
      await tx.homeClaimReference.updateMany({ where: { id: { in: transferIds } }, data: {
        state: 'CANCELLED', cancelledAt: now, invalidatedAt: now, transferCodeHash: null,
        transferRecipientEmail: null, transferRecipientEmailHash: null,
      } });
      await tx.homeClaimChallenge.updateMany({ where: { claimReferenceId: { in: transferIds }, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
    }

    const homeTicketIds = (await tx.supportTicket.findMany({ where: { homeId }, select: { id: true } })).map((row) => row.id);
    const supportRequestIds = (await tx.supportAccessRequest.findMany({ where: { homeId,
      status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED'] } }, select: { id: true } })).map((row) => row.id);
    if (supportRequestIds.length) {
      await tx.supportSession.updateMany({ where: { accessRequestId: { in: supportRequestIds }, status: { in: ['ACTIVE', 'PENDING_HUB_REVOKE'] } },
        data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
      await tx.supportAccessRequest.updateMany({ where: { id: { in: supportRequestIds } }, data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
    }
    await tx.supportAccessNotification.deleteMany({ where: { homeId } });
    await tx.supportTicket.updateMany({ where: { homeId, status: { not: 'CLOSED' } }, data: {
      status: 'CLOSED', closedAt: now, customerAccountId: null, selectedMembershipId: null,
      description: '[Closed and redacted after full-home deregistration]', title: null, areaId: null, deviceId: null,
      safeDiagnostics: Prisma.DbNull, customerResolution: null, revision: { increment: 1 },
    } });
    if (homeTicketIds.length) await tx.nativeSupportTicketTimeline.deleteMany({ where: { ticketId: { in: homeTicketIds } } });

    await tx.nativeAutomation.deleteMany({ where: { homeId } });
    await purgeDailyAnalytics(tx, { homeId, wholeHome: true });
    await tx.nativeDeviceUsageBucket.deleteMany({ where: { homeId } });
    await tx.nativeTemperatureSample.deleteMany({ where: { homeId } });
    await tx.nativeDeviceOutageIncident.updateMany({ where: { homeId, causedByHubIncidentId: { not: null } }, data: { causedByHubIncidentId: null } });
    await tx.nativeDeviceOutageIncident.deleteMany({ where: { homeId } });
    await tx.nativeNotificationDeliveryReceipt.deleteMany({ where: { homeId } });
    // The floor plan is the property's layout, not the owner's data: it stays for whoever registers the Home next.
    // Room and device names (overrides) and every other document are still cleared.
    await tx.homeDocument.deleteMany({ where: { homeId, kind: { not: 'FLOORPLAN' } } });
    await tx.area.updateMany({ where: { homeId }, data: { overrideName: null, revision: { increment: 1 } } });
    await tx.nativeDevice.updateMany({ where: { homeId, managementClass: 'PROPERTY_DEVICE' }, data: { overrideName: null, inventoryRevision: { increment: 1 } } });

    phase = 'remove_private_device_data';
    const privateDevices = await tx.nativeDevice.findMany({ where: { homeId, managementClass: 'TENANT_DEVICE' }, select: { id: true } });
    if (privateDevices.length) {
      const ids = privateDevices.map((row) => row.id);
      await deleteTenantPrivateDeviceCloudData(tx, { homeId, deviceIds: ids });
      await tx.nativeDevice.deleteMany({ where: { homeId, id: { in: ids }, managementClass: 'TENANT_DEVICE' } });
    }

    // This isolated rehearsal-only failure proves that Home authority, proof
    // consumption, private-data removal and queued cleanup roll back together.
    if (process.env.V2_ENVIRONMENT === 'test' && process.env.STAGE9_DEREG_TEST_FAILPOINT === 'after_private_data') {
      phase = 'test_failpoint_after_private_data';
      throw new Error('Disposable full-home transaction failpoint');
    }

    phase = 'write_audit_event';
    await tx.auditEvent.create({ data: { homeId, actorType: 'CUSTOMER', actorId: principal.id, category: 'SECURITY',
      action: 'full_home_deregistration_started', targetType: 'Home', targetId: homeId,
      metadata: { outcome: 'waiting_for_hub_cleanup', managementRevision: nextManagementRevision,
        cleanupGeneration: nextCleanupGeneration, removedMembershipCount: membershipIds.length,
        purgedInvitationRecordCount: invitationRecordsPurged,
        purgedExceptionalTransferCaseCount: exceptionalTransferCasesPurged,
        permanentInfrastructurePreserved: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });

    const receipt = { schemaVersion: 'dinodia.v1', ok: true, homeId, state: 'WAITING_FOR_HUB_CLEANUP',
      managementRevision: nextManagementRevision, cleanupGeneration: nextCleanupGeneration,
      hubEnforcement: 'PENDING', removedMembershipCount: membershipIds.length,
      accountsQueuedForCleanup: accountIds.length, accountCleanupState: 'PENDING', idempotentReplay: false } as const;
    phase = 'write_idempotency_receipt';
    await tx.idempotencyRecord.create({ data: { namespace: NAMESPACE, keyHash, actorId: principal.id, homeId,
      hubInstallationId: hub.id, requestHash, responseStatus: 202, responseDigest: sha256(JSON.stringify(receipt)),
      responseBody: receipt as unknown as Prisma.InputJsonValue, expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } });
    return receipt;
  }, 4, { maxWaitMs: 5_000, timeoutMs: 30_000 });
  } catch (error) {
    if (error && typeof error === 'object') {
      Object.defineProperty(error, 'deregistrationPhase', { value: phase, configurable: true });
      const customerCleanupPhase = (error as { customerCleanupPhase?: unknown }).customerCleanupPhase;
      if (customerCleanupPhase) Object.defineProperty(error, 'customerCleanupPhase', { value: customerCleanupPhase, configurable: true });
    }
    throw error;
  }
  let accountCleanupState = 'PENDING';
  let accountCleanupProcessed = 0;
  try {
    const cleanup = await resumeHomeDeregistrationAccountCleanup(new Date(), { homeId, limit: 1 });
    accountCleanupProcessed = cleanup.evaluated;
    accountCleanupState = cleanup.failed > 0 ? 'ATTENTION_REQUIRED' : cleanup.pending > 0 ? 'PENDING' : 'COMPLETE';
  } catch {
    // Authority revocation and private-data removal are already durable. A
    // failed/paused cleanup remains in the existing outbox for operations
    // dispatch; never turn the committed request into an ambiguous HTTP 500.
  }
  return { ...receipt, accountCleanupState, accountCleanupProcessed };
}
import { purgeDailyAnalytics } from './dailyAnalyticsErasure';
