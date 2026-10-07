import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { assertCustomerCanCommand, Stage1AuthError } from '@/lib/stage1Auth';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { ALLOWED_OPERATIONS, descriptorBoundValue, operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { prisma } from '@/lib/prisma';
import { canonicalStepUpDescriptor } from '@/lib/stage1HubAuth';
import { canonicalHubRequest, sha256 } from '@/lib/stage1Crypto';
import { validateStepUpCancellationRequest, validateStepUpChallengeReceipt, validateStepUpChallengeRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !validateStepUpChallengeRequest(body)) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A supported operation and unique targets are required');
    const operationKind = String(body.operationKind ?? '').trim();
    const targetIds = body.targetIds as string[];
    if (!ALLOWED_OPERATIONS.has(operationKind)) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A supported operation and target are required');
    const value = body.value ?? null;
    let operationValue: unknown = value;
    if (operationKind === 'tenant_area_grants_replace') {
      const grants = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      if (!['OWNER', 'PROPERTY_MANAGER'].includes(customer.role) || targetIds.length !== 1
        || !grants || Object.keys(grants).sort().join(',') !== 'areaIds,expectedAccessRevision,expectedManagementRevision'
        || !Array.isArray(grants.areaIds) || grants.areaIds.length > 64
        || !grants.areaIds.every((id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
        || new Set(grants.areaIds).size !== grants.areaIds.length
        || !Number.isSafeInteger(grants.expectedAccessRevision) || !Number.isSafeInteger(grants.expectedManagementRevision)) {
        throw new Stage1AuthError(403, 'step_up_operation_invalid', 'A current tenant Area-grant change must be confirmed');
      }
      const [home, target, actor, areas] = await Promise.all([
        prisma.home.findFirst({ where: { id: customer.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { managementRevision: true } }),
        prisma.homeMembership.findFirst({ where: { id: targetIds[0], homeId: customer.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { accessRevision: true } }),
        prisma.homeMembership.findFirst({ where: { id: customer.membershipId, homeId: customer.homeId, customerAccountId: customer.id, role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE' }, select: { id: true } }),
        grants.areaIds.length ? prisma.area.findMany({ where: { id: { in: grants.areaIds as string[] }, homeId: customer.homeId, status: 'ACTIVE' }, select: { id: true } }) : Promise.resolve([]),
      ]);
      if (!home || !target || !actor || home.managementRevision !== grants.expectedManagementRevision
        || target.accessRevision !== grants.expectedAccessRevision || areas.length !== grants.areaIds.length) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The tenant or Area access changed. Refresh before confirming.');
      }
      operationValue = { ...grants, areaIds: [...grants.areaIds as string[]].sort() };
    }
    if (operationKind === 'home_room_access_decision') {
      const decision = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      if (!['OWNER', 'PROPERTY_MANAGER'].includes(customer.role) || targetIds.length !== 1
        || !decision || Object.keys(decision).sort().join(',') !== 'decision,expectedRevision'
        || !['APPROVE', 'REJECT'].includes(String(decision.decision))
        || typeof decision.expectedRevision !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(decision.expectedRevision)) {
        throw new Stage1AuthError(403, 'step_up_operation_invalid', 'A current selected-home Room decision must be confirmed');
      }
      const roomRequest = await prisma.areaAccessRequest.findFirst({ where: {
        id: targetIds[0], homeId: customer.homeId, status: 'PENDING', expiresAt: { gt: new Date() },
        emailVerifiedAt: { not: null }, updatedAt: new Date(decision.expectedRevision), area: { status: 'ACTIVE' },
      }, select: { id: true } });
      if (!roomRequest) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This Room request changed. Refresh before confirming.');
    }
    if (operationKind === 'home.transfer') {
      if (customer.role !== 'OWNER' || targetIds.length < 2 || targetIds[0] !== customer.homeId || targetIds[1] !== customer.membershipId
        || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Stage1AuthError(403, 'transfer_owner_required', 'Only the current homeowner can confirm a transfer for this selected Home');
      }
      const transferValue = value as Record<string, unknown>;
      if (transferValue.action === 'START') {
        const email = String(transferValue.recipientEmailNormalized ?? '').trim().toLowerCase();
        if (Object.keys(transferValue).sort().join(',') !== 'action,confirmation,expectedManagementRevision,recipientEmailNormalized'
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320
          || !Number.isSafeInteger(transferValue.expectedManagementRevision)
          || transferValue.confirmation !== `I confirm transfer of this Home to ${email}`) {
          throw new Stage1AuthError(400, 'step_up_fields_invalid', 'Confirm the exact recipient and current Home revision');
        }
        const [home, owner, recipient] = await Promise.all([
          prisma.home.findUnique({ where: { id: customer.homeId }, select: { lifecycle: true, installationStatus: true, managementRevision: true } }),
          prisma.homeMembership.findFirst({ where: { id: customer.membershipId, customerAccountId: customer.id, homeId: customer.homeId, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } }),
          prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true, status: true } }),
        ]);
        if (targetIds.length !== 2 || !home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE'
          || home.managementRevision !== transferValue.expectedManagementRevision || !owner
          || recipient?.id === customer.id || recipient?.status === 'SUSPENDED') {
          throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The owner, recipient or Home changed. Refresh before confirming.');
        }
      } else if (transferValue.action === 'CANCEL') {
        const transferId = String(transferValue.transferId ?? '');
        const expectedUpdatedAt = String(transferValue.expectedTransferUpdatedAt ?? '');
        if (Object.keys(transferValue).sort().join(',') !== 'action,confirmation,expectedTransferUpdatedAt,transferId'
          || targetIds.length !== 3 || targetIds[2] !== transferId
          || !/^[0-9a-f-]{36}$/i.test(transferId) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(expectedUpdatedAt)
          || transferValue.confirmation !== 'I cancel this ownership transfer') {
          throw new Stage1AuthError(400, 'step_up_fields_invalid', 'Confirm cancellation of the exact current transfer');
        }
        const claim = await prisma.homeClaimReference.findFirst({ where: { id: transferId, homeId: customer.homeId,
          outgoingOwnerMembershipId: customer.membershipId, purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE' }, select: { updatedAt: true } });
        if (!claim || claim.updatedAt.toISOString() !== expectedUpdatedAt) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The transfer changed. Refresh before cancelling.');
      } else {
        throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A supported transfer action is required');
      }
    }
    if (operationKind === 'device_sensitive_command' || operationKind === 'heating_sensitive_command') {
      assertCustomerCanCommand(customer);
      if (targetIds.length !== 1) throw new Stage1AuthError(400, 'step_up_target_invalid', 'A device step-up must target one current control');
      // Native OS requests address the device by its hub-local opaque
      // osDeviceId. Platform storage has a separate UUID primary key. Resolve
      // either exact identifier only inside the authenticated home + hub,
      // reject ambiguous/non-1:1 mappings, and use database UUIDs only for
      // membership-area authorization. Neither caller value grants authority.
      const databaseUuidTargets = targetIds.filter((targetId) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId));
      const identifierConditions: Array<Record<string, unknown>> = [{ osDeviceId: { in: targetIds } }];
      if (databaseUuidTargets.length) identifierConditions.push({ id: { in: databaseUuidTargets } });
      const devices = await prisma.nativeDevice.findMany({
        where: {
          homeId: customer.homeId,
          hubInstallationId: customer.hubInstallationId,
          lifecycle: 'INSTALLED',
          OR: identifierConditions,
        },
        select: { id: true, osDeviceId: true },
      });
      const resolvedIds = targetIds.map((targetId) => {
        const matches = devices.filter((device) => device.id === targetId || device.osDeviceId === targetId);
        return matches.length === 1 ? matches[0].id : null;
      });
      if (resolvedIds.some((id) => id === null) || new Set(resolvedIds).size !== targetIds.length) throw new Stage1AuthError(403, 'step_up_target_invalid', 'The device is not current in the selected home');
      const assignments = await prisma.deviceAreaAssignment.findMany({ where: { deviceId: { in: resolvedIds as string[] }, homeId: customer.homeId, validUntil: null, areaId: { in: customer.areaIds } }, select: { deviceId: true } });
      if (new Set(assignments.map((assignment) => assignment.deviceId)).size !== devices.length) throw new Stage1AuthError(403, 'step_up_area_denied', 'The device is not in an area currently granted to this tenant');
      const attestation = body.descriptorAttestation && typeof body.descriptorAttestation === 'object' && !Array.isArray(body.descriptorAttestation)
        ? body.descriptorAttestation as Record<string, unknown> : null;
      if (!attestation) throw new Stage1AuthError(409, 'step_up_descriptor_required', 'The current hub control descriptor is required');
      const hub = await prisma.hubInstallation.findUnique({ where: { id: customer.hubInstallationId }, select: { serialNumberSnapshot: true, manufacturingIdentity: { select: { identityGeneration: true, signingPublicKey: true } } } });
      const attestedTargetIds = Array.isArray(attestation.targetIds) ? attestation.targetIds.map(String) : [];
      if (!hub || String(attestation.serial) !== hub.serialNumberSnapshot || Number(attestation.identityGeneration) !== hub.manufacturingIdentity.identityGeneration || String(attestation.actorId) !== customer.id || String(attestation.customerSessionId) !== customer.sessionId || String(attestation.trustedDeviceId) !== customer.trustedDeviceId || String(attestation.homeId) !== customer.homeId || String(attestation.membershipId) !== customer.membershipId || String(attestation.hubInstallId) !== customer.hubInstallationId || String(attestation.operationKind) !== operationKind || JSON.stringify(attestedTargetIds) !== JSON.stringify(targetIds) || !attestation.controlId || !Number.isInteger(Number(attestation.descriptorRevision)) || !/^[A-Za-z0-9_-]{20,128}$/.test(String(attestation.nonce || '')) || Math.abs(Date.now() - Number(attestation.issuedAt)) > 5 * 60 * 1000) throw new Stage1AuthError(403, 'step_up_descriptor_invalid', 'The hub descriptor attestation does not match the selected session');
      const bodyWithoutSignature = { ...attestation };
      const signature = String(bodyWithoutSignature.hubSignature || '');
      delete bodyWithoutSignature.hubSignature;
      const descriptorBodyHash = sha256(canonicalStepUpDescriptor(bodyWithoutSignature));
      const signedRequest = canonicalHubRequest({ method: 'POST', path: '/api/step-up/descriptor-challenge', timestamp: Number(bodyWithoutSignature.issuedAt), nonce: String(bodyWithoutSignature.nonce), bodyHash: descriptorBodyHash });
      if (!signature || !crypto.verify(null, Buffer.from(signedRequest, 'utf8'), crypto.createPublicKey(hub.manufacturingIdentity.signingPublicKey), Buffer.from(signature, 'base64url'))) throw new Stage1AuthError(403, 'step_up_descriptor_signature_invalid', 'The hub descriptor attestation is not authentic');
      const descriptorDigests: Record<string, string | null> = { [targetIds[0]]: attestation.descriptorDigest == null ? null : String(attestation.descriptorDigest) };
      const attestedValue = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>), controlId: String(attestation.controlId) } : { value, controlId: String(attestation.controlId) };
      operationValue = descriptorBoundValue(attestedValue, descriptorDigests);
      const expectedDigest = operationDigest({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetIds, value: operationValue });
      if (String(attestation.operationDigest) !== expectedDigest) throw new Stage1AuthError(409, 'step_up_descriptor_stale', 'The hub descriptor no longer matches the requested operation');
      if (String(attestation.controlId) !== String((attestedValue as Record<string, unknown>).controlId)) throw new Stage1AuthError(409, 'step_up_control_mismatch', 'The requested control no longer matches the hub descriptor');
      const hubDescriptorNonceHash = sha256(String(attestation.nonce));
      if (await prisma.stepUpChallenge.findUnique({ where: { hubDescriptorNonceHash }, select: { id: true } })) throw new Stage1AuthError(403, 'step_up_descriptor_replayed', 'The hub descriptor challenge has already been used');
      const digest = operationDigest({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetIds, value: operationValue });
      const nonce = crypto.randomBytes(32).toString('base64url');
      const now = new Date();
      try {
        const challenge = await prisma.stepUpChallenge.create({ data: { customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetDigest: targetDigest(targetIds), normalizedValueDigest: digest, policyRevision: customer.policyRevision, nonceHash: crypto.createHash('sha256').update(nonce, 'utf8').digest('hex'), hubDescriptorNonceHash, issuedAt: now, expiresAt: new Date(now.getTime() + 60_000) }, select: { id: true, expiresAt: true } });
        const receipt = { ok: true, challengeId: challenge.id, nonce, operationDigest: digest, expiresAt: challenge.expiresAt.toISOString() };
        if (!validateStepUpChallengeReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The step-up challenge response failed contract validation');
        return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
      } catch (error) { if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002') throw new Stage1AuthError(403, 'step_up_descriptor_replayed', 'The hub descriptor challenge has already been used'); throw error; }
    }
    if (operationKind === 'support_access_approve') {
      if (targetIds.length !== 2) throw new Stage1AuthError(400, 'step_up_target_invalid', 'A support ticket and access request are required');
      const [ticketId, requestId] = targetIds;
      const accessRequest = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, requestedScope: true, targetMembershipId: true, targetUserId: true, status: true } });
      const ticket = accessRequest ? await prisma.supportTicket.findUnique({ where: { id: accessRequest.ticketId }, select: { id: true, homeId: true, status: true } }) : null;
      const isPropertyApprover = (customer.role === 'OWNER' || customer.role === 'PROPERTY_MANAGER') && accessRequest?.requestedScope === 'PROPERTY_SCOPE';
      const isOwnTenantApprover = customer.role === 'TENANT' && accessRequest?.requestedScope === 'TENANT_SCOPE'
        && accessRequest.targetMembershipId === customer.membershipId && accessRequest.targetUserId === customer.id;
      if (!accessRequest || !ticket || ticket.id !== ticketId || (!isPropertyApprover && !isOwnTenantApprover) || accessRequest.status !== 'REQUESTED' || ticket.status !== 'OPEN' || ticket.homeId !== customer.homeId) throw new Stage1AuthError(403, 'support_approval_denied', 'This support request is not available for the selected membership');
      const expectedConfirmation = accessRequest.requestedScope === 'PROPERTY_SCOPE'
        ? 'I approve this support access for my property' : 'I approve this support access for me';
      if (String(value) !== expectedConfirmation) throw new Stage1AuthError(400, 'support_confirmation_required', 'The support approval confirmation does not match this request');
    }
    if (operationKind === 'support_access_revoke') {
      if (customer.role !== 'OWNER' && customer.role !== 'PROPERTY_MANAGER') throw new Stage1AuthError(403, 'support_revoke_denied', 'Only a homeowner or permitted property manager can revoke property support');
      if (targetIds.length !== 2) throw new Stage1AuthError(400, 'step_up_target_invalid', 'A support ticket and access request are required');
      const [ticketId, requestId] = targetIds;
      const accessRequest = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, requestedScope: true, approvedByMembershipId: true, status: true } });
      const ticket = accessRequest ? await prisma.supportTicket.findUnique({ where: { id: accessRequest.ticketId }, select: { id: true, homeId: true, status: true } }) : null;
      if (!accessRequest || !ticket || ticket.id !== ticketId || accessRequest.requestedScope !== 'PROPERTY_SCOPE' || accessRequest.approvedByMembershipId !== customer.membershipId || !['APPROVED', 'ISSUED', 'REDEEMED'].includes(accessRequest.status) || ticket.status !== 'OPEN' || ticket.homeId !== customer.homeId) throw new Stage1AuthError(403, 'support_revoke_denied', 'This property support request is not available for the selected approving membership');
      if (String(value) !== 'I revoke this support access for my property') throw new Stage1AuthError(400, 'support_confirmation_required', 'Type the exact support confirmation before revoking property diagnostics');
    }
    if (operationKind === 'tenant_membership_remove') {
      if (customer.role !== 'TENANT' || targetIds.length !== 2
        || targetIds[0] !== customer.membershipId || targetIds[1] !== customer.homeId
        || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Stage1AuthError(403, 'MEMBERSHIP_FORBIDDEN', 'Only the selected tenant can confirm removal of this Home access');
      }
      const removalValue = value as Record<string, unknown>;
      if (Object.keys(removalValue).length !== 3
        || !Number.isSafeInteger(removalValue.accessRevision) || Number(removalValue.accessRevision) < 1
        || !Number.isSafeInteger(removalValue.homeManagementRevision) || Number(removalValue.homeManagementRevision) < 1
        || typeof removalValue.confirmFinalAccountDeletion !== 'boolean') {
        throw new Stage1AuthError(400, 'step_up_fields_invalid', 'The exact tenant access revision and deletion confirmation are required');
      }
      const [membership, home] = await Promise.all([
        prisma.homeMembership.findFirst({ where: { id: customer.membershipId, customerAccountId: customer.id, homeId: customer.homeId, role: 'TENANT', status: 'ACTIVE' }, select: { accessRevision: true } }),
        prisma.home.findFirst({ where: { id: customer.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { managementRevision: true } }),
      ]);
      if (!membership || !home || membership.accessRevision !== removalValue.accessRevision || home.managementRevision !== removalValue.homeManagementRevision) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Refresh the selected Home before confirming access removal');
      }
    }
    if (operationKind === 'home_tenant_remove') {
      const removal = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      if (!['OWNER', 'PROPERTY_MANAGER'].includes(customer.role) || targetIds.length !== 1
        || !removal || Object.keys(removal).sort().join(',') !== 'expectedAccessRevision,expectedManagementRevision'
        || !Number.isSafeInteger(removal.expectedAccessRevision) || Number(removal.expectedAccessRevision) < 0
        || !Number.isSafeInteger(removal.expectedManagementRevision) || Number(removal.expectedManagementRevision) < 1) {
        throw new Stage1AuthError(403, 'MEMBERSHIP_FORBIDDEN', 'Only the current owner or manager can confirm removal of a tenant from this Home');
      }
      const [actor, tenant, home] = await Promise.all([
        prisma.homeMembership.findFirst({ where: { id: customer.membershipId, customerAccountId: customer.id, homeId: customer.homeId,
          role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE' }, select: { id: true } }),
        prisma.homeMembership.findFirst({ where: { id: targetIds[0], homeId: customer.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { id: true, accessRevision: true } }),
        prisma.home.findFirst({ where: { id: customer.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { managementRevision: true } }),
      ]);
      if (!actor || !tenant || !home || tenant.accessRevision !== removal.expectedAccessRevision
        || home.managementRevision !== removal.expectedManagementRevision) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The tenant or Home changed. Refresh before confirming removal.');
      }
    }
    if (operationKind === 'home_property_manager_remove') {
      const removal = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      if (customer.role !== 'OWNER' || targetIds.length !== 1 || targetIds[0] === customer.membershipId
        || !removal || Object.keys(removal).join(',') !== 'expectedManagementRevision'
        || !Number.isSafeInteger(removal.expectedManagementRevision) || Number(removal.expectedManagementRevision) < 1) {
        throw new Stage1AuthError(403, 'MEMBERSHIP_FORBIDDEN', 'Only the original owner can confirm removal of a property manager');
      }
      const [actor, manager, home] = await Promise.all([
        prisma.homeMembership.findFirst({ where: { id: customer.membershipId, customerAccountId: customer.id, homeId: customer.homeId,
          role: 'OWNER', status: 'ACTIVE' }, select: { id: true } }),
        prisma.homeMembership.findFirst({ where: { id: targetIds[0], homeId: customer.homeId, role: 'PROPERTY_MANAGER', status: 'ACTIVE' }, select: { id: true, customerAccountId: true } }),
        prisma.home.findFirst({ where: { id: customer.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { managementRevision: true } }),
      ]);
      if (!actor || !manager || manager.customerAccountId === customer.id || !home
        || home.managementRevision !== removal.expectedManagementRevision) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The manager or Home changed. Refresh before confirming removal.');
      }
    }
    if (operationKind === 'tenant_device_remove') {
      if (customer.role !== 'TENANT' || targetIds.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Stage1AuthError(403, 'tenant_device_owner_required', 'Only the selected owner-tenant can confirm removal of a privately owned device');
      }
      const removalValue = value as Record<string, unknown>;
      if (Object.keys(removalValue).sort().join(',') !== 'descriptorRevision,operation'
        || removalValue.operation !== 'remove_tenant_device'
        || !Number.isSafeInteger(removalValue.descriptorRevision) || Number(removalValue.descriptorRevision) < 1) {
        throw new Stage1AuthError(400, 'step_up_fields_invalid', 'Confirm removal of the exact current private device descriptor');
      }
      const device = await prisma.nativeDevice.findFirst({ where: {
        osDeviceId: targetIds[0], homeId: customer.homeId, hubInstallationId: customer.hubInstallationId,
        managementClass: 'TENANT_DEVICE', ownerMembershipId: customer.membershipId, lifecycle: 'INSTALLED',
        descriptorRevision: Number(removalValue.descriptorRevision),
        assignments: { some: { validUntil: null, areaId: { in: customer.areaIds }, area: { status: 'ACTIVE' } } },
      }, select: { id: true } });
      if (!device) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The device or its selected Area access changed. Refresh before confirming removal.');
    }
    if (operationKind === 'support_ticket_close') {
      if (targetIds.length !== 1) throw new Stage1AuthError(400, 'step_up_target_invalid', 'A single selected-home support request is required');
      const ticket = await prisma.supportTicket.findFirst({ where: {
        id: targetIds[0], customerAccountId: customer.id, homeId: customer.homeId,
        selectedMembershipId: customer.membershipId, status: { not: 'CLOSED' },
      }, select: { id: true } });
      if (!ticket) throw new Stage1AuthError(404, 'support_ticket_not_found', 'This support request is not available to the selected account and Home');
    }
    const digest = operationDigest({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetIds, value: operationValue });
    const nonce = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const challenge = await prisma.stepUpChallenge.create({ data: { customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetDigest: targetDigest(targetIds), normalizedValueDigest: digest, policyRevision: customer.policyRevision, nonceHash: crypto.createHash('sha256').update(nonce, 'utf8').digest('hex'), issuedAt: now, expiresAt: new Date(now.getTime() + 60_000) }, select: { id: true, expiresAt: true } });
    const receipt = { ok: true, challengeId: challenge.id, nonce, operationDigest: digest, expiresAt: challenge.expiresAt.toISOString() };
    if (!validateStepUpChallengeReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The step-up challenge response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !validateStepUpCancellationRequest(body)) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A valid challenge identifier is required');
    const challengeId = String(body.challengeId ?? '').trim();
    if (!challengeId) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A challenge is required');
    const cancelled = await prisma.stepUpChallenge.updateMany({ where: { id: challengeId, customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
    if (cancelled.count !== 1) throw new Stage1AuthError(409, 'step_up_challenge_unavailable', 'The challenge is already consumed, cancelled or unavailable');
    return NextResponse.json({ ok: true, cancelled: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
