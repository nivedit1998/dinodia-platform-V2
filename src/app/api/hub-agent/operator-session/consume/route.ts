import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { encryptOperatorGrant, createHubBoundOperatorGrant, isStrictlyUnexpired } from '@/lib/stage1Operator';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const handoffId = String(hub.body.handoffId ?? '').trim();
    const browserBinding = String(hub.body.browserBinding ?? '').trim();
    const setupAttemptId = String(hub.body.setupAttemptId ?? '').trim();
    const phase = String(hub.body.phase ?? 'consume').trim();
    const handoffSecret = String(hub.body.handoffSecret ?? '').trim();
    if (!['prepare', 'consume'].includes(phase) || !/^[0-9a-f-]{36}$/i.test(handoffId) || !/^[A-Za-z0-9_-]{32,256}$/.test(browserBinding) || !/^[A-Za-z0-9_-]{32,160}$/.test(setupAttemptId)) throw new Stage1AuthError(400, 'handoff_invalid', 'A valid operator handoff phase, id, setup attempt and browser binding are required');
    if (phase === 'consume' && !/^[A-Za-z0-9_-]{32,256}$/.test(handoffSecret)) throw new Stage1AuthError(401, 'handoff_secret_required', 'The hub must prove possession of the one-use handoff secret');
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const handoff = await tx.operatorHandoff.findUnique({ where: { id: handoffId }, select: { id: true, employeeId: true, workflowId: true, homeId: true, hubInstallationId: true, operatorBrowserAttemptId: true, setupAttemptId: true, scope: true, expiresAt: true, consumedAt: true, revokedAt: true, browserBindingHash: true, handoffHash: true, handoffEnvelope: true } });
      if (!handoff || handoff.hubInstallationId !== hub.installation.id || handoff.homeId !== hub.installation.homeId || !isStrictlyUnexpired(handoff.expiresAt, now) || handoff.consumedAt || handoff.revokedAt) throw new Stage1AuthError(401, 'handoff_rejected', 'The operator handoff is invalid or expired');
      if (!handoff.operatorBrowserAttemptId) throw new Stage1AuthError(401, 'handoff_attempt_missing', 'The operator handoff has no hub-created browser attempt');
      const browserAttempt = await tx.operatorBrowserAttempt.findUnique({ where: { id: handoff.operatorBrowserAttemptId }, select: { id: true, attemptId: true, homeId: true, hubInstallationId: true, browserBindingHash: true, expiresAt: true, consumedAt: true, revokedAt: true } });
      if (!browserAttempt || browserAttempt.homeId !== handoff.homeId || browserAttempt.hubInstallationId !== handoff.hubInstallationId || browserAttempt.attemptId !== setupAttemptId || browserAttempt.browserBindingHash !== sha256(browserBinding) || !isStrictlyUnexpired(browserAttempt.expiresAt, now) || browserAttempt.consumedAt || browserAttempt.revokedAt || handoff.browserBindingHash !== browserAttempt.browserBindingHash) throw new Stage1AuthError(401, 'handoff_rejected', 'The operator handoff is not bound to this hub browser');
      if (phase === 'prepare') return { handoffSecretEnvelope: handoff.handoffEnvelope };
      if (sha256(handoffSecret) !== handoff.handoffHash) throw new Stage1AuthError(401, 'handoff_secret_invalid', 'The one-use operator handoff secret is invalid');
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: handoff.workflowId }, select: { id: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
      if (!work || work.assignedEmployeeId !== handoff.employeeId || work.homeId !== handoff.homeId || work.hubInstallationId !== handoff.hubInstallationId || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'workflow_revoked', 'The operator workflow is no longer valid');
      const credential = await tx.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: { in: ['ACTIVE', 'GRACE'] } }, orderBy: { version: 'desc' }, select: { version: true } });
      const grant = createHubBoundOperatorGrant({ employeeId: handoff.employeeId, hubId: hub.installation.serialNumberSnapshot, workflowId: handoff.workflowId, scope: ['os:admin'], recentAuthAt: Date.now(), expiresAt: now.getTime() + 15 * 60 * 1000, credentialVersion: credential?.version ?? 0 });
      const encryptedSessionGrant = encryptOperatorGrant(grant, hub.identity.encryptionPublicKey, 1);
      const consumed = await tx.operatorHandoff.updateMany({ where: { id: handoff.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now }, setupAttemptId, browserBindingHash: sha256(browserBinding) }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw new Stage1AuthError(401, 'handoff_replay', 'The operator handoff was already consumed or revoked');
      const attemptConsumed = await tx.operatorBrowserAttempt.updateMany({ where: { id: browserAttempt.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
      if (attemptConsumed.count !== 1) throw new Stage1AuthError(401, 'handoff_browser_replay', 'The originating browser attempt was already consumed or revoked');
      return { encryptedSessionGrant, expiresAt: new Date(now.getTime() + 15 * 60 * 1000) };
    });
    if ('handoffSecretEnvelope' in result) return NextResponse.json({ ok: true, handoffSecretEnvelope: result.handoffSecretEnvelope }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    return NextResponse.json({ ok: true, sessionGrant: { version: 1, envelope: result.encryptedSessionGrant }, expiresAt: result.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
