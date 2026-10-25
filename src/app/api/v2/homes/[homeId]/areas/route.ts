import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateHomeInvitationAreasReceipt } from '@/lib/contracts/dinodiaV1';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { homeId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(homeId)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Areas are not available for this property');
    }
    const [home, membership] = await Promise.all([
      prisma.home.findUnique({ where: { id: homeId }, select: { id: true, lifecycle: true, installationStatus: true, managementRevision: true } }),
      prisma.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: customer.id, homeId } }, select: { id: true, status: true, role: true } }),
    ]);
    if (!home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE' || membership?.status !== 'ACTIVE'
      || !['OWNER', 'PROPERTY_MANAGER'].includes(membership.role)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Areas are not available for this property');
    }
    const areas = await prisma.area.findMany({ where: { homeId, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 64, select: { id: true, originalName: true } });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true as const, homeId, managementRevision: home.managementRevision,
      areas: areas.map((area) => ({ id: area.id, name: area.originalName })) };
    if (!validateHomeInvitationAreasReceipt(receipt, homeId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Area catalogue failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
