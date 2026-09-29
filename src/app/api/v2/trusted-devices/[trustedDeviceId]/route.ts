import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomer, Stage1AuthError } from '@/lib/stage1Auth';
import { consumeStepUp } from '@/lib/sensitiveOperationStepUp';
import { validateTrustedDeviceRemovalReceipt, validateTrustedDeviceRemovalRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ trustedDeviceId: string }> }) {
  try {
    const customer = await requireCustomer(request);
    const { trustedDeviceId } = await context.params;
    if (!trustedDeviceId || trustedDeviceId === customer.trustedDeviceId) throw new Stage1AuthError(400, 'trusted_device_target_invalid', 'The current phone cannot remove itself through this route');
    const rawBody = await request.text();
    let body: unknown = {};
    if (rawBody.trim()) {
      try { body = JSON.parse(rawBody) as unknown; }
      catch { throw new Stage1AuthError(400, 'trusted_device_request_invalid', 'The trusted-device removal request must be valid JSON'); }
    }
    if (!validateTrustedDeviceRemovalRequest(body)) throw new Stage1AuthError(400, 'trusted_device_request_invalid', 'The trusted-device removal request does not match the supported contract');
    const requestBody = body as { proof?: string };
    await consumeStepUp({ proof: String(requestBody.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? ''), customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind: 'trusted_device_remove', targetIds: [trustedDeviceId], value: null, policyRevision: customer.policyRevision });
    const device = await prisma.trustedDevice.findUnique({ where: { id: trustedDeviceId }, select: { id: true, customerAccountId: true } });
    if (!device || device.customerAccountId !== customer.id) throw new Stage1AuthError(404, 'trusted_device_not_found', 'The trusted device was not found');
    await prisma.$transaction(async (tx) => {
      await tx.trustedDevice.update({ where: { id: trustedDeviceId }, data: { revokedAt: new Date(), sessionVersion: { increment: 1 } } });
      await tx.customerSession.updateMany({ where: { trustedDeviceId }, data: { revokedAt: new Date(), revokeReason: 'trusted_device_removed' } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'trusted_device_removed' } });
    });
    const receipt = { ok: true, trustedDeviceId, accountWide: true };
    if (!validateTrustedDeviceRemovalReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The trusted-device removal response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
