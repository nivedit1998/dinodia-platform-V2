import { NextResponse } from 'next/server';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { createInstallationRequest, listCustomerInstallationRequests, validateInstallationRequestInput } from '@/lib/nativeInstallationRequests';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!uuid.test(homeId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Installation requests are unavailable for this selected Home');
    return NextResponse.json(await listCustomerInstallationRequests(homeId, selected.membershipId), { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!uuid.test(homeId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Installation requests are unavailable for this selected Home');
    const key = request.headers.get('idempotency-key') ?? '';
    const body = validateInstallationRequestInput(await request.json());
    const result = await createInstallationRequest({ accountId: selected.id, membershipId: selected.membershipId, homeId, idempotencyKey: key, ...body });
    return NextResponse.json(result, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
