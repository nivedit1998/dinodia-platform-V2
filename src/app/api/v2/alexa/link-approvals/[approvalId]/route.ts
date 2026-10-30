import { NextResponse } from 'next/server';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { lockAndValidateAlexaAccountAuthority } from '@/lib/nativeAlexaAccountAuthority';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { decideAlexaApproval } from '@/lib/alexa/signInLinking';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Body is exactly {"choice": 10..99} or {"decline": true}. A wrong number ends the request. */
export async function POST(request: Request, context: { params: Promise<{ approvalId: string }> }) {
  try {
    const account = await requireCustomerAccountSession(request);
    if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') throw new Stage1AuthError(503, 'alexa_not_activated', 'Native Alexa linking is not yet activated');
    const { approvalId } = await context.params;
    if (!UUID.test(approvalId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This Alexa approval is not available');
    const raw = await request.json().catch(() => null) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A choice or a decline is required');
    const body = raw as Record<string, unknown>;
    const keys = Object.keys(body);
    let decision: { choice: number } | { decline: true };
    if (keys.length === 1 && keys[0] === 'choice' && Number.isInteger(body.choice) && (body.choice as number) >= 10 && (body.choice as number) <= 99) decision = { choice: body.choice as number };
    else if (keys.length === 1 && keys[0] === 'decline' && body.decline === true) decision = { decline: true };
    else throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A choice or a decline is required');
    const outcome = await serializableTransaction(async (tx) => {
      await lockAndValidateAlexaAccountAuthority(tx, account);
      return decideAlexaApproval(tx, { customerAccountId: account.id, intentId: approvalId, decision });
    }, 2);
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, outcome }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
