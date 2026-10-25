import { NextResponse } from 'next/server';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { encryptToHubKey } from '@/lib/hubOperatorCredentials';
import { runIdempotentOperatorMutation } from '@/lib/idempotentOperatorMutation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const { homeId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    const idempotencyKey = String(request.headers.get('idempotency-key') ?? '').trim();
    if (!workflowId || !idempotencyKey) throw new Stage1AuthError(400, 'rotation_fields_invalid', 'Workflow and idempotency key are required');
    const result = await runIdempotentOperatorMutation({
      operation: 'operator-rotate',
      actorId: employee.id,
      homeId,
      idempotencyKey,
      requestIdentity: { workflowId },
      resolve: async (tx) => {
        const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { id: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
        if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId || !['IN_PROGRESS', 'COMPLETED', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The workflow is not available to this employee');
        const hub = await tx.hubInstallation.findUnique({ where: { id: work.hubInstallationId }, select: { id: true, homeId: true, manufacturingIdentity: { select: { encryptionPublicKey: true } } } });
        if (!hub || hub.homeId !== homeId) throw new Stage1AuthError(403, 'hub_home_mismatch', 'The hub is not part of this home');
        if (!hub.manufacturingIdentity?.encryptionPublicKey) throw new Stage1AuthError(409, 'hub_identity_unavailable', 'The hub encryption identity is not available yet');
        return { hubInstallationId: hub.id, encryptionPublicKey: hub.manufacturingIdentity.encryptionPublicKey };
      },
      mutate: async (tx, hub, now) => {
        const max = (await tx.hubCredentialVersion.aggregate({ where: { hubInstallationId: hub.hubInstallationId, purpose: 'operator-credential' }, _max: { version: true } }))._max.version ?? 0;
        const version = Number(max) + 1;
        const secret = `dno_ops_${randomSecret(32)}`;
        const envelope = encryptToHubKey(secret, hub.encryptionPublicKey, 'operator-credential', version);
        await tx.hubCredentialVersion.create({ data: { hubInstallationId: hub.hubInstallationId, version, purpose: 'operator-credential', state: 'PENDING', tokenHash: sha256(secret), encryptedDeliveryEnvelope: envelope, ciphertextKeyVersion: 1 } });
        await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'operator_credential_rotation_requested', targetType: 'HubInstallation', targetId: hub.hubInstallationId, metadata: { version, outcome: 'pending' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        return { ok: true, hubInstallationId: hub.hubInstallationId, version, state: 'PENDING' };
      },
    });
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
