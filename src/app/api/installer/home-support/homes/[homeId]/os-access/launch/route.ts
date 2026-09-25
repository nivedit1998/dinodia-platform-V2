import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { encryptOperatorGrant } from '@/lib/stage1Operator';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { homeId } = await context.params;
    await enforcePersistentRateLimit(`operator-launch:${employee.id}:${homeId}`, 5, 15 * 60 * 1000);
    await enforcePersistentRateLimit(`operator-launch-hour:${employee.id}`, 20, 60 * 60 * 1000);
    const body = await request.json() as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    const setupAttemptId = String(body.setupAttemptId ?? '').trim();
    if (!workflowId || !/^[A-Za-z0-9_-]{32,160}$/.test(setupAttemptId)) throw new Stage1AuthError(400, 'workflow_or_attempt_required', 'An assigned workflow and hub-created setup attempt are required');
    const now = new Date();
    const handoff = await prisma.$transaction(async (tx) => {
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { id: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true, workRevision: true } });
      if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== homeId || !work.hubInstallationId || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The selected workflow is not assigned to this employee and home');
      const hub = await tx.hubInstallation.findUnique({ where: { id: work.hubInstallationId }, select: { id: true, homeId: true, cloudUrl: true, manufacturingIdentity: { select: { encryptionPublicKey: true } } } });
      if (!hub || hub.homeId !== homeId) throw new Stage1AuthError(403, 'workflow_hub_mismatch', 'The selected workflow is not bound to this hub');
      if (!hub.cloudUrl) throw new Stage1AuthError(409, 'hub_cloud_url_unavailable', 'The hub secure endpoint is not available yet');
      if (!hub.manufacturingIdentity?.encryptionPublicKey) throw new Stage1AuthError(409, 'hub_identity_unavailable', 'The hub encryption identity is not available yet');
      const browserAttempt = await tx.operatorBrowserAttempt.findUnique({ where: { attemptId: setupAttemptId }, select: { id: true, attemptId: true, homeId: true, hubInstallationId: true, browserBindingHash: true, expiresAt: true, consumedAt: true, revokedAt: true } });
      if (!browserAttempt || browserAttempt.homeId !== homeId || browserAttempt.hubInstallationId !== hub.id || browserAttempt.consumedAt || browserAttempt.revokedAt || browserAttempt.expiresAt <= now) throw new Stage1AuthError(403, 'operator_attempt_not_authorized', 'The setup attempt was not created by this paired hub browser or has expired');
      const existing = await tx.operatorHandoff.findFirst({ where: { operatorBrowserAttemptId: browserAttempt.id, employeeId: employee.id, workflowId: work.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { id: true, expiresAt: true } });
      if (existing) return { id: existing.id, expiresAt: existing.expiresAt, cloudUrl: hub.cloudUrl };
      const expiresAt = new Date(now.getTime() + 60 * 1000);
      const handoffSecret = randomSecret(32);
      const handoffEnvelope = JSON.stringify(encryptOperatorGrant(handoffSecret, hub.manufacturingIdentity.encryptionPublicKey, 1, 'operator-handoff'));
      const created = await tx.operatorHandoff.create({ data: { employeeId: employee.id, workflowId: work.id, homeId, hubInstallationId: hub.id, attemptId: browserAttempt.id, operatorBrowserAttemptId: browserAttempt.id, setupAttemptId: browserAttempt.attemptId, browserBindingHash: browserAttempt.browserBindingHash, handoffHash: sha256(handoffSecret), handoffEnvelope, scope: { scopes: ['os:admin'], workRevision: work.workRevision }, expiresAt }, select: { id: true, expiresAt: true } });
      await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'operator_handoff_issued', targetType: 'OperatorHandoff', targetId: created.id, metadata: { workflowId: work.id, outcome: 'issued', expiresAt: created.expiresAt.toISOString() }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { id: created.id, expiresAt: created.expiresAt, cloudUrl: hub.cloudUrl };
    });
    // Only an opaque handoff identifier is returned. The setup attempt and
    // browser binding were created by the paired hub before this transaction;
    // Portal cannot invent or replace either authority-bearing value.
    return NextResponse.json({ ok: true, handoffId: handoff.id, expiresAt: handoff.expiresAt, homeId, operatorUrl: `${handoff.cloudUrl.replace(/\/$/, '')}/support-access` }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
