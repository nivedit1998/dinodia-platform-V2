import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployee, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { homeId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    if (!workflowId || !request.headers.get('idempotency-key')) throw new Stage1AuthError(400, 'completion_fields_invalid', 'Workflow and idempotency key are required');
    const result = await prisma.$transaction(async (tx) => {
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { id: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
      if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId || !['IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'installation_work_denied', 'The installation work is not available to this employee');
      const hub = await tx.hubInstallation.findUnique({ where: { id: work.hubInstallationId }, select: { id: true, homeId: true, state: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true } });
      if (!hub || hub.homeId !== homeId || !hub.cloudUrlVerifiedAt || !hub.remoteVerificationAt || !['PROVISIONED', 'ACTIVE'].includes(hub.state)) throw new Stage1AuthError(409, 'remote_verification_required', 'Installation cannot complete until the signed CloudURL verification succeeds');
      const now = new Date();
      await tx.home.update({ where: { id: homeId }, data: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', installationCompletedAt: now } });
      await tx.hubInstallation.update({ where: { id: hub.id }, data: { state: 'ACTIVE' } });
      await tx.companyOperationalWorkItem.update({ where: { id: work.id }, data: { state: 'COMPLETED', completedAt: now } });
      await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'INSTALLATION', action: 'installation_completed', targetType: 'HubInstallation', targetId: hub.id, metadata: { workflowId, outcome: 'completed' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { homeId, hubInstallationId: hub.id, completedAt: now };
    });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
