import { POST as decideRequest } from '../../../area-access-requests/route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ homeId: string; requestId: string }> }) {
  try {
    // Resolve the account session before parsing route/body details so this
    // compatibility path has the same anonymous boundary as its canonical owner.
    await requireCustomerAccountSession(request);
    const { homeId, requestId } = await context.params;
    if (!UUID.test(homeId) || !UUID.test(requestId)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid Room request is required');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || ('requestId' in body && body.requestId !== requestId)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The decision target does not match this Room request');
    }
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const delegated = new Request(request.url, { method: 'POST', headers,
      body: JSON.stringify({ ...body, requestId }) });
    return decideRequest(delegated, { params: Promise.resolve({ homeId }) });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
