import { NextResponse } from 'next/server';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { cancelCustomerInstallationRequest } from '@/lib/nativeInstallationRequests';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function POST(request: Request, context: { params: Promise<{ homeId: string; requestId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, requestId } = await context.params;
    if (!uuid.test(homeId) || !uuid.test(requestId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This request is unavailable to the selected Home membership');
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join('|') !== 'expectedRevision' || !Number.isSafeInteger(body.expectedRevision)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current request revision is required');
    const result = await cancelCustomerInstallationRequest({ accountId: selected.id, membershipId: selected.membershipId, homeId, requestId, expectedRevision: Number(body.expectedRevision), idempotencyKey: request.headers.get('idempotency-key') ?? '' });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
