import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { readTenantDeviceDashboard, TenantDeviceDashboardDenied } from '@/lib/tenantDeviceDashboard';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Cloud-owned authorization and display overrides; live state/descriptors remain OS-owned. */
export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!uuid.test(homeId) || selected.homeId !== homeId || selected.role !== 'TENANT'
      || selected.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant device context is not available to the selected account');
    }
    const projection = await serializableTransaction((tx) => readTenantDeviceDashboard(tx, {
      accountId: selected.id,
      sessionId: selected.sessionId,
      trustedDeviceId: selected.trustedDeviceId,
      tokenHash: selected.tokenHash,
      credentialKind: 'account_access',
      homeId,
      membershipId: selected.membershipId,
      hubInstallationId: selected.hubInstallationId,
    }));
    return NextResponse.json(projection, { headers: {
      'Cache-Control': 'no-store', Pragma: 'no-cache',
      Vary: 'Authorization, Cookie, X-Dinodia-Home-Id',
      ETag: `W/\"${projection.revision.streamId}:${projection.revision.sequence}\"`,
    } });
  } catch (error) {
    const mapped = error instanceof TenantDeviceDashboardDenied
      ? error.code === 'SESSION_REVOKED'
        ? new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active')
        : new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant device context is not available to the selected account')
      : error;
    return nativeV1ErrorResponse(mapped);
  }
}
