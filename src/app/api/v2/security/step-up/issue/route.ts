import { NextResponse } from 'next/server';
import { requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { issueStepUp } from '@/lib/sensitiveOperationStepUp';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const body = await request.json() as Record<string, unknown>;
    const challengeId = String(body.challengeId ?? '').trim();
    if (!challengeId) throw new Stage1AuthError(400, 'step_up_fields_invalid', 'A server-issued challenge is required');
    const assertionSignature = String(body.deviceSignature ?? request.headers.get('x-dinodia-device-signature') ?? '');
    const assertionNonce = String(body.nonce ?? request.headers.get('x-dinodia-step-up-nonce') ?? '');
    const result = await issueStepUp({ customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, trustedDevicePublicKey: customer.trustedDevicePublicKey, assertionSignature, assertionNonce, challengeId });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
