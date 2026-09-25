import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireEmployee, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { hashClaimReference } from '@/lib/stage1ClaimContract';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function text(value: unknown, max = 200): string {
  const result = String(value ?? '').trim();
  return result.length <= max ? result : '';
}

function reservedHostname(serial: string): string {
  const slug = serial.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  if (!slug) throw new Stage1AuthError(400, 'serial_invalid', 'The hub serial cannot produce a reserved hostname');
  return `dinodia-${slug}.dinodiasmartliving.com`;
}

function reservedTunnelName(serial: string): string {
  const slug = serial.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  if (!slug) throw new Stage1AuthError(400, 'serial_invalid', 'The hub serial cannot produce a reserved tunnel name');
  return `dinodia-${slug}`;
}

export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const body = await request.json() as Record<string, unknown>;
    const workflowId = text(body.workflowId, 64);
    const attemptId = text(body.attemptId, 160);
    const presentation = text(body.presentation ?? body.code, 512);
    const idempotencyKey = text(request.headers.get('idempotency-key'), 160);
    if (!workflowId || !attemptId || !presentation || !idempotencyKey) throw new Stage1AuthError(400, 'provisioning_fields_invalid', 'Workflow, attempt, presentation and idempotency key are required');
    await enforcePersistentRateLimit(`provisioning-approve:${employee.id}`, 20, 15 * 60 * 1000);
    const requestHash = sha256(JSON.stringify({ workflowId, attemptId, presentation }));
    const keyHash = sha256(`${employee.id}:${idempotencyKey}`);
    let result: { attemptId: string; state: string; expiresAt: Date; homeId: string; hubInstallationId: string; serialNumber: string; claimPresentation: string | null; idempotentReplay: boolean } | undefined;
    for (let transactionAttempt = 0; transactionAttempt < 3 && !result; transactionAttempt += 1) {
      try {
        result = await prisma.$transaction(async (tx) => {
          const now = new Date();
          const existing = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: 'hub-provisioning-approve', keyHash } }, select: { id: true, actorId: true, requestHash: true, responseDigest: true, expiresAt: true, homeId: true } });
          if (existing && existing.expiresAt > now && (existing.actorId !== employee.id || existing.requestHash !== requestHash)) throw new Stage1AuthError(409, 'idempotency_key_reused', 'The idempotency key was already used for another provisioning request');
          if (existing && existing.expiresAt > now && existing.responseDigest) {
            const replay = await tx.hubProvisioningAttempt.findUnique({ where: { attemptId }, select: { attemptId: true, state: true, expiresAt: true, hubInstallationId: true, manufacturingIdentityId: true, companyWorkItemId: true, manufacturingIdentity: { select: { serialNumber: true } } } });
            const replayWork = replay?.companyWorkItemId ? await tx.companyOperationalWorkItem.findUnique({ where: { id: replay.companyWorkItemId }, select: { assignedEmployeeId: true, homeId: true, hubInstallationId: true } }) : null;
            if (!replay || !replayWork || replayWork.assignedEmployeeId !== employee.id || !replayWork.homeId || !replay.hubInstallationId) throw new Stage1AuthError(409, 'idempotency_result_unavailable', 'The original provisioning result is no longer available');
            return { attemptId: replay.attemptId, state: replay.state, expiresAt: replay.expiresAt, homeId: replayWork.homeId, hubInstallationId: replay.hubInstallationId, serialNumber: replay.manufacturingIdentity.serialNumber, claimPresentation: null, idempotentReplay: true };
          }
          if (existing) await tx.idempotencyRecord.delete({ where: { id: existing.id } });
          const idempotency = existing && existing.expiresAt <= now
            ? await tx.idempotencyRecord.create({ data: { namespace: 'hub-provisioning-approve', keyHash, actorId: employee.id, requestHash, responseStatus: 102, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) }, select: { id: true } })
            : existing
              ? existing
              : await tx.idempotencyRecord.create({ data: { namespace: 'hub-provisioning-approve', keyHash, actorId: employee.id, requestHash, responseStatus: 102, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) }, select: { id: true } });
          const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { id: true, assignedEmployeeId: true, state: true, homeId: true, hubInstallationId: true, certifiedSerialNumber: true, kind: true } });
          if (!work || work.assignedEmployeeId !== employee.id || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'workflow_not_assigned', 'This installation workflow is not assigned to the current employee');
          const attempt = await tx.hubProvisioningAttempt.findUnique({ where: { attemptId }, select: { id: true, attemptId: true, manufacturingIdentityId: true, hubInstallationId: true, companyWorkItemId: true, codeHash: true, state: true, expiresAt: true, baseUrlPresentation: true } });
          if (!attempt || attempt.expiresAt <= now || ['EXPIRED', 'REVOKED', 'CONSUMED'].includes(attempt.state)) throw new Stage1AuthError(409, 'pairing_attempt_unavailable', 'The provisioning presentation is unavailable');
          if (attempt.companyWorkItemId && attempt.companyWorkItemId !== work.id) throw new Stage1AuthError(403, 'workflow_attempt_mismatch', 'The provisioning attempt belongs to another workflow');
          if (attempt.hubInstallationId && work.hubInstallationId && attempt.hubInstallationId !== work.hubInstallationId) throw new Stage1AuthError(403, 'workflow_hub_mismatch', 'The selected workflow is bound to another hub');
          if (work.certifiedSerialNumber) {
            const checkedIdentity = await tx.hubManufacturingIdentity.findUnique({ where: { id: attempt.manufacturingIdentityId }, select: { serialNumber: true } });
            if (!checkedIdentity || checkedIdentity.serialNumber !== work.certifiedSerialNumber) throw new Stage1AuthError(403, 'workflow_serial_mismatch', 'The selected workflow is not assigned to this hub');
          }
          if (attempt.codeHash !== sha256(presentation)) throw new Stage1AuthError(401, 'pairing_presentation_invalid', 'The provisioning presentation is invalid');
          if (attempt.state !== 'PRESENTED' && attempt.state !== 'EMPLOYEE_APPROVED' && attempt.state !== 'CHALLENGE_ISSUED') throw new Stage1AuthError(409, 'pairing_state_invalid', 'The provisioning attempt is not ready for approval');
          let homeId = work.homeId;
          let hubInstallationId = work.hubInstallationId || attempt.hubInstallationId;
          let claimPresentation: string | null = null;
          const identity = await tx.hubManufacturingIdentity.findUniqueOrThrow({ where: { id: attempt.manufacturingIdentityId }, select: { serialNumber: true } });
          if (!hubInstallationId) {
            const home = homeId ? await tx.home.findUnique({ where: { id: homeId }, select: { id: true } }) : await tx.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'IN_PROGRESS' }, select: { id: true } });
            if (!home) throw new Stage1AuthError(409, 'workflow_home_missing', 'The installation home no longer exists');
            homeId = home.id;
            const hub = await tx.hubInstallation.create({ data: { homeId, manufacturingIdentityId: attempt.manufacturingIdentityId, serialNumberSnapshot: identity.serialNumber, baseUrl: attempt.baseUrlPresentation, reservedHostname: reservedHostname(identity.serialNumber), reservedTunnelName: reservedTunnelName(identity.serialNumber), state: 'PAIRING' }, select: { id: true } });
            hubInstallationId = hub.id;
            const homeToken = `dno_home_${randomSecret(32)}`;
            await tx.homeClaimReference.create({ data: { homeId, hubInstallationId, purpose: 'INITIAL_OWNER', generation: 1, state: 'AVAILABLE', companyQrReferenceHash: hashClaimReference(homeToken), resolverGeneration: 1, issuedAt: now } });
            await tx.hubInstallation.update({ where: { id: hubInstallationId }, data: { permanentResolverHash: hashClaimReference(homeToken), resolverIssuedAt: now } });
            claimPresentation = homeToken;
          }
          if (!homeId || !hubInstallationId) throw new Stage1AuthError(409, 'workflow_installation_missing', 'The installation is missing its home or hub binding');
          await tx.companyOperationalWorkItem.update({ where: { id: work.id }, data: { homeId, hubInstallationId, state: 'IN_PROGRESS', startedAt: work.state === 'ASSIGNED' ? now : undefined } });
          const updated = await tx.hubProvisioningAttempt.update({ where: { id: attempt.id }, data: { companyWorkItemId: work.id, hubInstallationId, redeemerEmployeeId: employee.id, state: 'EMPLOYEE_APPROVED', updatedAt: now }, select: { attemptId: true, state: true, expiresAt: true } });
          await tx.auditEvent.create({ data: { homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'hub_provisioning_approved', targetType: 'HubProvisioningAttempt', targetId: attempt.id, metadata: { workflowId: work.id, hubInstallationId, outcome: 'approved', idempotent: false }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
          const stableResponse = { attemptId: updated.attemptId, state: updated.state, expiresAt: updated.expiresAt, homeId, hubInstallationId, serialNumber: identity.serialNumber };
          await tx.idempotencyRecord.update({ where: { id: idempotency.id }, data: { homeId, responseStatus: 200, responseDigest: sha256(JSON.stringify(stableResponse)) } });
          return { ...stableResponse, claimPresentation, idempotentReplay: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if ((code === 'P2002' || code === 'P2034') && transactionAttempt < 2) continue;
        throw error;
      }
    }
    if (!result) throw new Stage1AuthError(503, 'provisioning_retry_exhausted', 'Provisioning could not be completed safely; please retry');
    return NextResponse.json({ ok: true, attemptId: result.attemptId, state: result.state, expiresAt: result.expiresAt, homeId: result.homeId, hubInstallationId: result.hubInstallationId, serialNumber: result.serialNumber, homeClaimPresentation: result.claimPresentation, idempotentReplay: result.idempotentReplay }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
