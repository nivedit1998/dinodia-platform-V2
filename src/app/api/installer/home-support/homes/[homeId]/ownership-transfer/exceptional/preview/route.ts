import { NextResponse } from 'next/server';
import { authErrorResponse, requireEmployeeRecentAuth, Stage1AuthError } from '@/lib/stage1Auth';
import { previewExceptionalOwnershipTransfer } from '@/lib/exceptionalOwnershipTransfer';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const { homeId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).some((key) => key !== 'proposedIncomingEmail')
      || typeof body.proposedIncomingEmail !== 'string') {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'An exact proposed-owner email is required for preview');
    }
    const preview = await previewExceptionalOwnershipTransfer({ homeId,
      proposedIncomingEmail: body.proposedIncomingEmail, employee });
    return NextResponse.json(preview, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
