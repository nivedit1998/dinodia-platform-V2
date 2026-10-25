import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { readHomeownerProjection, HomeownerProjectionError } from '@/lib/homeownerProjection';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } };

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!uuid.test(homeId) || selected.homeId !== homeId
      || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role)
      || selected.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Home information is unavailable for this selected membership');
    }
    const projection = await prisma.$transaction((tx) => readHomeownerProjection(tx, {
      accountId: selected.id, membershipId: selected.membershipId, homeId,
    }), { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 12000 });
    return NextResponse.json(projection, noStore);
  } catch (error) {
    if (error instanceof HomeownerProjectionError) {
      return nativeV1ErrorResponse(new Stage1AuthError(error.code === 'HOME_UNAVAILABLE' ? 409 : 404,
        error.code, 'Home information is unavailable for this selected membership'));
    }
    return nativeV1ErrorResponse(error);
  }
}
