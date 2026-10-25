import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import type { authenticateHub } from './stage1HubAuth';
import { EMPLOYEE_SESSION_SECONDS, OPERATOR_SESSION_SECONDS, stage1NowMs } from './stage1SessionPolicy';

/** Current durable full-Home authority, rechecked inside the protected mutation transaction. */
export async function assertFullHomeOperator(tx: Prisma.TransactionClient,
  hub: Awaited<ReturnType<typeof authenticateHub>>, proof: { handoffId: string; jti: string; credentialVersion: number }) {
  function deny(): never { throw new Stage1AuthError(403, 'full_home_operator_denied', 'A current full Home operator session is required'); }
  if (!/^[0-9a-f-]{36}$/i.test(proof.handoffId) || !/^[A-Za-z0-9_-]{16,128}$/.test(proof.jti)
    || !Number.isSafeInteger(proof.credentialVersion) || proof.credentialVersion < 0) deny();
  const handoff = await tx.operatorHandoff.findUnique({ where: { id: proof.handoffId } });
  if (!handoff?.consumedAt || handoff.revokedAt || handoff.homeId !== hub.installation.homeId
    || handoff.hubInstallationId !== hub.installation.id) deny();
  const scope = handoff.scope as Record<string, unknown> | null;
  const scopes = Array.isArray(scope?.scopes) ? scope.scopes : [];
  if (!scope || scopes.length !== 1 || scopes[0] !== 'os:admin'
    || scope.operatorJti !== proof.jti || Number(scope.credentialVersion) !== proof.credentialVersion
    || Number(scope.identityGeneration) !== hub.identity.identityGeneration || scope.serialNumber !== hub.identity.serialNumber) deny();
  const [employee, session, work, installation, credential] = await Promise.all([
    tx.companyEmployeeAccount.findUnique({ where: { id: handoff.employeeId } }),
    tx.employeeSession.findUnique({ where: { id: String(scope.employeeSessionId || '') } }),
    tx.companyOperationalWorkItem.findUnique({ where: { id: handoff.workflowId } }),
    tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, include: { manufacturingIdentity: true } }),
    proof.credentialVersion > 0 ? tx.hubCredentialVersion.findFirst({ where: {
      hubInstallationId: hub.installation.id, purpose: 'operator-credential', version: proof.credentialVersion } }) : null,
  ]);
  const now = stage1NowMs(), issued = Number(scope.operatorIssuedAt), expires = Number(scope.operatorExpiresAt);
  if (!employee || employee.status !== 'ACTIVE' || !session || session.employeeId !== employee.id
    || session.status !== 'ACTIVE' || session.revokedAt || handoff.createdAt >= session.expiresAt
    || session.expiresAt.getTime() - session.createdAt.getTime() > EMPLOYEE_SESSION_SECONDS * 1000
    || !Number.isSafeInteger(issued) || !Number.isSafeInteger(expires)
    || issued < Math.floor(handoff.createdAt.getTime() / 1000) * 1000
    || issued > Math.floor(handoff.consumedAt.getTime() / 1000) * 1000
    || issued > now + 5000
    || expires - issued !== OPERATOR_SESSION_SECONDS * 1000 || expires <= now
    || !work || work.assignedEmployeeId !== employee.id || work.homeId !== hub.installation.homeId
    || work.hubInstallationId !== hub.installation.id || work.certifiedSerialNumber !== hub.identity.serialNumber
    || work.workRevision !== Number(scope.workRevision) || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state)
    || !installation || installation.state !== 'ACTIVE' || installation.homeId !== hub.installation.homeId
    || installation.serialNumberSnapshot !== hub.identity.serialNumber
    || installation.manufacturingIdentity?.status !== 'ACTIVE'
    || installation.manufacturingIdentity.identityGeneration !== hub.identity.identityGeneration
    || credential?.revokedReason === 'emergency_operator_revocation') deny();
  return { homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, employeeId: employee.id };
}
