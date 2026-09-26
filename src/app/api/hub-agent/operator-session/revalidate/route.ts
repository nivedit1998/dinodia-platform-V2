import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

/** Current-authority check for an already-issued OS admin grant. Natural Portal
 * expiry is intentionally separate; explicit logout and current authority
 * changes revoke the OS grant. */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const handoffId = String(hub.body.handoffId ?? '');
    const jti = String(hub.body.jti ?? '');
    const credentialVersion = Number(hub.body.credentialVersion ?? 0);
    if (!/^[0-9a-f-]{36}$/i.test(handoffId) || !/^[A-Za-z0-9_-]{16,128}$/.test(jti) || !Number.isSafeInteger(credentialVersion) || credentialVersion < 0) throw new Stage1AuthError(400, 'operator_revalidation_fields_invalid', 'The operator session check is invalid');
    const handoff = await prisma.operatorHandoff.findUnique({ where: { id: handoffId }, select: { id: true, employeeId: true, workflowId: true, homeId: true, hubInstallationId: true, consumedAt: true, revokedAt: true, scope: true } });
    if (!handoff || !handoff.consumedAt || handoff.revokedAt || handoff.hubInstallationId !== hub.installation.id || handoff.homeId !== hub.installation.homeId) throw new Stage1AuthError(401, 'operator_session_revoked', 'The Dinodia OS operator session is no longer authorised');
    const scope = handoff.scope && typeof handoff.scope === 'object' && !Array.isArray(handoff.scope) ? handoff.scope as Record<string, unknown> : {};
    const employeeSessionId = String(scope.employeeSessionId ?? '');
    const workRevision = Number(scope.workRevision);
    if (!employeeSessionId || !Number.isInteger(workRevision) || String(scope.operatorJti ?? '') !== jti || Number(scope.credentialVersion) !== credentialVersion) throw new Stage1AuthError(401, 'operator_session_authority_invalid', 'The Dinodia OS operator session authority is invalid');
    const [employee, employeeSession, work, installation, credential] = await Promise.all([
      prisma.companyEmployeeAccount.findUnique({ where: { id: handoff.employeeId }, select: { id: true, status: true } }),
      prisma.employeeSession.findUnique({ where: { id: employeeSessionId }, select: { id: true, employeeId: true, status: true, revokedAt: true } }),
      prisma.companyOperationalWorkItem.findUnique({ where: { id: handoff.workflowId }, select: { id: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, certifiedSerialNumber: true, state: true, workRevision: true } }),
      prisma.hubInstallation.findUnique({ where: { id: handoff.hubInstallationId }, select: { id: true, homeId: true, state: true, serialNumberSnapshot: true, manufacturingIdentity: { select: { identityGeneration: true, status: true } } } }),
      credentialVersion > 0 ? prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: handoff.hubInstallationId, purpose: 'operator-credential', version: credentialVersion }, select: { state: true, revokedReason: true } }) : Promise.resolve(null),
    ]);
    if (!employee || employee.status !== 'ACTIVE' || !employeeSession || employeeSession.employeeId !== employee.id || employeeSession.status !== 'ACTIVE' || employeeSession.revokedAt) throw new Stage1AuthError(401, 'operator_employee_session_revoked', 'The Company Portal session was explicitly ended or the employee is inactive');
    if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== handoff.homeId || work.hubInstallationId !== handoff.hubInstallationId || work.certifiedSerialNumber !== hub.identity.serialNumber || work.workRevision !== workRevision || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(401, 'operator_work_revoked', 'The assigned installation work is no longer active');
    if (!installation || installation.state !== 'ACTIVE' || installation.homeId !== handoff.homeId || installation.serialNumberSnapshot !== hub.identity.serialNumber || installation.manufacturingIdentity?.status !== 'ACTIVE' || installation.manufacturingIdentity.identityGeneration !== hub.identity.identityGeneration || String(scope.serialNumber ?? '') !== hub.identity.serialNumber || Number(scope.identityGeneration) !== Number(hub.identity.identityGeneration)) throw new Stage1AuthError(401, 'operator_hub_replaced', 'The paired hub identity or installation is no longer active');
    if (credential?.revokedReason === 'emergency_operator_revocation') throw new Stage1AuthError(401, 'operator_credential_emergency_revoked', 'Operator access was emergency-revoked');
    return NextResponse.json({ ok: true, active: true }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
