import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployee, requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { encryptOperatorGrant, isStrictlyUnexpired } from '@/lib/stage1Operator';
import { internalOperatorDaySessionEnabled, stage1NowMs } from '@/lib/internalOperatorDaySession';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    // This is the sole sensitive route allowed to rely on an active employee
    // session instead of five-minute recent authentication under the named,
    // temporary Stage 1 policy. Rotation, revocation and support stay strict.
    const employee = internalOperatorDaySessionEnabled()
      ? await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER'])
      : await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { homeId } = await context.params;
    await enforcePersistentRateLimit(`operator-launch:${employee.id}:${homeId}`, 5, 15 * 60 * 1000);
    await enforcePersistentRateLimit(`operator-launch-hour:${employee.id}`, 20, 60 * 60 * 1000);
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    const setupAttemptId = String(body.setupAttemptId ?? '').trim();
    if (!workflowId || !/^[A-Za-z0-9_-]{32,160}$/.test(setupAttemptId)) throw new Stage1AuthError(400, 'workflow_or_attempt_required', 'An assigned workflow and hub-created setup attempt are required');
    const now = new Date(stage1NowMs());
    const handoff = await prisma.$transaction(async (tx) => {
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { id: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, certifiedSerialNumber: true, state: true, workRevision: true } });
      if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The selected workflow is not assigned to this employee and home');
      const hub = await tx.hubInstallation.findUnique({ where: { id: work.hubInstallationId }, select: { id: true, homeId: true, serialNumberSnapshot: true, baseUrl: true, cloudUrl: true, manufacturingIdentity: { select: { encryptionPublicKey: true, identityGeneration: true, status: true } } } });
      if (!hub || hub.homeId !== homeId || work.certifiedSerialNumber !== hub.serialNumberSnapshot) throw new Stage1AuthError(403, 'workflow_hub_mismatch', 'The selected workflow is not bound to this hub');
      if (!hub.cloudUrl && !hub.baseUrl) throw new Stage1AuthError(409, 'hub_endpoint_unavailable', 'The hub local endpoint is not available yet');
      if (!hub.manufacturingIdentity?.encryptionPublicKey || hub.manufacturingIdentity.status !== 'ACTIVE') throw new Stage1AuthError(409, 'hub_identity_unavailable', 'The hub encryption identity is not available yet');
      const browserAttempt = await tx.operatorBrowserAttempt.findUnique({ where: { attemptId: setupAttemptId }, select: { id: true, attemptId: true, homeId: true, hubInstallationId: true, browserBindingHash: true, expiresAt: true, consumedAt: true, revokedAt: true } });
      if (!browserAttempt || browserAttempt.homeId !== homeId || browserAttempt.hubInstallationId !== hub.id || browserAttempt.consumedAt || browserAttempt.revokedAt || !isStrictlyUnexpired(browserAttempt.expiresAt, now)) throw new Stage1AuthError(403, 'operator_attempt_not_authorized', 'The setup attempt was not created by this paired hub browser or has expired');
      const existing = await tx.operatorHandoff.findFirst({ where: { operatorBrowserAttemptId: browserAttempt.id, employeeId: employee.id, workflowId: work.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { id: true, expiresAt: true } });
      if (existing) return { id: existing.id, expiresAt: existing.expiresAt, baseUrl: hub.baseUrl, cloudUrl: hub.cloudUrl };
      const expiresAt = new Date(now.getTime() + 60 * 1000);
      const handoffSecret = randomSecret(32);
      const handoffEnvelope = JSON.stringify(encryptOperatorGrant(handoffSecret, hub.manufacturingIdentity.encryptionPublicKey, 1, 'operator-handoff'));
      const created = await tx.operatorHandoff.create({ data: { employeeId: employee.id, workflowId: work.id, homeId, hubInstallationId: hub.id, attemptId: browserAttempt.id, operatorBrowserAttemptId: browserAttempt.id, setupAttemptId: browserAttempt.attemptId, browserBindingHash: browserAttempt.browserBindingHash, handoffHash: sha256(handoffSecret), handoffEnvelope, scope: { scopes: ['os:admin'], workRevision: work.workRevision, employeeSessionId: employee.sessionId, serialNumber: hub.serialNumberSnapshot, identityGeneration: hub.manufacturingIdentity.identityGeneration }, expiresAt }, select: { id: true, expiresAt: true } });
      await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'operator_handoff_issued', targetType: 'OperatorHandoff', targetId: created.id, metadata: { workflowId: work.id, outcome: 'issued', expiresAt: created.expiresAt.toISOString() }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { id: created.id, expiresAt: created.expiresAt, baseUrl: hub.baseUrl, cloudUrl: hub.cloudUrl };
    });
    // Only an opaque handoff identifier is returned. The setup attempt and
    // browser binding were created by the paired hub before this transaction;
    // Portal cannot invent or replace either authority-bearing value.
    const operatorOrigin = String(handoff.cloudUrl || handoff.baseUrl || '').replace(/\/$/, '');
    return NextResponse.json({ ok: true, handoffId: handoff.id, expiresAt: handoff.expiresAt, homeId, operatorUrl: `${operatorOrigin}/support-access` }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
