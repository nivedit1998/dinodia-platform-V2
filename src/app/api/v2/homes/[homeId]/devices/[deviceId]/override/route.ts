import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { NativePresentationError, setPropertyDeviceOverrideName } from '@/lib/nativePresentation';
import { homeownerIdempotencyIdentity, homeownerRequestHash, runIdempotentHomeMutation } from '@/lib/homeownerIdempotency';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function mapError(error: unknown): never {
  if (error instanceof NativePresentationError) {
    if (error.code === 'MEMBERSHIP_FORBIDDEN' || error.code === 'RESOURCE_FORBIDDEN') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This property device is unavailable for the selected Home');
    if (error.code === 'REVISION_CONFLICT') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This device changed. Reload and retry your edit.');
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The device display name is invalid');
  }
  throw error;
}

export async function PATCH(request: Request, context: { params: Promise<{ homeId: string; deviceId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, deviceId } = await context.params;
    const key = request.headers.get('idempotency-key') ?? '';
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!uuid.test(homeId) || !uuid.test(deviceId) || selected.homeId !== homeId
      || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This device is unavailable for the selected Home');
    }
    if (!body || Object.keys(body).sort().join(',') !== 'expectedInventoryRevision,overrideName'
      || !Number.isSafeInteger(body.expectedInventoryRevision) || Number(body.expectedInventoryRevision) < 1
      || !(body.overrideName === null || typeof body.overrideName === 'string')) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The current device revision and display name are required');
    const identity = homeownerIdempotencyIdentity(selected.id, key, 'homeowner-device-override:v1');
    const requestHash = homeownerRequestHash({ homeId, membershipId: selected.membershipId, deviceId, ...body });
    const result = await serializableTransaction((tx) => runIdempotentHomeMutation(tx, {
      ...identity, actorId: selected.id, homeId, requestHash,
      operation: async () => ({ schemaVersion: 'dinodia.v1', ok: true, homeId, ...await setPropertyDeviceOverrideName(tx, {
        accountId: selected.id, membershipId: selected.membershipId, homeId, deviceId,
        expectedInventoryRevision: Number(body.expectedInventoryRevision), overrideName: body.overrideName,
      }) }),
    }));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof NativePresentationError) mapError(error);
    return nativeV1ErrorResponse(error);
  }
}
