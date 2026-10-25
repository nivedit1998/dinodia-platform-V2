import { NextResponse } from 'next/server';
import { requireEmployeeRecentAuth, authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { startInstallationRequest } from '@/lib/nativeInstallationRequests';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = ['INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'CXO'] as const;
export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, [...ROLES]);
    const { requestId } = await context.params;
    if (!uuid.test(requestId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'The installation request is unavailable');
    const body = await request.json() as Record<string, unknown>;
    const allowed = Object.keys(body).sort();
    if (!Number.isSafeInteger(body.expectedRevision) || allowed.some((key) => !['expectedRevision', 'assignedEmployeeId'].includes(key))
      || allowed.length !== (body.assignedEmployeeId === undefined ? 1 : 2)
      || body.assignedEmployeeId !== undefined && (typeof body.assignedEmployeeId !== 'string' || !uuid.test(body.assignedEmployeeId))) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current request revision and permitted assignee are required');
    const result = await startInstallationRequest({ requestId, employeeId: employee.id, employeeRole: employee.role, ...(typeof body.assignedEmployeeId === 'string' ? { assignedEmployeeId: body.assignedEmployeeId } : {}), expectedRevision: Number(body.expectedRevision), idempotencyKey: request.headers.get('idempotency-key') ?? '' });
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
