import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateHomeownerManagerRemovalReceipt, validateHomeownerManagerRemovalRequest } from '@/lib/contracts/dinodiaV1';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { cleanupCustomerAccountIfOrphaned } from '@/lib/customerRelationshipCleanup';
import { queueHomeownerAccessRemovalNotices } from '@/lib/homeownerAccessRemovalNotices';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMESPACE = 'homeowner-property-manager-remove:v1';

export async function DELETE(request: Request, context: { params: Promise<{ homeId: string; managerId: string }> }) {
  try {
    const principal = await requireCustomerAccountSession(request);
    const { homeId, managerId } = await context.params;
    const body = await request.json().catch(() => null);
    if (!UUID.test(homeId) || !UUID.test(managerId) || !validateHomeownerManagerRemovalRequest(body)
      || principal.credentialKind !== 'access' || request.headers.get('x-dinodia-home-id') !== homeId) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Property-manager removal is not available');
    }
    const keyHash = sha256(`${principal.id}:${homeId}:${body.idempotencyKey}`);
    const requestHash = sha256(JSON.stringify({ homeId, managerId, expectedManagementRevision: body.expectedManagementRevision }));
    const receipt = await serializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${homeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${principal.trustedDeviceId}::uuid FOR UPDATE`;
      const now = new Date();
      const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: NAMESPACE, keyHash } },
        select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
      if (prior) {
        if (prior.actorId !== principal.id || prior.homeId !== homeId || prior.requestHash !== requestHash || prior.expiresAt <= now
          || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)
          || !validateHomeownerManagerRemovalReceipt(prior.responseBody, homeId, managerId)) {
          throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This manager-removal key was already used for another request');
        }
        return { ...(prior.responseBody as unknown as import('@/lib/contracts/dinodiaV1').HomeownerManagerRemovalReceipt), idempotentReplay: true };
      }

      const tokenHash = principal.credentialKind === 'access' ? principal.accessTokenHash : principal.refreshTokenHash;
      const tokenExpiry = principal.credentialKind === 'access' ? principal.accessTokenExpiresAt : principal.expiresAt;
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "customerAccountId" = ${principal.id}::uuid AND "homeId" = ${homeId}::uuid FOR UPDATE`;
      const actorMembership = await tx.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: principal.id, homeId } },
        select: { id: true, role: true, status: true, accessRevision: true } });
      const [home, hub, account, session, trusted, manager] = await Promise.all([
        tx.home.findFirst({ where: { id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, managementRevision: true, activeHubInstallationId: true } }),
        tx.hubInstallation.findFirst({ where: { homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true, accessPolicyRevision: true } }),
        tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, status: true, securityVersion: true } }),
        tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { customerAccountId: true, trustedDeviceId: true, accessTokenHash: true, accessTokenExpiresAt: true, refreshTokenHash: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { customerAccountId: true, revokedAt: true, sessionVersion: true } }),
        tx.homeMembership.findFirst({ where: { id: managerId, homeId, role: 'PROPERTY_MANAGER', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } },
          select: { id: true, customerAccountId: true, accessRevision: true } }),
      ]);
      const policy = currentCustomerPolicy();
      const acceptance = policy && await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
        customerAccountId: principal.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
      } }, select: { id: true } });
      const currentToken = principal.credentialKind === 'access'
        ? Boolean(session?.accessTokenHash && session.accessTokenHash === tokenHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
        : Boolean(session?.refreshTokenHash === tokenHash && session.expiresAt > now);
      if (!actorMembership || actorMembership.status !== 'ACTIVE' || actorMembership.role !== 'OWNER' || !home || !hub
        || home.activeHubInstallationId !== hub.id || home.managementRevision !== body.expectedManagementRevision
        || !manager || manager.customerAccountId === principal.id || !account || account.status !== 'ACTIVE'
        || account.securityVersion !== principal.securityVersion || !session || !currentToken
        || session.customerAccountId !== principal.id || session.trustedDeviceId !== principal.trustedDeviceId
        || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== trusted?.sessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !trusted || trusted.customerAccountId !== principal.id || trusted.revokedAt
        || !tokenExpiry || tokenExpiry <= now || !policy || !acceptance) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The selected Home, manager or trusted session changed. Refresh before retrying.');
      }

      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${NAMESPACE}:${keyHash}`}, 0)) IS NULL AS acquired`;
      const lockedManager = await tx.homeMembership.findFirst({ where: { id: managerId, homeId, role: 'PROPERTY_MANAGER', status: 'ACTIVE' },
        select: { id: true, customerAccountId: true } });
      if (!lockedManager || lockedManager.customerAccountId !== manager.customerAccountId) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The manager changed. Refresh before retrying.');
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${managerId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${manager.customerAccountId}::uuid FOR UPDATE`;
      const proofValue = { expectedManagementRevision: body.expectedManagementRevision };
      const digest = operationDigest({ customerAccountId: principal.id, customerSessionId: principal.sessionId,
        trustedDeviceId: principal.trustedDeviceId, homeId, membershipId: actorMembership.id,
        hubInstallationId: hub.id, operationKind: 'home_property_manager_remove', targetIds: [managerId], value: proofValue });
      const proofUse = await tx.stepUpAuthorization.updateMany({ where: {
        nonceHash: sha256(body.proof), customerAccountId: principal.id, customerSessionId: principal.sessionId,
        trustedDeviceId: principal.trustedDeviceId, homeId, membershipId: actorMembership.id,
        operationKind: 'home_property_manager_remove', targetDigest: targetDigest([managerId]), normalizedValueDigest: digest,
        policyRevision: Math.max(hub.accessPolicyRevision, actorMembership.accessRevision), consumedAt: null, revokedAt: null, expiresAt: { gt: now },
      }, data: { consumedAt: now } });
      if (proofUse.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'A fresh trusted-phone confirmation for this exact manager removal is required');

      const nextRevision = home.managementRevision + 1;
      const changed = await tx.home.updateMany({ where: { id: homeId, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
      if (changed.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The Home management revision changed. Refresh and retry.');
      await tx.homeMembership.update({ where: { id: managerId }, data: { status: 'REMOVED', removedAt: now,
        removalReason: 'owner_removed_property_manager', accessRevision: { increment: 1 } } });
      await queueHomeownerAccessRemovalNotices(tx, { homeId, membershipId: managerId, customerAccountId: manager.customerAccountId,
        revision: manager.accessRevision + 1, kind: 'PROPERTY_MANAGER', now });
      await tx.membershipInvitation.updateMany({ where: { inviterMembershipId: managerId, state: 'PENDING' },
        data: { state: 'REVOKED', revokedAt: now } });
      await tx.areaAccessRequest.updateMany({ where: { homeId, requesterAccountId: manager.customerAccountId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: now } });
      const supportRequests = await tx.supportAccessRequest.findMany({ where: { homeId, approvedByMembershipId: managerId,
        status: { in: ['APPROVED', 'ISSUED', 'REDEEMED'] } }, select: { id: true } });
      const supportIds = supportRequests.map((item) => item.id);
      if (supportIds.length) {
        await tx.supportSession.updateMany({ where: { accessRequestId: { in: supportIds }, status: { in: ['ACTIVE', 'PENDING_HUB_REVOKE'] } },
          data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
        await tx.supportAccessRequest.updateMany({ where: { id: { in: supportIds } },
          data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
      }
      await tx.stepUpChallenge.updateMany({ where: { customerAccountId: manager.customerAccountId, homeId, membershipId: managerId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await tx.stepUpAuthorization.updateMany({ where: { customerAccountId: manager.customerAccountId, homeId, membershipId: managerId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { membershipId: managerId, homeId, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'owner_removed_property_manager', policyRevision: nextRevision } });
      await tx.alexaNativeEndpointProjection.deleteMany({ where: { homeId, membershipId: managerId } });
      await tx.alexaNativeHomeScope.deleteMany({ where: { homeId, membershipId: managerId } });
      await tx.memberPreferenceDocument.deleteMany({ where: { membershipId: managerId } });
      await tx.nativeAutomation.deleteMany({ where: { homeId, createdByMembershipId: managerId } });
      const ownerMembership = await tx.homeMembership.findFirst({ where: { homeId, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } });
      if (ownerMembership) {
        const assignment = await tx.memberPreferenceDocument.findUnique({ where: { membershipId_kind: { membershipId: ownerMembership.id, kind: 'MANAGER_NOTIFICATION_ASSIGNMENT' } },
          select: { id: true, revision: true, document: true } });
        if (assignment?.document && typeof assignment.document === 'object' && !Array.isArray(assignment.document)) {
          const doc = assignment.document as { version?: unknown; assignments?: unknown };
          if (doc.version === 1 && Array.isArray(doc.assignments)) {
            const assignments = doc.assignments.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
              && (item as { membershipId?: unknown }).membershipId !== managerId);
            if (assignments.length !== doc.assignments.length) await tx.memberPreferenceDocument.update({ where: { id: assignment.id },
              data: { document: { version: 1, assignments } as Prisma.InputJsonValue, revision: { increment: 1 } } });
          }
        }
      }
      await tx.auditEvent.create({ data: { homeId, actorType: 'CUSTOMER', actorId: principal.id, category: 'ACCESS',
        action: 'home_property_manager_removed', targetType: 'HomeMembership', targetId: managerId,
        metadata: { outcome: 'removed', managementRevision: nextRevision, supportRevocationPending: supportIds.length > 0 },
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      const result = { schemaVersion: 'dinodia.v1', ok: true, homeId, managerMembershipId: managerId, state: 'REMOVED',
        managementRevision: nextRevision, idempotentReplay: false } as const;
      if (!validateHomeownerManagerRemovalReceipt(result, homeId, managerId)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The manager-removal receipt failed validation');
      await tx.idempotencyRecord.create({ data: { namespace: NAMESPACE, keyHash, actorId: principal.id, homeId, requestHash,
        responseStatus: 200, responseDigest: sha256(JSON.stringify(result)), responseBody: result as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      await cleanupCustomerAccountIfOrphaned(tx, manager.customerAccountId, now, 'owner_removed_property_manager', 'HOME_PROPERTY_MANAGER_REMOVAL_ACCOUNT_CLEANUP');
      return result;
    });
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
