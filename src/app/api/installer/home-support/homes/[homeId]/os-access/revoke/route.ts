import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const { homeId } = await context.params;
    await enforcePersistentRateLimit(`operator-revoke:${employee.id}:${homeId}`, 12, 60 * 60 * 1000);
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    const reason = String(body.reason ?? '').trim().slice(0, 160);
    if (!workflowId || !reason || !request.headers.get('idempotency-key')) throw new Stage1AuthError(400, 'revocation_fields_invalid', 'Workflow, reason and idempotency key are required');
    const result = await prisma.$transaction(async (tx) => {
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { assignedEmployeeId: true, homeId: true, hubInstallationId: true } });
      if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The workflow is not available to this employee');
      const updated = await tx.hubCredentialVersion.updateMany({ where: { hubInstallationId: work.hubInstallationId, purpose: 'operator-credential', state: { in: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'ACTIVE', 'GRACE'] } }, data: { state: 'REVOKED', revokedAt: new Date(), revokedReason: reason } });
      await tx.hubInstallation.update({ where: { id: work.hubInstallationId }, data: { currentOperatorCredentialVersion: null, accessPolicyRevision: { increment: 1 } } });
      await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'operator_credentials_revoked', targetType: 'HubInstallation', targetId: work.hubInstallationId, metadata: { reason, revokedCount: updated.count }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
      return { revoked: updated.count };
    });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
