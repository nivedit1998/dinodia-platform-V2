import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { assertCustomerCanCommand, requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { ALLOWED_OPERATIONS, descriptorBoundValue, operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { prisma } from '@/lib/prisma';
import { canonicalStepUpDescriptor } from '@/lib/stage1HubAuth';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const body = await request.json() as Record<string, unknown>;
    const operationKind = String(body.operationKind ?? '').trim();
    const targetIds = Array.isArray(body.targetIds) ? [...new Set(body.targetIds.map(String).filter(Boolean))].slice(0, 20) : [];
    if (!ALLOWED_OPERATIONS.has(operationKind) || !targetIds.length) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A supported operation and target are required');
    const value = body.value ?? null;
    let operationValue: unknown = value;
    if (operationKind === 'device_sensitive_command' || operationKind === 'heating_sensitive_command') {
      assertCustomerCanCommand(customer);
      if (targetIds.length !== 1) throw new Stage1AuthError(400, 'step_up_target_invalid', 'A device step-up must target one current control');
      const devices = await prisma.nativeDevice.findMany({ where: { id: { in: targetIds }, homeId: customer.homeId, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] } }, select: { id: true } });
      if (devices.length !== new Set(targetIds).size) throw new Stage1AuthError(403, 'step_up_target_invalid', 'The device is not current in the selected home');
      const assignments = await prisma.deviceAreaAssignment.findMany({ where: { deviceId: { in: targetIds }, homeId: customer.homeId, validUntil: null, areaId: { in: customer.areaIds } }, select: { deviceId: true } });
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
      if (!signature || !crypto.verify(null, Buffer.from(canonicalStepUpDescriptor(bodyWithoutSignature), 'utf8'), crypto.createPublicKey(hub.manufacturingIdentity.signingPublicKey), Buffer.from(signature, 'base64url'))) throw new Stage1AuthError(403, 'step_up_descriptor_signature_invalid', 'The hub descriptor attestation is not authentic');
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
        return NextResponse.json({ ok: true, challengeId: challenge.id, nonce, operationDigest: digest, expiresAt: challenge.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
      } catch (error) { if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002') throw new Stage1AuthError(403, 'step_up_descriptor_replayed', 'The hub descriptor challenge has already been used'); throw error; }
    }
    if (operationKind === 'support_access_approve') {
      if (customer.role !== 'OWNER' && customer.role !== 'PROPERTY_MANAGER') throw new Stage1AuthError(403, 'support_approval_denied', 'Only a homeowner or permitted property manager can approve property support');
      if (targetIds.length !== 2) throw new Stage1AuthError(400, 'step_up_target_invalid', 'A support ticket and access request are required');
      const [ticketId, requestId] = targetIds;
      const accessRequest = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, requestedScope: true, status: true } });
      const ticket = accessRequest ? await prisma.supportTicket.findUnique({ where: { id: accessRequest.ticketId }, select: { id: true, homeId: true, status: true } }) : null;
      if (!accessRequest || !ticket || ticket.id !== ticketId || accessRequest.requestedScope !== 'PROPERTY_SCOPE' || accessRequest.status !== 'REQUESTED' || ticket.status !== 'OPEN' || ticket.homeId !== customer.homeId) throw new Stage1AuthError(403, 'support_approval_denied', 'This property support request is not available for the selected home');
      if (String(value) !== 'I approve this support access for my property') throw new Stage1AuthError(400, 'support_confirmation_required', 'Type the exact support confirmation before approving property diagnostics');
    }
    const digest = operationDigest({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetIds, value: operationValue });
    const nonce = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const challenge = await prisma.stepUpChallenge.create({ data: { customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetDigest: targetDigest(targetIds), normalizedValueDigest: digest, policyRevision: customer.policyRevision, nonceHash: crypto.createHash('sha256').update(nonce, 'utf8').digest('hex'), issuedAt: now, expiresAt: new Date(now.getTime() + 60_000) }, select: { id: true, expiresAt: true } });
    return NextResponse.json({ ok: true, challengeId: challenge.id, nonce, operationDigest: digest, expiresAt: challenge.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const challengeId = String(body.challengeId ?? '').trim();
    if (!challengeId) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A challenge is required');
    const cancelled = await prisma.stepUpChallenge.updateMany({ where: { id: challengeId, customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
    if (cancelled.count !== 1) throw new Stage1AuthError(409, 'step_up_challenge_unavailable', 'The challenge is already consumed, cancelled or unavailable');
    return NextResponse.json({ ok: true, cancelled: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
