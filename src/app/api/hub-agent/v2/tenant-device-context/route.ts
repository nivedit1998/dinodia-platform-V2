import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { mapTenantDeviceContextError, readTenantDeviceContextForSelectedHome } from '@/lib/tenantDeviceContext';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN = /^dno-customer-access-[A-Za-z0-9_-]{32,160}$/;

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > 16 * 1024) throw new Stage1AuthError(413, 'hub_body_too_large', 'The tenant request is too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel().catch(() => {});
        throw new Stage1AuthError(413, 'hub_body_too_large', 'The tenant request is too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function POST(request: Request) {
  try {
    const raw = await readBoundedBody(request);
    const hub = await authenticateHub(request, raw, { maxBodyBytes: 16 * 1024 });
    const body = { ...hub.body };
    delete body.serial;
    delete body.identityGeneration;
    const homeId = String(body.homeId ?? '');
    const membershipId = String(body.membershipId ?? '');
    const accessToken = String(body.accountAccessToken ?? '');
    if (!exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken'])
      || body.schemaVersion !== 'dinodia.v1'
      || !UUID.test(homeId) || !UUID.test(membershipId) || !ACCESS_TOKEN.test(accessToken)
      || hub.installation.state !== 'ACTIVE' || hub.installation.homeId !== homeId) {
      throw new Stage1AuthError(400, 'tenant_context_request_invalid', 'The selected tenant context request is invalid');
    }

    const canonicalUrl = new URL(`/api/v2/homes/${homeId}/tenant-device-context`, request.url);
    const headers = new Headers({ authorization: `Bearer ${accessToken}`, 'x-dinodia-home-id': homeId, accept: 'application/json' });
    const authorityRequest = new Request(canonicalUrl, { method: 'GET', headers });
    const selected = await requireCustomerSelectedHome(authorityRequest);
    if (selected.role !== 'TENANT' || selected.homeId !== homeId || selected.membershipId !== membershipId
      || selected.hubInstallationId !== hub.installation.id) {
      throw new Stage1AuthError(404, 'tenant_context_unavailable', 'The selected tenant context is no longer available');
    }

    // The selected Home was verified once above. Read the projection directly
    // rather than through the canonical GET, which would verify it again.
    let projection: Awaited<ReturnType<typeof readTenantDeviceContextForSelectedHome>>;
    try { projection = await readTenantDeviceContextForSelectedHome(selected, homeId); }
    catch (error) { return nativeV1ErrorResponse(mapTenantDeviceContextError(error)); }
    return NextResponse.json(projection, { headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private', Pragma: 'no-cache',
    } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
