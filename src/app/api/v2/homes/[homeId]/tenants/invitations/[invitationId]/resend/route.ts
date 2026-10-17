import { POST as issueTenantInvitation } from '../../../../tenant/invitations/route';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ homeId: string; invitationId: string }> }) {
  try {
    const { homeId, invitationId } = await context.params;
    const selected = await requireCustomerSelectedHome(request);
    if (selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This invitation is unavailable for the selected Home');
    }
    if (!UUID.test(homeId) || !UUID.test(invitationId)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid invitation is required');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || ('resendInvitationId' in body && body.resendInvitationId !== invitationId)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The resend target does not match this invitation');
    }
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const delegated = new Request(request.url, { method: 'POST', headers,
      body: JSON.stringify({ ...body, resendInvitationId: invitationId }) });
    return issueTenantInvitation(delegated, { params: Promise.resolve({ homeId }) });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
