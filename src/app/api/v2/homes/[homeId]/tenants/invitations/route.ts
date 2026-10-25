import { POST as issueTenantInvitation } from '../../tenant/invitations/route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  return issueTenantInvitation(request, context);
}
