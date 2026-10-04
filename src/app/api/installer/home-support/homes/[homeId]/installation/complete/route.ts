import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireEmployee, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { assertNativeInstallationCompletable } from '@/lib/nativeHubProvisioning';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { homeId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    const idempotencyKey = String(request.headers.get('idempotency-key') ?? '').trim();
    if (!workflowId || !idempotencyKey || idempotencyKey.length > 160) throw new Stage1AuthError(400, 'completion_fields_invalid', 'Workflow and bounded idempotency key are required');
    const requestHash = sha256(JSON.stringify({ homeId, workflowId }));
    const keyHash = sha256(`${employee.id}:${idempotencyKey}`);
    let result: { homeId: string; hubInstallationId: string; completedAt: string; idempotentReplay: boolean } | undefined;
    for (let retry = 0; retry < 3 && !result; retry += 1) {
      try {
        result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const existing = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: 'installation-complete:v1', keyHash } }, select: { id: true, actorId: true, homeId: true, hubInstallationId: true, requestHash: true, responseStatus: true, responseBody: true, responseDigest: true, expiresAt: true } });
      if (existing && existing.expiresAt > now) {
        if (existing.actorId !== employee.id || existing.requestHash !== requestHash || existing.homeId !== homeId) throw new Stage1AuthError(409, 'completion_idempotency_conflict', 'This idempotency key belongs to another installation completion');
        if (existing.responseStatus !== 200 || !existing.responseBody || !existing.responseDigest) throw new Stage1AuthError(409, 'completion_result_unavailable', 'The original installation completion result is unavailable');
        const stored = existing.responseBody as { homeId?: unknown; hubInstallationId?: unknown; completedAt?: unknown };
        const stable = { homeId: String(stored.homeId ?? ''), hubInstallationId: String(stored.hubInstallationId ?? ''), completedAt: String(stored.completedAt ?? '') };
        if (stable.homeId !== homeId || stable.hubInstallationId !== existing.hubInstallationId || !Number.isFinite(Date.parse(stable.completedAt))
          || sha256(JSON.stringify(stable)) !== existing.responseDigest) throw new Stage1AuthError(409, 'completion_result_unavailable', 'The original installation completion result failed integrity validation');
        return { ...stable, idempotentReplay: true };
      }
      if (existing) await tx.idempotencyRecord.delete({ where: { id: existing.id } });
      const idempotency = await tx.idempotencyRecord.create({ data: {
        namespace: 'installation-complete:v1', keyHash, actorId: employee.id, homeId, requestHash,
        responseStatus: 102, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      }, select: { id: true } });
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { id: true, kind: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
      if (!work || work.kind !== 'INITIAL_HUB_INSTALLATION' || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId || !['IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'installation_work_denied', 'The assigned initial installation work is not available to this employee');
      const hub = await tx.hubInstallation.findUnique({ where: { id: work.hubInstallationId }, select: { id: true, homeId: true, state: true, lifecycleStatus: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true } });
      if (!hub || hub.homeId !== homeId || !hub.cloudUrlVerifiedAt || !hub.remoteVerificationAt || !['PROVISIONED', 'ACTIVE'].includes(hub.state)) throw new Stage1AuthError(409, 'remote_verification_required', 'Installation cannot complete until the signed CloudURL verification succeeds');
      try { await assertNativeInstallationCompletable(tx, homeId, hub.id); }
      catch { throw new Stage1AuthError(409, 'installation_prerequisites_incomplete', 'Installation requires the current verified hub and at least one canonical active area'); }
      const homeChanged = await tx.home.updateMany({
        where: { id: homeId, lifecycle: 'INSTALLING', installationStatus: 'IN_PROGRESS', activeHubInstallationId: null },
        // Installation completion deliberately precedes the first homeowner
        // claim. The claim service requires this ownerless, fully installed
        // state and is the only path that creates the initial OWNER.
        data: { lifecycle: 'PENDING_INSTALLATION', installationStatus: 'COMPLETE', installationCompletedAt: now, installationCompletedByEmployeeId: employee.id, activeHubInstallationId: hub.id },
      });
      if (homeChanged.count !== 1) throw new Stage1AuthError(409, 'installation_state_changed', 'The Home changed while installation completion was being committed');
      const hubChanged = await tx.hubInstallation.updateMany({
        where: { id: hub.id, homeId, lifecycleStatus: hub.lifecycleStatus, state: hub.state },
        data: { state: 'ACTIVE', lifecycleStatus: 'ACTIVE' },
      });
      if (hubChanged.count !== 1) throw new Stage1AuthError(409, 'installation_state_changed', 'The hub changed while installation completion was being committed');
      await tx.companyOperationalWorkItem.update({ where: { id: work.id }, data: { state: 'COMPLETED', completedAt: now } });
      await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'INSTALLATION', action: 'installation_completed', targetType: 'HubInstallation', targetId: hub.id, metadata: { workflowId, outcome: 'completed' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      const responseBody = { homeId, hubInstallationId: hub.id, completedAt: now.toISOString() };
      await tx.idempotencyRecord.update({ where: { id: idempotency.id }, data: { hubInstallationId: hub.id, responseStatus: 200, responseBody, responseDigest: sha256(JSON.stringify(responseBody)) } });
      return { ...responseBody, idempotentReplay: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if ((code === 'P2002' || code === 'P2034') && retry < 2) continue;
        throw error;
      }
    }
    if (!result) throw new Stage1AuthError(503, 'installation_completion_retry_exhausted', 'Installation completion could not be committed safely; please retry');
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
