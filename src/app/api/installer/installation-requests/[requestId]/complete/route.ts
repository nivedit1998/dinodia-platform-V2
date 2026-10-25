import { NextResponse } from 'next/server';
import { requireEmployeeRecentAuth, authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { completeInstallationRequest } from '@/lib/nativeInstallationRequests';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = ['INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'CXO'] as const;
export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, [...ROLES]);
    const { requestId } = await context.params;
    if (!uuid.test(requestId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'The installation request is unavailable');
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).join('|') !== 'expectedRevision' || !Number.isSafeInteger(body.expectedRevision)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current request revision is required');
    const result = await completeInstallationRequest({ requestId, employeeId: employee.id, expectedRevision: Number(body.expectedRevision), idempotencyKey: request.headers.get('idempotency-key') ?? '' });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
