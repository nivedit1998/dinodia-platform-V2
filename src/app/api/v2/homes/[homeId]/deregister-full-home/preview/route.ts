import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { previewFullHomeDeregistration, type DeregistrationPrincipal } from '@/lib/homeDeregistration';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const account = await requireCustomerAccountSession(request);
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (homeId !== selected.homeId || selected.role !== 'OWNER'
      || account.id !== selected.id || !(account.accessTokenHash || account.refreshTokenHash)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Full-home deregistration is available only for the selected homeowner');
    }
    const principal: DeregistrationPrincipal = { id: account.id, sessionId: account.sessionId,
      trustedDeviceId: account.trustedDeviceId, tokenHash: account.credentialKind === 'access' ? account.accessTokenHash! : account.refreshTokenHash,
      credentialKind: account.credentialKind,
      securityVersion: account.securityVersion, trustedDeviceSessionVersion: account.trustedDeviceSessionVersion,
      homeId: selected.homeId, membershipId: selected.membershipId, hubInstallationId: selected.hubInstallationId,
      policyRevision: selected.policyRevision };
    return NextResponse.json(await previewFullHomeDeregistration({ homeId, principal }), { headers });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
