import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { encryptToHubKey } from '@/lib/hubOperatorCredentials';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const { homeId } = await context.params;
    await enforcePersistentRateLimit(`operator-rotate:${employee.id}:${homeId}`, 6, 60 * 60 * 1000);
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    if (!workflowId || !request.headers.get('idempotency-key')) throw new Stage1AuthError(400, 'rotation_fields_invalid', 'Workflow and idempotency key are required');
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
      if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId || !['IN_PROGRESS', 'COMPLETED', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The workflow is not available to this employee');
      const hub = await tx.hubInstallation.findUnique({ where: { id: work.hubInstallationId }, select: { id: true, homeId: true, manufacturingIdentity: { select: { encryptionPublicKey: true } } } });
      if (!hub || hub.homeId !== homeId) throw new Stage1AuthError(403, 'hub_home_mismatch', 'The hub is not part of this home');
      const max = (await tx.hubCredentialVersion.aggregate({ where: { hubInstallationId: hub.id, purpose: 'operator-credential' }, _max: { version: true } }))._max.version ?? 0;
      const version = Number(max) + 1;
      const secret = `dno_ops_${randomSecret(32)}`;
      const envelope = encryptToHubKey(secret, hub.manufacturingIdentity.encryptionPublicKey, 'operator-credential', version);
      await tx.hubCredentialVersion.create({ data: { hubInstallationId: hub.id, version, purpose: 'operator-credential', state: 'PENDING', tokenHash: sha256(secret), encryptedDeliveryEnvelope: envelope, ciphertextKeyVersion: 1 } });
      await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'operator_credential_rotation_requested', targetType: 'HubInstallation', targetId: hub.id, metadata: { version, outcome: 'pending' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { hubInstallationId: hub.id, version, state: 'PENDING' };
    });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
