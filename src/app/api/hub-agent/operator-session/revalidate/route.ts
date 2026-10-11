import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { EMPLOYEE_SESSION_SECONDS, stage1NowMs } from '@/lib/stage1SessionPolicy';

export const dynamic = 'force-dynamic';

/** Current-authority check for an already-issued OS admin grant. Natural Portal
 * expiry is intentionally separate; explicit logout and current authority
 * changes revoke the OS grant. */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const machineAuthPresent = request.headers.has('x-dinodia-machine-version') || request.headers.has('x-dinodia-machine-signature');
    const hub = await authenticateHub(request, raw, { allowIdentity: !machineAuthPresent, maxBodyBytes: 16 * 1024 });
    const handoffId = String(hub.body.handoffId ?? '');
    const jti = String(hub.body.jti ?? '');
    const credentialVersion = Number(hub.body.credentialVersion ?? 0);
    if (!/^[0-9a-f-]{36}$/i.test(handoffId) || !/^[A-Za-z0-9_-]{16,128}$/.test(jti) || !Number.isSafeInteger(credentialVersion) || credentialVersion < 0) throw new Stage1AuthError(400, 'operator_revalidation_fields_invalid', 'The operator session check is invalid');
    const handoff = await prisma.operatorHandoff.findUnique({ where: { id: handoffId }, select: { id: true, employeeId: true, workflowId: true, homeId: true, hubInstallationId: true, consumedAt: true, revokedAt: true, scope: true } });
    if (!handoff || !handoff.consumedAt || handoff.revokedAt || handoff.hubInstallationId !== hub.installation.id || handoff.homeId !== hub.installation.homeId) throw new Stage1AuthError(401, 'operator_session_revoked', 'The Dinodia OS operator session is no longer authorised');
    const scope = handoff.scope && typeof handoff.scope === 'object' && !Array.isArray(handoff.scope) ? handoff.scope as Record<string, unknown> : {};
    if (!machineAuthPresent && String(scope.accessMode ?? '') !== 'local') throw new Stage1AuthError(401, 'operator_revalidation_machine_auth_required', 'Secure operator sessions require the active installation machine credential');
    const employeeSessionId = String(scope.employeeSessionId ?? '');
    const workRevision = Number(scope.workRevision);
    if (!employeeSessionId || !Number.isInteger(workRevision) || String(scope.operatorJti ?? '') !== jti || Number(scope.credentialVersion) !== credentialVersion) throw new Stage1AuthError(401, 'operator_session_authority_invalid', 'The Dinodia OS operator session authority is invalid');
    const [employee, employeeSession, work, installation, credential] = await Promise.all([
      prisma.companyEmployeeAccount.findUnique({ where: { id: handoff.employeeId }, select: { id: true, status: true } }),
      prisma.employeeSession.findUnique({ where: { id: employeeSessionId }, select: { id: true, employeeId: true, status: true, revokedAt: true, createdAt: true, expiresAt: true } }),
      prisma.companyOperationalWorkItem.findUnique({ where: { id: handoff.workflowId }, select: { id: true, kind: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, certifiedSerialNumber: true, state: true, workRevision: true, permanentInstallationRequestId: true } }),
      prisma.hubInstallation.findUnique({ where: { id: handoff.hubInstallationId }, select: { id: true, homeId: true, state: true, serialNumberSnapshot: true, manufacturingIdentity: { select: { identityGeneration: true, status: true } } } }),
      credentialVersion > 0 ? prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: handoff.hubInstallationId, purpose: 'operator-credential', version: credentialVersion }, select: { state: true, revokedReason: true } }) : Promise.resolve(null),
    ]);
    if (!employee || employee.status !== 'ACTIVE' || !employeeSession || employeeSession.employeeId !== employee.id || employeeSession.status !== 'ACTIVE' || employeeSession.revokedAt || employeeSession.expiresAt.getTime() <= stage1NowMs() || employeeSession.expiresAt.getTime() - employeeSession.createdAt.getTime() > EMPLOYEE_SESSION_SECONDS * 1000) throw new Stage1AuthError(401, 'operator_employee_session_revoked', 'The Company Portal session is expired, retired or the employee is inactive');
    const scopes = Array.isArray(scope.scopes) ? scope.scopes.map(String) : [];
    const permanentInstallation = scopes.length === 1 && scopes[0] === 'os:permanent-installation';
    if (!work || work.assignedEmployeeId !== employee.id || work.homeId !== handoff.homeId || work.hubInstallationId !== handoff.hubInstallationId || work.certifiedSerialNumber !== hub.identity.serialNumber || work.workRevision !== workRevision
      || permanentInstallation && (work.kind !== 'PERMANENT_DEVICE_INSTALLATION' || work.state !== 'IN_PROGRESS' || work.permanentInstallationRequestId !== String(scope.requestId || ''))
      || !permanentInstallation && (scopes.length !== 1 || scopes[0] !== 'os:admin' || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state))) throw new Stage1AuthError(401, 'operator_work_revoked', 'The assigned installation work is no longer active');
    if (permanentInstallation) {
      const currentRequest = await prisma.permanentDeviceInstallationRequest.findFirst({ where: { id: String(scope.requestId || ''), homeId: handoff.homeId, status: 'IN_PROGRESS', workItem: { is: { id: work.id, assignedEmployeeId: employee.id, workRevision } } }, select: { id: true, requestedAreaId: true } });
      const areas = currentRequest ? await prisma.area.findMany({ where: { homeId: handoff.homeId, status: 'ACTIVE', ...(currentRequest.requestedAreaId ? { id: currentRequest.requestedAreaId } : {}) }, select: { id: true, originalName: true } }) : [];
      const options = Array.isArray(scope.areaOptions) ? scope.areaOptions as Array<{ id?: unknown; name?: unknown }> : [];
      if (!currentRequest || !areas.length || options.length !== areas.length || areas.some((area) => !options.some((option) => option.id === area.id && option.name === area.originalName))) throw new Stage1AuthError(401, 'operator_installation_scope_changed', 'The assigned original Area options changed');
    }
    if (!installation || installation.state !== 'ACTIVE' || installation.homeId !== handoff.homeId || installation.serialNumberSnapshot !== hub.identity.serialNumber || installation.manufacturingIdentity?.status !== 'ACTIVE' || installation.manufacturingIdentity.identityGeneration !== hub.identity.identityGeneration || String(scope.serialNumber ?? '') !== hub.identity.serialNumber || Number(scope.identityGeneration) !== Number(hub.identity.identityGeneration)) throw new Stage1AuthError(401, 'operator_hub_replaced', 'The paired hub identity or installation is no longer active');
    if (credential?.revokedReason === 'emergency_operator_revocation') throw new Stage1AuthError(401, 'operator_credential_emergency_revoked', 'Operator access was emergency-revoked');
    // The hub has already proved its enrolled machine identity and this grant
    // was re-bound to that exact installation/Home above. Return those current
    // bindings so OS can compare them with its locally paired Platform state;
    // the signed operator token intentionally does not carry a DB installation
    // ID claim.
    return NextResponse.json({ ok: true, active: true, homeId: handoff.homeId, hubInstallationId: handoff.hubInstallationId }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
