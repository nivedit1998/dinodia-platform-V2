import { NextResponse } from 'next/server';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { listAlexaApprovalPrompts } from '@/lib/alexa/signInLinking';

export const dynamic = 'force-dynamic';

/** Pending "approve this Alexa sign-in" prompts for the signed-in phone's account. Never reveals the correct number. */
export async function GET(request: Request) {
  try {
    const account = await requireCustomerAccountSession(request);
    if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') throw new Stage1AuthError(503, 'alexa_not_activated', 'Native Alexa linking is not yet activated');
    const approvals = await listAlexaApprovalPrompts(account.id);
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, approvals }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
