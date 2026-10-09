import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateHomeownerTenantRemovalReceipt, validateHomeownerTenantRemovalRequest } from '@/lib/contracts/dinodiaV1';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { sha256 } from '@/lib/stage1Crypto';
import { cleanupCustomerAccountIfOrphaned } from '@/lib/customerRelationshipCleanup';
import { queueHomeownerAccessRemovalNotices } from '@/lib/homeownerAccessRemovalNotices';
import { deleteTenantPrivateDeviceCloudData } from '@/lib/nativeTenantDeviceCleanup';
import { retireNativeAutomations } from '@/lib/nativeAutomations/lifecycle';
import { refreshNativeAutomationCloudRevision } from '@/lib/nativeAutomations/delivery';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMESPACE = 'homeowner-tenant-membership-remove:v1';
const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export async function DELETE(request: Request, context: { params: Promise<{ homeId: string; tenantId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, tenantId } = await context.params;
    const body = await request.json().catch(() => null);
    if (!UUID.test(homeId) || !UUID.test(tenantId) || selected.homeId !== homeId
      || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access'
      || !validateHomeownerTenantRemovalRequest(body)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant removal is not available for this selected Home');
    }
    if (selected.id === tenantId) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant removal is not available for this selected Home');
    const keyHash = sha256(`${selected.id}:${body.idempotencyKey}`);
    const requestHash = sha256(JSON.stringify({ homeId, tenantId,
      expectedAccessRevision: body.expectedAccessRevision, expectedManagementRevision: body.expectedManagementRevision }));
    const result = await serializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${homeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${selected.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${selected.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${selected.trustedDeviceId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${selected.membershipId}::uuid FOR UPDATE`;
      const now = new Date();
      const [actor, home, hub, actorAccount, session, trusted] = await Promise.all([
        tx.homeMembership.findFirst({ where: { id: selected.membershipId, customerAccountId: selected.id, homeId,
          role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE' }, select: { id: true, accessRevision: true } }),
        tx.home.findFirst({ where: { id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, managementRevision: true, activeHubInstallationId: true } }),
        tx.hubInstallation.findFirst({ where: { id: selected.hubInstallationId, homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true, accessPolicyRevision: true } }),
        tx.customerAccount.findUnique({ where: { id: selected.id }, select: { id: true, status: true, securityVersion: true } }),
        tx.customerSession.findUnique({ where: { id: selected.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: selected.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
      ]);
      const currentPolicy = currentCustomerPolicy();
      const acceptedPolicy = currentPolicy && await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
        customerAccountId: selected.id, policyKind: 'DINODIA_NATIVE', policyVersion: currentPolicy.version,
      } }, select: { id: true } });
      if (!actor || !home || !hub || home.activeHubInstallationId !== hub.id || !actorAccount || actorAccount.status !== 'ACTIVE'
        || !session || session.customerAccountId !== actorAccount.id || session.trustedDeviceId !== selected.trustedDeviceId
        || session.accessTokenHash !== selected.tokenHash || !session.accessTokenExpiresAt || session.accessTokenExpiresAt <= now
        || session.securityVersion !== actorAccount.securityVersion || session.trustedDeviceSessionVersion !== trusted?.sessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !trusted || trusted.customerAccountId !== actorAccount.id || trusted.revokedAt
        || !acceptedPolicy || !currentPolicy || Math.max(actor.accessRevision, hub.accessPolicyRevision) !== selected.policyRevision) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Home, session or management authority changed. Refresh before removing access.');
      }
      const namespace = NAMESPACE;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${keyHash}`}, 0)) IS NULL AS acquired`;
      const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
      if (prior) {
        if (prior.actorId !== selected.id || prior.homeId !== homeId || prior.requestHash !== requestHash || prior.expiresAt <= now
          || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)
          || !validateHomeownerTenantRemovalReceipt(prior.responseBody, homeId, tenantId)) {
          throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This tenant-removal key was already used for another request');
        }
        return { ...(prior.responseBody as unknown as import('@/lib/contracts/dinodiaV1').HomeownerTenantRemovalReceipt), idempotentReplay: true };
      }
      // An exact retry must reconcile the committed receipt before checking
      // the caller's original Home revision: the successful removal itself
      // advances that revision. New operations still require the current one.
      if (home.managementRevision !== body.expectedManagementRevision) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Home, session or management authority changed. Refresh before removing access.');
      }
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      const target = await tx.homeMembership.findFirst({ where: { id: tenantId, homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } },
        select: { id: true, customerAccountId: true, accessRevision: true, customerAccount: { select: { emailNormalized: true } } } });
      if (!target || target.customerAccountId === selected.id) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This tenant is no longer linked to the selected Home');
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${target.customerAccountId}::uuid FOR UPDATE`;
      const currentTarget = await tx.homeMembership.findFirst({ where: { id: tenantId, homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } },
        select: { id: true, customerAccountId: true, accessRevision: true } });
      if (!currentTarget || currentTarget.accessRevision !== body.expectedAccessRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Tenant access changed. Refresh before confirming removal.');
      const proofValue = { expectedAccessRevision: body.expectedAccessRevision, expectedManagementRevision: body.expectedManagementRevision };
      const digest = operationDigest({ customerAccountId: selected.id, customerSessionId: selected.sessionId,
        trustedDeviceId: selected.trustedDeviceId, homeId, membershipId: actor.id, hubInstallationId: hub.id,
        operationKind: 'home_tenant_remove', targetIds: [tenantId], value: proofValue });
      const proofUse = await tx.stepUpAuthorization.updateMany({ where: {
        nonceHash: sha256(body.proof), customerAccountId: selected.id, customerSessionId: selected.sessionId,
        trustedDeviceId: selected.trustedDeviceId, homeId, membershipId: actor.id, operationKind: 'home_tenant_remove',
        targetDigest: targetDigest([tenantId]), normalizedValueDigest: digest,
        policyRevision: selected.policyRevision, consumedAt: null, revokedAt: null, expiresAt: { gt: now },
      }, data: { consumedAt: now } });
      if (proofUse.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'Fresh trusted-phone confirmation for this exact tenant removal is required');

      const nextAccessRevision = target.accessRevision + 1;
      const nextManagementRevision = home.managementRevision + 1;
      const homeChanged = await tx.home.updateMany({ where: { id: homeId, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
      if (homeChanged.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Home management changed. Refresh and retry.');
      await tx.homeMembership.update({ where: { id: tenantId }, data: { status: 'REMOVED', removedAt: now, removalReason: 'owner_removed_tenant', accessRevision: { increment: 1 } } });
      await queueHomeownerAccessRemovalNotices(tx, { homeId, membershipId: tenantId, customerAccountId: target.customerAccountId,
        revision: nextAccessRevision, kind: 'TENANT', now });
      await tx.tenantAreaGrant.updateMany({ where: { membershipId: tenantId, homeId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'owner_removed_tenant', policyRevision: nextAccessRevision } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { membershipId: tenantId, homeId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'owner_removed_tenant', policyRevision: nextAccessRevision } });
      await tx.stepUpChallenge.updateMany({ where: { homeId, membershipId: tenantId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.stepUpAuthorization.updateMany({ where: { homeId, membershipId: tenantId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.membershipInvitation.updateMany({ where: { homeId, state: 'PENDING', OR: [{ targetAccountId: target.customerAccountId }, { targetEmailNormalized: target.customerAccount.emailNormalized }] }, data: { state: 'REVOKED', revokedAt: now } });
      await tx.areaAccessRequest.updateMany({ where: { homeId, requesterAccountId: target.customerAccountId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: now } });
      const privateDevices = await tx.nativeDevice.findMany({ where: { homeId, ownerMembershipId: tenantId, managementClass: 'TENANT_DEVICE' },
        select: { id: true, hubInstallationId: true, lifecycle: true } });
      for (const device of privateDevices) {
        if (device.lifecycle === 'RETIRED' || device.lifecycle === 'REMOVED') continue;
        await tx.nativeDomainOutbox.upsert({ where: { idempotencyKey: `homeowner-tenant-removal:${tenantId}:${nextAccessRevision}:device:${device.id}` }, create: {
          homeId, hubInstallationId: device.hubInstallationId, aggregateType: 'NativeDevice', aggregateId: device.id,
          eventType: 'TENANT_DEVICE_DECOMMISSION', idempotencyKey: `homeowner-tenant-removal:${tenantId}:${nextAccessRevision}:device:${device.id}`,
          payload: { operation: 'REMOVE_TENANT_DEVICE', deviceId: device.id, membershipId: tenantId, policyRevision: nextAccessRevision },
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        }, update: {} });
      }
      await tx.nativeDomainOutbox.upsert({ where: { idempotencyKey: `homeowner-tenant-removal:${tenantId}:${nextAccessRevision}` }, create: {
        homeId, hubInstallationId: hub.id, aggregateType: 'HomeMembership', aggregateId: tenantId,
        eventType: 'TENANT_MEMBERSHIP_REVOKED', idempotencyKey: `homeowner-tenant-removal:${tenantId}:${nextAccessRevision}`,
        payload: { operation: 'REMOVE_TENANT_MEMBERSHIP', membershipId: tenantId, policyRevision: nextAccessRevision, managementRevision: nextManagementRevision },
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      }, update: {} });
      await tx.hubInstallation.updateMany({ where: { homeId, id: { in: [...new Set([hub.id, ...privateDevices.map((item) => item.hubInstallationId)])] } },
        data: { cleanupState: 'WAITING_FOR_TENANT_DEVICE_CLEANUP', cleanupGeneration: { increment: 1 } } });
      if (privateDevices.length) {
        const privateDeviceIds = privateDevices.map((item) => item.id);
        await deleteTenantPrivateDeviceCloudData(tx, { homeId, deviceIds: privateDeviceIds });
        await tx.nativeDevice.deleteMany({ where: { id: { in: privateDeviceIds }, homeId, ownerMembershipId: tenantId, managementClass: 'TENANT_DEVICE' } });
      }
      const supportRequests = await tx.supportAccessRequest.findMany({ where: { homeId, targetMembershipId: tenantId, status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED'] } }, select: { id: true } });
      const supportIds = supportRequests.map((item) => item.id);
      if (supportIds.length) {
        await tx.supportSession.updateMany({ where: { accessRequestId: { in: supportIds }, status: { in: ['ACTIVE', 'PENDING_HUB_REVOKE'] } }, data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
        await tx.supportAccessRequest.updateMany({ where: { id: { in: supportIds } }, data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
      }
      await tx.supportTicket.updateMany({ where: { homeId, customerAccountId: target.customerAccountId, selectedMembershipId: tenantId, status: { not: 'CLOSED' } }, data: {
        status: 'CLOSED', closedAt: now, selectedMembershipId: null, description: '[Closed when Home access was removed]', title: null,
        areaId: null, deviceId: null, safeDiagnostics: Prisma.DbNull, customerResolution: null, revision: { increment: 1 },
      } });
      await retireNativeAutomations(tx, { homeId, createdByMembershipId: tenantId, now, actorId: selected.id, reason: 'tenant_membership_removed' });
      await refreshNativeAutomationCloudRevision(tx, { homeId, hubInstallationId: hub.id });
      await tx.memberPreferenceDocument.deleteMany({ where: { membershipId: tenantId } });
      await tx.alexaNativeEndpointProjection.deleteMany({ where: { homeId, membershipId: tenantId } });
      await tx.alexaNativeHomeScope.deleteMany({ where: { homeId, membershipId: tenantId } });
      await cleanupCustomerAccountIfOrphaned(tx, target.customerAccountId, now, 'owner_removed_tenant', 'HOME_TENANT_REMOVAL_ACCOUNT_CLEANUP');
      await tx.auditEvent.create({ data: { homeId, actorType: 'CUSTOMER', actorId: selected.id, category: 'ACCESS', action: 'home_tenant_membership_removed',
        targetType: 'HomeMembership', targetId: tenantId, metadata: { outcome: 'removed', nextAccessRevision, pendingHubCleanup: true,
          privateDeviceTombstoneCount: privateDevices.filter((item) => !['RETIRED', 'REMOVED'].includes(item.lifecycle)).length },
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      const receipt = { schemaVersion: 'dinodia.v1', ok: true, homeId, tenantMembershipId: tenantId, state: 'REMOVED',
        managementRevision: nextManagementRevision, accessRevision: nextAccessRevision, hubEnforcement: 'PENDING', idempotentReplay: false } as const;
      if (!validateHomeownerTenantRemovalReceipt(receipt, homeId, tenantId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The tenant removal receipt is invalid');
      await tx.idempotencyRecord.create({ data: { namespace, keyHash, actorId: selected.id, homeId, requestHash,
        responseStatus: 200, responseDigest: sha256(JSON.stringify(receipt)), responseBody: receipt as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      return receipt;
    });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
