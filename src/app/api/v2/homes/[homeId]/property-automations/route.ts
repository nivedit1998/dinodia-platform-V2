import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { NativeAutomationError } from '@/lib/nativeAutomations/validation';
import { listPropertyAutomationSummaries } from '@/lib/nativeAutomations/summaries';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const actor = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!UUID.test(homeId) || homeId !== actor.homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(actor.role)
      || actor.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Property automations are unavailable for this Home');
    }
    return NextResponse.json(await listPropertyAutomationSummaries({ homeId, membershipId: actor.membershipId, accountId: actor.id, role: actor.role }),
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof NativeAutomationError) return nativeV1ErrorResponse(Object.assign(error, { status: error.status }));
    return nativeV1ErrorResponse(error);
  }
}
