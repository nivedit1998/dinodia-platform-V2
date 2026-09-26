import { NextResponse } from 'next/server';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { runIdempotentOperatorMutation } from '@/lib/idempotentOperatorMutation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const { homeId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    const reason = String(body.reason ?? '').trim().slice(0, 160);
    const idempotencyKey = String(request.headers.get('idempotency-key') ?? '').trim();
    if (!workflowId || !reason || !idempotencyKey) throw new Stage1AuthError(400, 'revocation_fields_invalid', 'Workflow, reason and idempotency key are required');
    const result = await runIdempotentOperatorMutation({
      operation: 'operator-revoke',
      actorId: employee.id,
      homeId,
      idempotencyKey,
      requestIdentity: { workflowId, reason },
      resolve: async (tx) => {
        const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { assignedEmployeeId: true, homeId: true, hubInstallationId: true } });
        if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The workflow is not available to this employee');
        return { hubInstallationId: work.hubInstallationId };
      },
      mutate: async (tx, hub, now) => {
        const updated = await tx.hubCredentialVersion.updateMany({ where: { hubInstallationId: hub.hubInstallationId, purpose: 'operator-credential', state: { in: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'ACTIVE', 'GRACE'] } }, data: { state: 'REVOKED', revokedAt: now, revokedReason: 'emergency_operator_revocation' } });
        await tx.hubInstallation.update({ where: { id: hub.hubInstallationId }, data: { currentOperatorCredentialVersion: null, accessPolicyRevision: { increment: 1 } } });
        await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'operator_credentials_revoked', targetType: 'HubInstallation', targetId: hub.hubInstallationId, metadata: { reason, revokedCount: updated.count }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        return { ok: true, revoked: updated.count, hubInstallationId: hub.hubInstallationId };
      },
    });
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
