import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { assertCustomerCanCommand, requireCustomer, Stage1AuthError } from '@/lib/stage1Auth';
import { prisma } from '@/lib/prisma';
import { consumeStepUp, descriptorBoundValue } from '@/lib/sensitiveOperationStepUp';
import { validateStepUpConsumeReceipt, validateStepUpConsumeRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const normalized = body && typeof body === 'object' && !Array.isArray(body)
      ? { ...body, proof: body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? undefined }
      : body;
    if (!normalized || !validateStepUpConsumeRequest(normalized)) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A supported operation and unique targets are required');
    const checkedBody = normalized as Record<string, unknown>;
    const operationKind = String(checkedBody.operationKind ?? '').trim();
    const targetIds = checkedBody.targetIds as string[];
    const proof = String(checkedBody.proof ?? '').trim();
    if (!operationKind || !targetIds.length || !proof) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'Proof, operation and target are required');
    let operationValue: unknown = checkedBody.value ?? null;
    if (operationKind === 'device_sensitive_command' || operationKind === 'heating_sensitive_command') {
      assertCustomerCanCommand(customer);
      const devices = await prisma.nativeDevice.findMany({ where: { id: { in: targetIds }, homeId: customer.homeId, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] } }, select: { id: true, descriptorDigest: true } });
      const assignments = await prisma.deviceAreaAssignment.findMany({ where: { deviceId: { in: targetIds }, homeId: customer.homeId, validUntil: null, areaId: { in: customer.areaIds } }, select: { deviceId: true } });
      if (devices.length !== new Set(targetIds).size || new Set(assignments.map((assignment) => assignment.deviceId)).size !== devices.length) throw new Stage1AuthError(403, 'step_up_target_invalid', 'The device or current area is no longer authorised');
      const suppliedDescriptors = checkedBody.descriptorDigests && typeof checkedBody.descriptorDigests === 'object' && !Array.isArray(checkedBody.descriptorDigests) ? checkedBody.descriptorDigests as Record<string, unknown> : {};
      const descriptorDigests: Record<string, string | null> = {};
      for (const device of devices) {
        if (!Object.prototype.hasOwnProperty.call(suppliedDescriptors, device.id)) throw new Stage1AuthError(409, 'step_up_descriptor_required', 'The current device descriptor is required');
        const supplied = suppliedDescriptors[device.id] == null ? null : String(suppliedDescriptors[device.id]);
        if (supplied !== (device.descriptorDigest == null ? null : String(device.descriptorDigest))) throw new Stage1AuthError(409, 'step_up_descriptor_stale', 'Refresh the device controls before confirming this operation');
        descriptorDigests[device.id] = supplied;
      }
      operationValue = descriptorBoundValue(checkedBody.value ?? null, descriptorDigests);
    }
    const result = await consumeStepUp({ proof, customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetIds, value: operationValue, policyRevision: customer.policyRevision });
    if (!validateStepUpConsumeReceipt(result)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The step-up consumption response failed contract validation');
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
