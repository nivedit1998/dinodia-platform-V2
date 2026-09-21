import 'server-only';

import { PrismaClient, Role } from '@prisma/client';

type Workflow = 'INSTALLATION' | 'SUPPORT' | 'PROPERTY_CORRECTION';

export async function requireApprovedOsWorkflow(
  client: PrismaClient,
  input: { workflow: string; workflowId: string; homeId: number; hubInstallId: string; operatorId: number; role: Role },
) {
  const workflow = input.workflow as Workflow;
  const workflowId = String(input.workflowId || '').trim();
  if (!['INSTALLATION', 'SUPPORT', 'PROPERTY_CORRECTION'].includes(workflow) || !workflowId) {
    return { ok: false as const, reason: 'workflow_required' };
  }

  if (workflow === 'SUPPORT') {
    const request = await client.supportAccessSession.findFirst({
      where: { OR: [{ id: workflowId }, { supportRequestId: workflowId }] },
      select: { id: true, supportRequestId: true, homeId: true, assignedEmployeeId: true, status: true, approvedAt: true, expiresAt: true, endedAt: true, hubRevokePending: true },
    });
    const approved = Boolean(request?.approvedAt && request.expiresAt && request.expiresAt > new Date());
    if (!request || request.homeId !== input.homeId || request.assignedEmployeeId !== input.operatorId || !['APPROVED', 'ACTIVE'].includes(request.status) || !approved || request.endedAt || request.hubRevokePending) return { ok: false as const, reason: 'support_workflow_not_approved' };
    return { ok: true as const, workflow, workflowId, scope: 'support' as const };
  }

  const record = await client.osOperatorWorkflow.findUnique({ where: { id: workflowId } });
  const validStatus = record?.status === 'APPROVED' || record?.status === 'ASSIGNED';
  const validTime = !record?.expiresAt || record.expiresAt > new Date();
  if (!record || record.homeId !== input.homeId || record.hubInstallId !== input.hubInstallId || record.workflowType !== workflow || record.assignedEmployeeId !== input.operatorId || !validStatus || !validTime || record.revokedAt || !record.approvedAt) return { ok: false as const, reason: 'approved_workflow_not_found' };
  if (workflow === 'PROPERTY_CORRECTION' && input.role !== Role.CXO && input.role !== Role.SENIOR_OPERATIONS_MANAGER) return { ok: false as const, reason: 'property_correction_requires_senior_authority' };
  if (workflow === 'INSTALLATION' && input.role !== Role.INSTALLER && input.role !== Role.CXO && input.role !== Role.SENIOR_OPERATIONS_MANAGER) return { ok: false as const, reason: 'installation_requires_authorised_role' };
  return { ok: true as const, workflow, workflowId, scope: 'installation' as const };
}
