import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { deregisterFullHome, FULL_HOME_DEREGISTRATION_CONFIRMATION, type DeregistrationPrincipal } from '@/lib/homeDeregistration';
import { homeownerDeregistrationEnabled, LIFECYCLE_REHEARSAL_REQUIRED } from '@/lib/homeownerLifecycleAvailability';

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
    if (!homeownerDeregistrationEnabled()) {
      throw new Stage1AuthError(503, LIFECYCLE_REHEARSAL_REQUIRED, 'Full-home deregistration remains unavailable until its controlled safety rehearsal is approved');
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const allowed = ['expectedManagementRevision', 'confirmation', 'proof', 'idempotencyKey'];
    if (!body || Object.keys(body).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in body))) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The full-home deregistration request is incomplete');
    }
    const principal: DeregistrationPrincipal = { id: account.id, sessionId: account.sessionId,
      trustedDeviceId: account.trustedDeviceId, tokenHash: account.credentialKind === 'access' ? account.accessTokenHash! : account.refreshTokenHash,
      credentialKind: account.credentialKind,
      securityVersion: account.securityVersion, trustedDeviceSessionVersion: account.trustedDeviceSessionVersion,
      homeId: selected.homeId, membershipId: selected.membershipId, hubInstallationId: selected.hubInstallationId,
      policyRevision: selected.policyRevision };
    const receipt = await deregisterFullHome({ homeId, principal, request: {
      expectedManagementRevision: Number(body.expectedManagementRevision),
      confirmation: body.confirmation as typeof FULL_HOME_DEREGISTRATION_CONFIRMATION,
      proof: String(body.proof), idempotencyKey: String(body.idempotencyKey),
    } });
    return NextResponse.json(receipt, { status: 202, headers });
  } catch (error) {
    return nativeV1ErrorResponse(error);
  }
}
