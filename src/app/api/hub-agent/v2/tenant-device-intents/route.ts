import { NextResponse } from 'next/server';
import { PUT as saveHomePreference } from '@/app/api/v2/homes/[homeId]/preferences/route';
import { PATCH as mutateTenantDevice } from '@/app/api/v2/homes/[homeId]/tenant-devices/[deviceId]/route';
import { POST as removeTenantDevice } from '@/app/api/v2/homes/[homeId]/tenant-devices/[deviceId]/remove/route';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN = /^dno-customer-access-[A-Za-z0-9_-]{32,160}$/;
const MAX_BODY_BYTES = 16 * 1024;
type Body = Record<string, unknown>;

function exactKeys(value: Body, keys: string[]) {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Stage1AuthError(413, 'hub_body_too_large', 'The tenant device request is too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Stage1AuthError(413, 'hub_body_too_large', 'The tenant device request is too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function jsonBody(raw: string): Body {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Body;
  } catch { /* mapped below */ }
  throw new Stage1AuthError(400, 'tenant_device_request_invalid', 'The tenant device request is invalid');
}

function relay(response: Response) {
  return response.text().then((body) => new NextResponse(body, { status: response.status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private', Pragma: 'no-cache',
  } }));
}

export async function POST(request: Request) {
  try {
    const raw = await readBoundedBody(request);
    const hub = await authenticateHub(request, raw, { maxBodyBytes: MAX_BODY_BYTES });
    const body = jsonBody(raw);
    delete body.serial;
    delete body.identityGeneration;
    const homeId = String(body.homeId ?? '');
    const membershipId = String(body.membershipId ?? '');
    const accessToken = String(body.accountAccessToken ?? '');
    const operation = String(body.operation ?? '');
    if (!UUID.test(homeId) || !UUID.test(membershipId) || !ACCESS_TOKEN.test(accessToken)
      || hub.installation.state !== 'ACTIVE' || hub.installation.homeId !== homeId) {
      throw new Stage1AuthError(400, 'tenant_device_request_invalid', 'The selected tenant device request is invalid');
    }

    const headers = new Headers({ authorization: `Bearer ${accessToken}`, 'x-dinodia-home-id': homeId, accept: 'application/json' });
    const authorityRequest = new Request(new URL(`/api/v2/homes/${homeId}/preferences`, request.url), { method: 'GET', headers });
    const selected = await requireCustomerSelectedHome(authorityRequest);
    if (selected.role !== 'TENANT' || selected.homeId !== homeId || selected.membershipId !== membershipId
      || selected.hubInstallationId !== hub.installation.id) {
      throw new Stage1AuthError(404, 'tenant_device_unavailable', 'The selected tenant device authority is no longer available');
    }

    const idempotencyKey = String(body.idempotencyKey ?? '');
    const canonicalRequest = (path: string, method: string, payload: unknown, useIdempotency = true) => {
      const requestHeaders = new Headers(headers);
      if (useIdempotency) requestHeaders.set('idempotency-key', idempotencyKey);
      return new Request(new URL(path, request.url), { method, headers: requestHeaders, body: JSON.stringify(payload) });
    };

    if (operation === 'layout_save' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation', 'expectedRevision', 'document'])
      && body.schemaVersion === 'dinodia.v1' && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 0
      && body.document && typeof body.document === 'object' && !Array.isArray(body.document)) {
      return await relay(await saveHomePreference(canonicalRequest(`/api/v2/homes/${homeId}/preferences`, 'PUT', {
        kind: 'DASHBOARD_LAYOUT', expectedRevision: body.expectedRevision, document: body.document,
      }, false), { params: Promise.resolve({ homeId }) }));
    }

    if (!UUID.test(idempotencyKey)) throw new Stage1AuthError(400, 'tenant_device_request_invalid', 'A valid device intent key is required');
    const deviceId = String(body.deviceId ?? '');
    if (!UUID.test(deviceId)) throw new Stage1AuthError(400, 'tenant_device_request_invalid', 'The selected tenant device is invalid');
    const route = `/api/v2/homes/${homeId}/tenant-devices/${deviceId}`;
    if (operation === 'presentation' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation', 'idempotencyKey', 'deviceId', 'mutation'])
      && body.schemaVersion === 'dinodia.v1' && body.mutation && typeof body.mutation === 'object' && !Array.isArray(body.mutation)) {
      return await relay(await mutateTenantDevice(canonicalRequest(route, 'PATCH', body.mutation), { params: Promise.resolve({ homeId, deviceId }) }));
    }
    if (operation === 'remove' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation', 'idempotencyKey', 'deviceId', 'request'])
      && body.schemaVersion === 'dinodia.v1' && body.request && typeof body.request === 'object' && !Array.isArray(body.request)) {
      return await relay(await removeTenantDevice(canonicalRequest(`${route}/remove`, 'POST', body.request), { params: Promise.resolve({ homeId, deviceId }) }));
    }
    throw new Stage1AuthError(400, 'tenant_device_request_invalid', 'The tenant device operation is not supported');
  } catch (error) {
    return authErrorResponse(error);
  }
}
