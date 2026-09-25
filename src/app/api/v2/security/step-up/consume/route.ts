import { NextResponse } from 'next/server';
import { assertCustomerCanCommand, requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { prisma } from '@/lib/prisma';
import { consumeStepUp, descriptorBoundValue } from '@/lib/sensitiveOperationStepUp';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const body = await request.json() as Record<string, unknown>;
    const operationKind = String(body.operationKind ?? '').trim();
    const targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String).slice(0, 20) : [];
    const proof = String(body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? '').trim();
    if (!operationKind || !targetIds.length || !proof) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'Proof, operation and target are required');
    let operationValue: unknown = body.value ?? null;
    if (operationKind === 'device_sensitive_command' || operationKind === 'heating_sensitive_command') {
      assertCustomerCanCommand(customer);
      const devices = await prisma.nativeDevice.findMany({ where: { id: { in: targetIds }, homeId: customer.homeId, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] } }, select: { id: true, descriptorDigest: true } });
      const assignments = await prisma.deviceAreaAssignment.findMany({ where: { deviceId: { in: targetIds }, homeId: customer.homeId, validUntil: null, areaId: { in: customer.areaIds } }, select: { deviceId: true } });
      if (devices.length !== new Set(targetIds).size || new Set(assignments.map((assignment) => assignment.deviceId)).size !== devices.length) throw new Stage1AuthError(403, 'step_up_target_invalid', 'The device or current area is no longer authorised');
      const suppliedDescriptors = body.descriptorDigests && typeof body.descriptorDigests === 'object' && !Array.isArray(body.descriptorDigests) ? body.descriptorDigests as Record<string, unknown> : {};
      const descriptorDigests: Record<string, string | null> = {};
      for (const device of devices) {
        if (!Object.prototype.hasOwnProperty.call(suppliedDescriptors, device.id)) throw new Stage1AuthError(409, 'step_up_descriptor_required', 'The current device descriptor is required');
        const supplied = suppliedDescriptors[device.id] == null ? null : String(suppliedDescriptors[device.id]);
        if (supplied !== (device.descriptorDigest == null ? null : String(device.descriptorDigest))) throw new Stage1AuthError(409, 'step_up_descriptor_stale', 'Refresh the device controls before confirming this operation');
        descriptorDigests[device.id] = supplied;
      }
      operationValue = descriptorBoundValue(body.value ?? null, descriptorDigests);
    }
    const result = await consumeStepUp({ proof, customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind, targetIds, value: operationValue, policyRevision: customer.policyRevision });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
