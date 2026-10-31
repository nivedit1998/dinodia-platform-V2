import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Stage1AuthError, requireCustomerAccountSession } from '@/lib/stage1Auth';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { sha256 } from '@/lib/stage1Crypto';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { validateTenantMembershipRemovalPreview, validateTenantMembershipRemovalReceipt, validateTenantMembershipRemovalRequest } from '@/lib/contracts/dinodiaV1';
import { deleteTenantPrivateDeviceCloudData } from '@/lib/nativeTenantDeviceCleanup';
import { retireNativeAutomations } from '@/lib/nativeAutomations/lifecycle';
import { refreshNativeAutomationCloudRevision } from '@/lib/nativeAutomations/delivery';
import { retireAlexaLinksWithoutHomes } from '@/lib/alexa/accountRemovalReport';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION = 'tenant_membership_remove';
const IDEMPOTENCY_NAMESPACE = 'customer-tenant-membership-remove';
const RELATIONSHIP_MS = 365 * 24 * 60 * 60 * 1000;

type RelationshipDb = Pick<Prisma.TransactionClient, 'homeMembership'|'membershipInvitation'|'areaAccessRequest'|'pendingHomeSetup'>;

async function relationshipState(db: RelationshipDb, accountId: string, emailNormalized: string, excludingMembershipId: string, now: Date) {
  const [activeMemberships, invitations, roomRequests, pendingSetups] = await Promise.all([
    db.homeMembership.count({ where: { customerAccountId: accountId, status: 'ACTIVE', id: { not: excludingMembershipId } } }),
    db.membershipInvitation.count({ where: {
      state: 'PENDING', expiresAt: { gt: now },
      OR: [{ targetAccountId: accountId }, { targetEmailNormalized: emailNormalized }],
      home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' },
    } }),
    db.areaAccessRequest.count({ where: {
      requesterAccountId: accountId, status: 'PENDING', expiresAt: { gt: now },
      area: { status: 'ACTIVE', home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } },
      qrCredential: { status: 'ACTIVE' },
    } }),
    db.pendingHomeSetup.count({ where: {
      customerAccountId: accountId, state: { in: ['PROFILE_REQUIRED', 'ADDRESS_REQUIRED', 'POLICY_REQUIRED', 'PENDING_INSTALLATION', 'READY_TO_ACTIVATE'] },
      expiredAt: null, reservation: { state: 'ACTIVE', expiresAt: { gt: now } },
    } }),
  ]);
  return { activeMemberships, invitations, roomRequests, pendingSetups,
    remains: activeMemberships + invitations + roomRequests + pendingSetups > 0 };
}

function noStore() { return { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } }; }

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!UUID.test(homeId) || homeId !== customer.homeId || customer.role !== 'TENANT') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant access removal is not available for this Home');
    }
    const [membership, home, account] = await Promise.all([
      prisma.homeMembership.findFirst({ where: { id: customer.membershipId, customerAccountId: customer.id, homeId, role: 'TENANT', status: 'ACTIVE' }, select: { id: true, accessRevision: true } }),
      prisma.home.findFirst({ where: { id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { postcode: true, managementRevision: true } }),
      prisma.customerAccount.findUnique({ where: { id: customer.id }, select: { emailNormalized: true } }),
    ]);
    if (!membership || !home || !account) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant access removal is not available for this Home');
    // Leaving a Home never deletes the account (DECISIONS D27): the tenant lands on the no-homes page and keeps their name and
    // password. The contract still ties the two flags together, so the account itself is what "remains".
    const preview = { schemaVersion: 'dinodia.v1', homeMembershipId: membership.id,
      homePostcode: home.postcode, accessRevision: membership.accessRevision,
      homeManagementRevision: home.managementRevision, willDeleteAccount: false,
      otherRelationshipsRemain: true };
    if (!validateTenantMembershipRemovalPreview(preview)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The tenant access removal preview failed validation');
    return NextResponse.json(preview, noStore());
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const accountSession = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!validateTenantMembershipRemovalRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The exact Home access removal request is required');
    const { homeId } = await context.params;
    if (!UUID.test(homeId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant access removal is not available for this Home');
    const keyHash = sha256(`${accountSession.id}:${homeId}:${body.idempotencyKey}`);
    // The idempotency binding includes the route Home, while the step-up value
    // must exactly match the three fields issued by the challenge endpoint.
    const proofValue = { accessRevision: body.expectedAccessRevision, homeManagementRevision: body.expectedManagementRevision,
      confirmFinalAccountDeletion: body.confirmFinalAccountDeletion };
    const requestHash = sha256(JSON.stringify({ ...proofValue, homeId }));
    const previous = await prisma.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: IDEMPOTENCY_NAMESPACE, keyHash } }, select: { actorId: true, requestHash: true, responseStatus: true, responseBody: true } });
    if (previous) {
      if (previous.actorId !== accountSession.id || previous.requestHash !== requestHash || !previous.responseBody
        || !validateTenantMembershipRemovalReceipt(previous.responseBody)) {
        throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This removal key was already used for a different request');
      }
      const previousReceipt = previous.responseBody as unknown as import('@/lib/contracts/dinodiaV1').TenantMembershipRemovalReceipt;
      return NextResponse.json({ ...previousReceipt, idempotentReplay: true }, { ...noStore(), status: previous.responseStatus });
    }
    const selected = await requireCustomerSelectedHome(request);
    if (selected.id !== accountSession.id || selected.homeId !== homeId || selected.role !== 'TENANT') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant access removal is not available for this Home');
    }
    const membershipId = selected.membershipId;

    const proof = body.proof;
    const proofHash = sha256(proof);
    const value = proofValue;
    const digest = operationDigest({ customerAccountId: selected.id, customerSessionId: selected.sessionId,
      trustedDeviceId: selected.trustedDeviceId, homeId, membershipId, hubInstallationId: selected.hubInstallationId,
      operationKind: OPERATION, targetIds: [membershipId, homeId], value });

    const receipt = await serializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${selected.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${selected.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${selected.trustedDeviceId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${membershipId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${homeId}::uuid FOR UPDATE`;
      const now = new Date();
      const [account, session, device, membership, home] = await Promise.all([
        tx.customerAccount.findUnique({ where: { id: selected.id }, select: { id: true, status: true, securityVersion: true, emailNormalized: true } }),
        tx.customerSession.findUnique({ where: { id: selected.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: selected.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
        tx.homeMembership.findUnique({ where: { id: membershipId }, select: { id: true, customerAccountId: true, homeId: true, role: true, status: true, accessRevision: true } }),
        tx.home.findUnique({ where: { id: homeId }, select: { lifecycle: true, installationStatus: true, managementRevision: true, activeHubInstallationId: true } }),
      ]);
      const currentCredential = session && (selected.credentialKind === 'account_access'
        ? selected.tokenHash === session.accessTokenHash && Boolean(session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
        : selected.credentialKind === 'account_refresh'
          ? selected.tokenHash === session.refreshTokenHash && session.expiresAt > now
          : selected.tokenHash === session.accessTokenHash ? Boolean(session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
            : selected.tokenHash === session.refreshTokenHash);
      const acceptedPolicy = currentCustomerPolicy();
      const policyAcceptance = acceptedPolicy ? await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
        customerAccountId: selected.id, policyKind: 'DINODIA_NATIVE', policyVersion: acceptedPolicy.version,
      } }, select: { id: true } }) : null;
      if (!account || account.status !== 'ACTIVE' || account.securityVersion !== session?.securityVersion
        || !session || session.customerAccountId !== selected.id || session.trustedDeviceId !== selected.trustedDeviceId
        || !currentCredential || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !device || device.customerAccountId !== selected.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion
        || !membership || membership.customerAccountId !== selected.id || membership.homeId !== homeId || membership.role !== 'TENANT'
        || membership.status !== 'ACTIVE' || membership.accessRevision !== body.expectedAccessRevision
        || !home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE'
        || home.activeHubInstallationId !== selected.hubInstallationId || home.managementRevision !== body.expectedManagementRevision
        || !policyAcceptance || !acceptedPolicy) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Your Home access, session or policy changed. Refresh before trying again.');
      }
      // Relationship creators serialize on the same CustomerAccount row
      // before inserting memberships, reservations, or Room requests. The
      // serializable transaction retries if a concurrent writer changed that
      // account while this transaction waited, so final-account deletion is
      // decided from a consistent relationship snapshot.
      const proofUse = await tx.stepUpAuthorization.updateMany({ where: {
        nonceHash: proofHash, customerAccountId: selected.id, customerSessionId: selected.sessionId,
        trustedDeviceId: selected.trustedDeviceId, homeId, membershipId, operationKind: OPERATION,
        targetDigest: targetDigest([membershipId, homeId]), normalizedValueDigest: digest,
        policyRevision: selected.policyRevision, consumedAt: null, revokedAt: null, expiresAt: { gt: now },
      }, data: { consumedAt: now } });
      if (proofUse.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'A fresh confirmation for this exact Home access removal is required');

      const nextAccessRevision = membership.accessRevision + 1;
      const nextManagementRevision = home.managementRevision + 1;
      const changedHome = await tx.home.updateMany({ where: { id: homeId, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
      if (changedHome.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The Home changed. Refresh before removing access.');
      await tx.homeMembership.update({ where: { id: membership.id }, data: { status: 'REMOVED', removedAt: now,
        removalReason: 'tenant_self_removal', accessRevision: { increment: 1 } } });
      await tx.tenantAreaGrant.updateMany({ where: { membershipId: membership.id, homeId, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'tenant_self_removal', policyRevision: nextAccessRevision } });

      const privateDevices = await tx.nativeDevice.findMany({ where: { homeId, ownerMembershipId: membership.id,
        managementClass: 'TENANT_DEVICE' }, select: { id: true, hubInstallationId: true, lifecycle: true, osDeviceId: true,
          assignments: { where: { validUntil: null }, select: { areaId: true } } } });
      const affectedHubIds = new Set<string>([selected.hubInstallationId]);
      for (const deviceRow of privateDevices) {
        affectedHubIds.add(deviceRow.hubInstallationId);
        if (deviceRow.lifecycle === 'RETIRED' || deviceRow.lifecycle === 'REMOVED') continue;
        await tx.nativeDomainOutbox.upsert({ where: { idempotencyKey: `tenant-membership-removal:${membership.id}:${nextAccessRevision}:device:${deviceRow.id}` }, create: {
          homeId, hubInstallationId: deviceRow.hubInstallationId, aggregateType: 'NativeDevice', aggregateId: deviceRow.id,
          eventType: 'TENANT_DEVICE_DECOMMISSION', idempotencyKey: `tenant-membership-removal:${membership.id}:${nextAccessRevision}:device:${deviceRow.id}`,
          payload: { operation: 'REMOVE_TENANT_DEVICE', deviceId: deviceRow.id, osDeviceId: deviceRow.osDeviceId,
            areaIds: deviceRow.assignments.map((assignment) => assignment.areaId), membershipId: membership.id,
            policyRevision: nextAccessRevision, managementRevision: nextManagementRevision },
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        }, update: {} });
      }
      await tx.nativeDomainOutbox.upsert({ where: { idempotencyKey: `tenant-membership-removal:${membership.id}:${nextAccessRevision}` }, create: {
        homeId, hubInstallationId: selected.hubInstallationId, aggregateType: 'HomeMembership', aggregateId: membership.id,
        eventType: 'TENANT_MEMBERSHIP_REVOKED', idempotencyKey: `tenant-membership-removal:${membership.id}:${nextAccessRevision}`,
        payload: { operation: 'REMOVE_TENANT_MEMBERSHIP', membershipId: membership.id, policyRevision: nextAccessRevision, managementRevision: nextManagementRevision },
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      }, update: {} });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { membershipId: membership.id, homeId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'tenant_self_removal', policyRevision: nextAccessRevision } });
      await tx.hubInstallation.updateMany({ where: { homeId, id: { in: [...affectedHubIds] } }, data: {
        cleanupState: 'WAITING_FOR_TENANT_DEVICE_CLEANUP', cleanupGeneration: { increment: 1 },
      } });
      if (privateDevices.length) {
        const privateDeviceIds = privateDevices.map((deviceRow) => deviceRow.id);
        await deleteTenantPrivateDeviceCloudData(tx, { homeId, deviceIds: privateDeviceIds });
        await tx.nativeDevice.deleteMany({ where: { id: { in: privateDeviceIds }, homeId, ownerMembershipId: membership.id, managementClass: 'TENANT_DEVICE' } });
      }

      const accessRequests = await tx.supportAccessRequest.findMany({ where: { homeId, targetMembershipId: membership.id,
        status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED'] } }, select: { id: true, ticketId: true } });
      const requestIds = accessRequests.map((row) => row.id);
      if (requestIds.length) {
        await tx.supportSession.updateMany({ where: { accessRequestId: { in: requestIds }, status: 'ACTIVE' }, data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
        await tx.supportAccessRequest.updateMany({ where: { id: { in: requestIds }, status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED'] } }, data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
      }
      await tx.supportTicket.updateMany({ where: { customerAccountId: selected.id, homeId, selectedMembershipId: membership.id, status: { not: 'CLOSED' } }, data: {
        status: 'CLOSED', closedAt: now, selectedMembershipId: null, description: '[Closed when tenant access was removed]',
        title: null, areaId: null, deviceId: null, safeDiagnostics: Prisma.DbNull, customerResolution: null, revision: { increment: 1 },
      } });
      await retireNativeAutomations(tx, { homeId, createdByMembershipId: membership.id, now, actorId: selected.id, reason: 'tenant_self_removal' });
      await refreshNativeAutomationCloudRevision(tx, { homeId, hubInstallationId: selected.hubInstallationId });
      await tx.memberPreferenceDocument.deleteMany({ where: { membershipId: membership.id } });
      await tx.alexaNativeEndpointProjection.deleteMany({ where: { homeId, membershipId: membership.id } });
      await tx.alexaNativeHomeScope.deleteMany({ where: { homeId, membershipId: membership.id } });
      // Their last Home: Alexa has nothing left to follow, so tell it the devices are gone and retire the link (the account stays).
      await retireAlexaLinksWithoutHomes(tx, account.id, now);

      const stillRelated = await relationshipState(tx, account.id, account.emailNormalized, membership.id, now);
      await tx.auditEvent.create({ data: { homeId, actorType: 'CUSTOMER', actorId: account.id, category: 'ACCESS', action: 'tenant_membership_self_removed', targetType: 'HomeMembership', targetId: membership.id,
        metadata: { outcome: 'removed', nextAccessRevision, decommissionTombstones: privateDevices.length, hubEnforcement: 'PENDING' }, purgeAt: new Date(now.getTime() + RELATIONSHIP_MS) } });
      const result = {
        schemaVersion: 'dinodia.v1', ok: true, state: 'REMOVED', homeMembershipId: membership.id,
        accountDeleted: false, otherRelationshipsRemain: true,
        nextAction: stillRelated.activeMemberships > 0 ? 'SELECT_HOME' as const : 'PENDING_RELATIONSHIPS' as const,
        hubEnforcement: 'PENDING' as const, anonymousReference: null, idempotentReplay: false,
      };
      if (!validateTenantMembershipRemovalReceipt(result)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The tenant access removal receipt failed validation');
      await tx.idempotencyRecord.create({ data: { namespace: IDEMPOTENCY_NAMESPACE, keyHash, actorId: account.id,
        homeId, requestHash, responseStatus: 200, responseDigest: sha256(JSON.stringify(result)),
        responseBody: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      return result;
    });
    return NextResponse.json(receipt, noStore());
  } catch (error) { return nativeV1ErrorResponse(error); }
}
