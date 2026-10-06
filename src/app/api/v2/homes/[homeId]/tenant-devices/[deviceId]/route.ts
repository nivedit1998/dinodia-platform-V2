import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { mutateTenantDevicePresentation, TenantDeviceMutationError } from '@/lib/tenantDeviceMutations';
import { boundedCustomerLabel } from '@/lib/nativeSchemaValidation';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_REQUEST_BYTES = 4096;

function failMutation(error: unknown): never {
  if (error instanceof TenantDeviceMutationError) {
    if (error.code === 'REVISION_CONFLICT' || error.code === 'IDEMPOTENCY_CONFLICT') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This device changed. Refresh it before trying again.');
    if (error.code === 'INVALID_AREA') throw new Stage1AuthError(403, 'AREA_DENIED', 'This Area is not available to the selected tenant membership');
    throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This tenant-owned device is not available to the selected membership');
  }
  if (error instanceof TypeError || error instanceof RangeError) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The device presentation change is invalid');
  throw error;
}

export async function PATCH(request: Request, context: { params: Promise<{ homeId: string; deviceId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, deviceId } = await context.params;
    if (!uuid.test(homeId) || !uuid.test(deviceId) || selected.homeId !== homeId || selected.role !== 'TENANT'
      || selected.credentialKind !== 'account_access') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This tenant-owned device is not available to the selected membership');
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new Stage1AuthError(413, 'VALIDATION_FAILED', 'The device update is too large');
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) throw new Stage1AuthError(413, 'VALIDATION_FAILED', 'The device update is too large');
    let body: Record<string, unknown> | null = null;
    try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch { /* mapped to canonical validation below */ }
    const idempotencyKey = request.headers.get('idempotency-key') ?? '';
    if (!keyPattern.test(idempotencyKey) || !body
      || !Number.isSafeInteger(body.expectedInventoryRevision) || Number(body.expectedInventoryRevision) < 1
      || typeof body.action !== 'string') throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current revision, supported action and idempotency key are required');
    let mutation: { action: 'rename'; overrideName: string | null } | { action: 'relabel'; customerLabel: string | null } | { action: 'move'; areaId: string };
    if (body.action === 'rename' && Object.keys(body).sort().join(',') === 'action,expectedInventoryRevision,overrideName'
      && (body.overrideName === null || typeof body.overrideName === 'string')) {
      const value = body.overrideName;
      if (typeof value === 'string') {
        const normalized = value.normalize('NFC').trim();
        if (!normalized || [...normalized].length > 80 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Use a device name from 1 to 80 printable characters');
        mutation = { action: 'rename', overrideName: normalized };
      } else mutation = { action: 'rename', overrideName: null };
    } else if (body.action === 'relabel' && Object.keys(body).sort().join(',') === 'action,customerLabel,expectedInventoryRevision') {
      try { mutation = { action: 'relabel', customerLabel: boundedCustomerLabel(body.customerLabel) }; }
      catch { throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Use a custom label from 1 to 40 printable characters, or null to clear it'); }
    } else if (body.action === 'move' && Object.keys(body).sort().join(',') === 'action,areaId,expectedInventoryRevision'
      && typeof body.areaId === 'string' && uuid.test(body.areaId)) {
      mutation = { action: 'move', areaId: body.areaId };
    } else throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Only tenant-owned name, label and permitted-Area changes are supported here');
    const response = await serializableTransaction((tx) => mutateTenantDevicePresentation(tx, {
      accountId: selected.id, sessionId: selected.sessionId, trustedDeviceId: selected.trustedDeviceId,
      tokenHash: selected.tokenHash, credentialKind: 'account_access', homeId,
      membershipId: selected.membershipId, hubInstallationId: selected.hubInstallationId,
      deviceId, expectedInventoryRevision: Number(body.expectedInventoryRevision), idempotencyKey, mutation,
    }));
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    try { failMutation(error); } catch (mapped) { return nativeV1ErrorResponse(mapped); }
  }
}
