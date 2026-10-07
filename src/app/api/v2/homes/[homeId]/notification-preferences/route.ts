import { GET as readPreferences, PUT as writePreferences } from '../preferences/route';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
const allowedKinds = new Set(['NOTIFICATION_PREFERENCES', 'QUIET_HOURS', 'MANAGER_NOTIFICATION_ASSIGNMENT']);

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  return readPreferences(request, context);
}

export async function PUT(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    // Authenticate and resolve the selected Home before validating the body so
    // anonymous callers receive the canonical auth denial, not a DTO oracle.
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (selected.homeId !== homeId) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Preferences are not available for this selected Home');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.kind !== 'string' || !allowedKinds.has(body.kind)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A notification preference document is required');
    }
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return writePreferences(new Request(request.url, { method: 'PUT', headers, body: JSON.stringify(body) }), context);
  } catch (error) { return nativeV1ErrorResponse(error); }
}
