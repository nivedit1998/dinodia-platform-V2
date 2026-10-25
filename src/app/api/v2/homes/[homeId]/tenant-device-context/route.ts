import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { mapTenantDeviceContextError, readTenantDeviceContextForSelectedHome } from '@/lib/tenantDeviceContext';

export const dynamic = 'force-dynamic';

/** Cloud-owned authorization and display overrides; live state/descriptors remain OS-owned. */
export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    const projection = await readTenantDeviceContextForSelectedHome(selected, homeId);
    return NextResponse.json(projection, { headers: {
      'Cache-Control': 'no-store', Pragma: 'no-cache',
      Vary: 'Authorization, Cookie, X-Dinodia-Home-Id',
      ETag: `W/\"${projection.revision.streamId}:${projection.revision.sequence}\"`,
    } });
  } catch (error) {
    return nativeV1ErrorResponse(mapTenantDeviceContextError(error));
  }
}
