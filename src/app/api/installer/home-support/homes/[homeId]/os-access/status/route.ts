import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployee, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { homeId } = await context.params;
    const workflowId = String(new URL(request.url).searchParams.get('workflowId') ?? '').trim();
    if (!workflowId) throw new Stage1AuthError(400, 'workflow_required', 'An assigned workflow is required');
    const work = await prisma.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
    if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The workflow is not available to this employee');
    const rows = await prisma.hubCredentialVersion.findMany({ where: { hubInstallationId: work.hubInstallationId, purpose: 'operator-credential' }, orderBy: { version: 'desc' }, select: { version: true, purpose: true, state: true, issuedAt: true, deliveredAt: true, acknowledgedAt: true, activatedAt: true, graceUntil: true, revokedAt: true, deliveryAttempts: true } });
    return NextResponse.json({ ok: true, homeId, hubInstallationId: work.hubInstallationId, workflowState: work.state, credentials: rows.map((row) => ({ ...row, tokenHash: undefined })) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
