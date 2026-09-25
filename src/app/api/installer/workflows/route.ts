import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, requireEmployee, requireEmployeeRecentAuth, Stage1AuthError } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { sha256 } from '@/lib/stage1Crypto';
import { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

/**
 * Company Portal uses this server-owned list to populate the workflow picker.
 * A browser-supplied workflowId is therefore only a lookup key; it cannot
 * create authority or select work belonging to another employee.
 */
export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const url = new URL(request.url);
    const homeId = url.searchParams.get('homeId');
    const work = await prisma.companyOperationalWorkItem.findMany({
      where: {
        assignedEmployeeId: employee.id,
        ...(homeId ? { homeId } : {}),
        state: { in: ['ASSIGNED', 'IN_PROGRESS', 'REOPENED'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        publicReference: true,
        kind: true,
        state: true,
        homeId: true,
        hubInstallationId: true,
        certifiedSerialNumber: true,
        reason: true,
        notes: true,
        workRevision: true,
        updatedAt: true,
        hubInstallation: { select: { baseUrl: true, cloudUrl: true } },
      },
    });
    const employees = employee.role === 'CXO' || employee.role === 'SENIOR_OPERATIONS_MANAGER'
      ? await prisma.companyEmployeeAccount.findMany({ where: { status: 'ACTIVE', role: { in: ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER'] } }, select: { id: true, displayName: true, role: true }, orderBy: { displayName: 'asc' } })
      : [];
    return NextResponse.json({ ok: true, employee: { id: employee.id, role: employee.role }, workflows: work, employees }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * Create an installation work item from a persisted manufacturing attempt.
 * The caller may select an attempt and employee, but cannot supply a home,
 * hub, role or serial as authority. Those values come from durable records.
 */
export async function POST(request: Request) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const idempotencyKey = String(request.headers.get('idempotency-key') ?? '').trim();
    if (!idempotencyKey || idempotencyKey.length > 160) throw new Stage1AuthError(400, 'work_assignment_idempotency_required', 'An idempotency key is required');
    await enforcePersistentRateLimit(`work-assignment:${employee.id}`, 20, 15 * 60 * 1000);
    const body = await request.json() as Record<string, unknown>;
    const attemptId = String(body.attemptId ?? '').trim();
    const assignedEmployeeId = String(body.assignedEmployeeId ?? '').trim();
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    const kind = String(body.kind ?? 'INITIAL_HUB_INSTALLATION');
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(attemptId) || !assignedEmployeeId || !reason || !['INITIAL_HUB_INSTALLATION', 'PHYSICAL_CONFIGURATION_CORRECTION', 'HUB_RECOVERY'].includes(kind)) throw new Stage1AuthError(400, 'work_assignment_fields_invalid', 'Attempt, eligible employee, work type and reason are required');
    const requestHash = sha256(JSON.stringify({ attemptId, assignedEmployeeId, kind, reason }));
    const keyHash = sha256(`${employee.id}:${idempotencyKey}`);
    const now = new Date();
    let result: { id: string; publicReference: string; state: string; certifiedSerialNumber: string; assignedEmployeeId: string; idempotentReplay: boolean } | undefined;
    for (let retry = 0; retry < 3 && !result; retry += 1) {
      try {
        result = await prisma.$transaction(async (tx) => {
          const existing = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: 'company-work-assignment', keyHash } }, select: { id: true, actorId: true, requestHash: true, responseDigest: true, expiresAt: true } });
          if (existing && existing.expiresAt > now && (existing.actorId !== employee.id || existing.requestHash !== requestHash)) throw new Stage1AuthError(409, 'idempotency_key_reused', 'The idempotency key was already used for another work assignment');
          if (existing?.expiresAt && existing.expiresAt > now && existing.responseDigest) {
            const replay = await tx.companyOperationalWorkItem.findFirst({ where: { createdByEmployeeId: employee.id, reason, provisioningAttempts: { some: { attemptId } } }, select: { id: true, publicReference: true, state: true, certifiedSerialNumber: true, assignedEmployeeId: true } });
            if (!replay || !replay.certifiedSerialNumber) throw new Stage1AuthError(409, 'work_assignment_replay_unavailable', 'The original work assignment is no longer available');
            return { id: replay.id, publicReference: replay.publicReference, state: replay.state, certifiedSerialNumber: replay.certifiedSerialNumber, assignedEmployeeId: replay.assignedEmployeeId, idempotentReplay: true };
          }
          if (existing && existing.expiresAt <= now) {
            await tx.idempotencyRecord.delete({ where: { id: existing.id } });
          }
          const attempt = await tx.hubProvisioningAttempt.findUnique({ where: { attemptId }, select: { id: true, attemptId: true, companyWorkItemId: true, expiresAt: true, state: true, manufacturingIdentity: { select: { serialNumber: true, status: true } } } });
          if (!attempt || attempt.expiresAt <= now || ['EXPIRED', 'REVOKED', 'CONSUMED'].includes(attempt.state) || attempt.manufacturingIdentity.status !== 'ACTIVE') throw new Stage1AuthError(409, 'provisioning_attempt_unavailable', 'The manufacturing provisioning attempt is not available for assignment');
          const assignee = await tx.companyEmployeeAccount.findUnique({ where: { id: assignedEmployeeId }, select: { id: true, role: true, status: true } });
          if (!assignee || assignee.status !== 'ACTIVE' || !['INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'CXO'].includes(assignee.role)) throw new Stage1AuthError(403, 'work_assignee_invalid', 'Only an active installation employee may receive this work');
          if (attempt.companyWorkItemId) {
            const linked = await tx.companyOperationalWorkItem.findUnique({ where: { id: attempt.companyWorkItemId }, select: { id: true, publicReference: true, state: true, certifiedSerialNumber: true, assignedEmployeeId: true } });
            if (!linked || linked.certifiedSerialNumber !== attempt.manufacturingIdentity.serialNumber) throw new Stage1AuthError(409, 'work_assignment_conflict', 'The provisioning attempt is already assigned');
            return { id: linked.id, publicReference: linked.publicReference, state: linked.state, certifiedSerialNumber: linked.certifiedSerialNumber, assignedEmployeeId: linked.assignedEmployeeId, idempotentReplay: true };
          }
          const idempotency = await tx.idempotencyRecord.create({ data: { namespace: 'company-work-assignment', keyHash, actorId: employee.id, requestHash, responseStatus: 201, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) }, select: { id: true } });
          const work = await tx.companyOperationalWorkItem.create({ data: { publicReference: `DIN-${sha256(`${attempt.attemptId}:${now.toISOString()}`).slice(0, 16).toUpperCase()}`, kind: kind as 'INITIAL_HUB_INSTALLATION' | 'PHYSICAL_CONFIGURATION_CORRECTION' | 'HUB_RECOVERY', state: 'ASSIGNED', certifiedSerialNumber: attempt.manufacturingIdentity.serialNumber, assignedEmployeeId: assignee.id, createdByEmployeeId: employee.id, reason }, select: { id: true, publicReference: true, state: true, certifiedSerialNumber: true, assignedEmployeeId: true } });
          await tx.hubProvisioningAttempt.update({ where: { id: attempt.id }, data: { companyWorkItemId: work.id } });
          await tx.idempotencyRecord.update({ where: { id: idempotency.id }, data: { responseDigest: sha256(JSON.stringify(work)) } });
          await tx.auditEvent.create({ data: { actorType: 'EMPLOYEE', actorId: employee.id, category: 'INSTALLATION', action: 'installation_work_assigned', targetType: 'CompanyOperationalWorkItem', targetId: work.id, metadata: { assignedEmployeeId: assignee.id, serialNumber: attempt.manufacturingIdentity.serialNumber, kind, outcome: 'assigned' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
          return { id: work.id, publicReference: work.publicReference, state: work.state, certifiedSerialNumber: attempt.manufacturingIdentity.serialNumber, assignedEmployeeId: work.assignedEmployeeId, idempotentReplay: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if ((code === 'P2002' || code === 'P2034') && retry < 2) continue;
        throw error;
      }
    }
    if (!result) throw new Stage1AuthError(503, 'work_assignment_retry_exhausted', 'The installation work could not be assigned safely; please retry');
    return NextResponse.json({ ok: true, work: result }, { status: result.idempotentReplay ? 200 : 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
