import { NextResponse } from 'next/server';
import { GET as listTenantAutomations, POST as createTenantAutomation } from '@/app/api/automations/route';
import { PUT as updateTenantAutomation, DELETE as deleteTenantAutomation } from '@/app/api/automations/[automationId]/route';
import { POST as setTenantAutomationEnabled } from '@/app/api/automations/[automationId]/enabled/route';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN = /^dno-customer-access-[A-Za-z0-9_-]{32,160}$/;
const MAX_BODY_BYTES = 48 * 1024;
type Body = Record<string, unknown>;

function exactKeys(value: Body, keys: string[]) {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Stage1AuthError(413, 'hub_body_too_large', 'The tenant automation request is too large');
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
        throw new Stage1AuthError(413, 'hub_body_too_large', 'The tenant automation request is too large');
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
  throw new Stage1AuthError(400, 'tenant_automation_request_invalid', 'The tenant automation request is invalid');
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
      throw new Stage1AuthError(400, 'tenant_automation_request_invalid', 'The selected tenant automation request is invalid');
    }

    const headers = new Headers({ authorization: `Bearer ${accessToken}`, 'x-dinodia-home-id': homeId, accept: 'application/json' });
    const authorityRequest = new Request(new URL('/api/automations', request.url), { method: 'GET', headers });
    const selected = await requireCustomerSelectedHome(authorityRequest);
    if (selected.role !== 'TENANT' || selected.homeId !== homeId || selected.membershipId !== membershipId
      || selected.hubInstallationId !== hub.installation.id) {
      throw new Stage1AuthError(404, 'tenant_automation_unavailable', 'The selected tenant automation authority is no longer available');
    }

    if (body.schemaVersion !== 'dinodia.v1') throw new Stage1AuthError(400, 'tenant_automation_request_invalid', 'The selected tenant automation request version is invalid');
    if (operation === 'list' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation'])) {
      return await relay(await listTenantAutomations(authorityRequest));
    }

    const idempotencyKey = String(body.idempotencyKey ?? '');
    if (!UUID.test(idempotencyKey)) throw new Stage1AuthError(400, 'tenant_automation_request_invalid', 'A valid automation request key is required');
    headers.set('idempotency-key', idempotencyKey);
    const automationId = String(body.automationId ?? '');
    const canonicalRequest = (path: string, method: string, payload?: unknown) => new Request(new URL(path, request.url), {
      method, headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    if (operation === 'create' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation', 'idempotencyKey', 'definition'])
      && body.definition && typeof body.definition === 'object' && !Array.isArray(body.definition)) {
      return await relay(await createTenantAutomation(canonicalRequest('/api/automations', 'POST', body.definition)));
    }
    if (!UUID.test(automationId)) throw new Stage1AuthError(400, 'tenant_automation_request_invalid', 'The selected automation is invalid');
    const route = `/api/automations/${automationId}`;
    if (operation === 'update' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation', 'idempotencyKey', 'automationId', 'expectedRevision', 'definition'])
      && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 1
      && body.definition && typeof body.definition === 'object' && !Array.isArray(body.definition)) {
      return await relay(await updateTenantAutomation(canonicalRequest(route, 'PUT', { expectedRevision: body.expectedRevision, definition: body.definition }), { params: Promise.resolve({ automationId }) }));
    }
    if (operation === 'enable' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation', 'idempotencyKey', 'automationId', 'expectedRevision', 'enabled'])
      && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 1 && typeof body.enabled === 'boolean') {
      return await relay(await setTenantAutomationEnabled(canonicalRequest(`${route}/enabled`, 'POST', { expectedRevision: body.expectedRevision, enabled: body.enabled }), { params: Promise.resolve({ automationId }) }));
    }
    if (operation === 'delete' && exactKeys(body, ['schemaVersion', 'homeId', 'membershipId', 'accountAccessToken', 'operation', 'idempotencyKey', 'automationId', 'expectedRevision'])
      && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 1) {
      return await relay(await deleteTenantAutomation(canonicalRequest(route, 'DELETE', { expectedRevision: body.expectedRevision }), { params: Promise.resolve({ automationId }) }));
    }
    throw new Stage1AuthError(400, 'tenant_automation_request_invalid', 'The tenant automation operation is not supported');
  } catch (error) {
    return authErrorResponse(error);
  }
}
