import { NextResponse } from 'next/server';
import { authErrorResponse, requireEmployeeRecentAuth } from '@/lib/stage1Auth';
import { submitExceptionalOwnershipTransfer } from '@/lib/exceptionalOwnershipTransfer';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const { homeId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const fields = ['proposedIncomingEmail', 'expectedManagementRevision', 'reason', 'verificationMethod', 'verificationReference', 'staffAttestation'];
    if (!body || Object.keys(body).some((key) => !fields.includes(key)) || fields.some((key) => !(key in body))) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The exceptional transfer submission is incomplete');
    }
    const idempotencyKey = String(request.headers.get('idempotency-key') ?? '').trim();
    const result = await submitExceptionalOwnershipTransfer({ homeId, employee,
      proposedIncomingEmail: String(body.proposedIncomingEmail), expectedManagementRevision: Number(body.expectedManagementRevision),
      reason: String(body.reason), verificationMethod: String(body.verificationMethod),
      verificationReference: String(body.verificationReference), staffAttestation: String(body.staffAttestation), idempotencyKey });
    return NextResponse.json(result, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
