import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { readHomeownerProjection, HomeownerProjectionError } from '@/lib/homeownerProjection';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ homeId: string; deviceId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, deviceId } = await context.params;
    if (!UUID.test(homeId) || !UUID.test(deviceId) || selected.homeId !== homeId
      || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Device information is unavailable for this selected Home');
    }
    const projection = await prisma.$transaction((tx) => readHomeownerProjection(tx, {
      accountId: selected.id, membershipId: selected.membershipId, homeId,
    }), { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 12000 });
    const device = projection.devices.find((item) => item.id === deviceId);
    if (!device) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Device information is unavailable for this selected Home');
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, homeId, device },
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof HomeownerProjectionError) return nativeV1ErrorResponse(new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Device information is unavailable for this selected Home'));
    return nativeV1ErrorResponse(error);
  }
}
