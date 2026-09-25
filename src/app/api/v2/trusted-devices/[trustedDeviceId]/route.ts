import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { consumeStepUp } from '@/lib/sensitiveOperationStepUp';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ trustedDeviceId: string }> }) {
  try {
    const customer = await requireCustomer(request);
    const { trustedDeviceId } = await context.params;
    if (!trustedDeviceId || trustedDeviceId === customer.trustedDeviceId) throw new Stage1AuthError(400, 'trusted_device_target_invalid', 'The current phone cannot remove itself through this route');
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    await consumeStepUp({ proof: String(body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? ''), customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind: 'trusted_device_remove', targetIds: [trustedDeviceId], value: null, policyRevision: customer.policyRevision });
    const device = await prisma.trustedDevice.findUnique({ where: { id: trustedDeviceId }, select: { id: true, customerAccountId: true } });
    if (!device || device.customerAccountId !== customer.id) throw new Stage1AuthError(404, 'trusted_device_not_found', 'The trusted device was not found');
    await prisma.$transaction(async (tx) => {
      await tx.trustedDevice.update({ where: { id: trustedDeviceId }, data: { revokedAt: new Date(), sessionVersion: { increment: 1 } } });
      await tx.customerSession.updateMany({ where: { trustedDeviceId }, data: { revokedAt: new Date(), revokeReason: 'trusted_device_removed' } });
      await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'trusted_device_removed' } });
    });
    return NextResponse.json({ ok: true, trustedDeviceId, accountWide: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
