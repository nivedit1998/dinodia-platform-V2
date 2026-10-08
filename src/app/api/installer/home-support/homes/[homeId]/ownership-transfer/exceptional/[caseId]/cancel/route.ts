import { NextResponse } from 'next/server';
import { authErrorResponse, requireEmployeeRecentAuth, Stage1AuthError } from '@/lib/stage1Auth';
import { cancelExceptionalOwnershipTransfer } from '@/lib/exceptionalOwnershipTransfer';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string; caseId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const { homeId, caseId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).some((key) => key !== 'expectedRevision') || !('expectedRevision' in body)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The current case revision is required');
    }
    const result = await cancelExceptionalOwnershipTransfer({ homeId, caseId, employee,
      expectedRevision: Number(body.expectedRevision), idempotencyKey: String(request.headers.get('idempotency-key') ?? '').trim() });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
