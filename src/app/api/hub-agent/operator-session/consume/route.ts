import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { encryptOperatorGrant, createHubBoundOperatorGrant, isStrictlyUnexpired } from '@/lib/stage1Operator';
import { sha256 } from '@/lib/stage1Crypto';
import { OPERATOR_SESSION_SECONDS, stage1NowMs } from '@/lib/stage1SessionPolicy';
import { lanEndpointFresh } from '@/lib/lanEndpoint';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const machineAuthPresent = request.headers.has('x-dinodia-machine-version') || request.headers.has('x-dinodia-machine-signature');
    const hub = await authenticateHub(request, raw, { allowIdentity: !machineAuthPresent, maxBodyBytes: 16 * 1024 });
    const handoffId = String(hub.body.handoffId ?? '').trim();
    const browserBinding = String(hub.body.browserBinding ?? '').trim();
    const setupAttemptId = String(hub.body.setupAttemptId ?? '').trim();
    const phase = String(hub.body.phase ?? 'consume').trim();
    const handoffSecret = String(hub.body.handoffSecret ?? '').trim();
    if (!['prepare', 'consume'].includes(phase) || !/^[0-9a-f-]{36}$/i.test(handoffId) || !/^[A-Za-z0-9_-]{32,256}$/.test(browserBinding) || !/^[A-Za-z0-9_-]{32,160}$/.test(setupAttemptId)) throw new Stage1AuthError(400, 'handoff_invalid', 'A valid operator handoff phase, id, setup attempt and browser binding are required');
    if (phase === 'consume' && !/^[A-Za-z0-9_-]{32,256}$/.test(handoffSecret)) throw new Stage1AuthError(401, 'handoff_secret_required', 'The hub must prove possession of the one-use handoff secret');
    const now = new Date(stage1NowMs());
    const result = await prisma.$transaction(async (tx) => {
      const handoff = await tx.operatorHandoff.findUnique({ where: { id: handoffId }, select: { id: true, employeeId: true, workflowId: true, homeId: true, hubInstallationId: true, operatorBrowserAttemptId: true, setupAttemptId: true, scope: true, createdAt: true, expiresAt: true, consumedAt: true, revokedAt: true, browserBindingHash: true, handoffHash: true, handoffEnvelope: true } });
      if (!handoff || handoff.hubInstallationId !== hub.installation.id || handoff.homeId !== hub.installation.homeId || !isStrictlyUnexpired(handoff.expiresAt, now) || handoff.consumedAt || handoff.revokedAt) throw new Stage1AuthError(401, 'handoff_rejected', 'The operator handoff is invalid or expired');
      if (!handoff.operatorBrowserAttemptId) throw new Stage1AuthError(401, 'handoff_attempt_missing', 'The operator handoff has no hub-created browser attempt');
      const browserAttempt = await tx.operatorBrowserAttempt.findUnique({ where: { id: handoff.operatorBrowserAttemptId }, select: { id: true, attemptId: true, homeId: true, hubInstallationId: true, browserBindingHash: true, accessMode: true, endpointOrigin: true, endpointRevision: true, expiresAt: true, consumedAt: true, revokedAt: true } });
      if (!browserAttempt || browserAttempt.homeId !== handoff.homeId || browserAttempt.hubInstallationId !== handoff.hubInstallationId || browserAttempt.attemptId !== setupAttemptId || browserAttempt.browserBindingHash !== sha256(browserBinding) || !isStrictlyUnexpired(browserAttempt.expiresAt, now) || browserAttempt.consumedAt || browserAttempt.revokedAt || handoff.browserBindingHash !== browserAttempt.browserBindingHash) throw new Stage1AuthError(401, 'handoff_rejected', 'The operator handoff is not bound to this hub browser');
      const handoffScope = handoff.scope && typeof handoff.scope === 'object' && !Array.isArray(handoff.scope) ? handoff.scope as Record<string, unknown> : {};
      const accessMode = String(handoffScope.accessMode ?? '');
      if (!machineAuthPresent && accessMode !== 'local') throw new Stage1AuthError(401, 'handoff_machine_auth_required', 'Secure operator handoffs require the active installation machine credential');
      const endpointOrigin = String(handoffScope.endpointOrigin ?? '');
      const endpointRevision = Number(handoffScope.endpointRevision);
      const endpoint = await tx.hubInstallation.findUnique({ where: { id: handoff.hubInstallationId }, select: { baseUrl: true, cloudUrl: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, lanEndpointRevision: true, lanEndpointReportedAt: true, lanEndpointState: true, lanEndpointIdentityGeneration: true, manufacturingIdentity: { select: { identityGeneration: true, status: true } } } });
      let currentOrigin = '';
      if (accessMode === 'secure' && endpoint?.cloudUrl && endpoint.cloudUrlVerifiedAt && endpoint.remoteVerificationAt && endpoint.cloudUrlVerifiedAt <= now && endpoint.remoteVerificationAt <= now) {
        try { const secure = new URL(endpoint.cloudUrl); if (secure.protocol === 'https:' && secure.pathname === '/' && !secure.search && !secure.hash && !secure.username && !secure.password) currentOrigin = secure.origin; } catch { /* fail closed below */ }
      } else if (accessMode === 'local' && endpoint?.baseUrl && endpoint.manufacturingIdentity?.status === 'ACTIVE'
        && endpoint.lanEndpointIdentityGeneration === endpoint.manufacturingIdentity.identityGeneration
        && endpoint.lanEndpointRevision === endpointRevision
        && lanEndpointFresh(endpoint.lanEndpointState, endpoint.lanEndpointReportedAt, now.getTime())) {
        try { const local = new URL(endpoint.baseUrl); if (local.protocol === 'http:' && local.pathname === '/' && !local.search && !local.hash && !local.username && !local.password) currentOrigin = local.origin; } catch { /* fail closed below */ }
      }
      if (!currentOrigin || currentOrigin !== endpointOrigin || browserAttempt.accessMode !== accessMode || browserAttempt.endpointOrigin !== endpointOrigin || browserAttempt.endpointRevision !== endpointRevision) {
        throw new Stage1AuthError(409, 'operator_endpoint_changed', 'The hub endpoint changed after this browser handoff was prepared; launch again');
      }
      if (phase === 'prepare') return { handoffSecretEnvelope: handoff.handoffEnvelope };
      if (sha256(handoffSecret) !== handoff.handoffHash) throw new Stage1AuthError(401, 'handoff_secret_invalid', 'The one-use operator handoff secret is invalid');
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: handoff.workflowId }, select: { id: true, kind: true, assignedEmployeeId: true, homeId: true, hubInstallationId: true, certifiedSerialNumber: true, state: true, workRevision: true, permanentInstallationRequestId: true } });
      const scopes = Array.isArray(handoffScope.scopes) ? handoffScope.scopes.map(String) : [];
      const permanentInstallation = scopes.length === 1 && scopes[0] === 'os:permanent-installation';
      if (!work || work.assignedEmployeeId !== handoff.employeeId || work.homeId !== handoff.homeId || work.hubInstallationId !== handoff.hubInstallationId
        || permanentInstallation && (work.kind !== 'PERMANENT_DEVICE_INSTALLATION' || work.state !== 'IN_PROGRESS' || !work.permanentInstallationRequestId)
        || !permanentInstallation && (scopes.length !== 1 || scopes[0] !== 'os:admin' || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state))) throw new Stage1AuthError(403, 'workflow_revoked', 'The operator workflow is no longer valid');
      const employeeSessionId = String(handoffScope.employeeSessionId ?? '');
      const workRevision = Number(handoffScope.workRevision);
      if (!employeeSessionId || !Number.isInteger(workRevision) || workRevision !== work.workRevision || String(handoffScope.serialNumber ?? '') !== hub.identity.serialNumber || Number(handoffScope.identityGeneration) !== Number(hub.identity.identityGeneration) || work.certifiedSerialNumber !== hub.identity.serialNumber) throw new Stage1AuthError(403, 'workflow_authority_stale', 'The operator workflow authority has changed');
      const employeeSession = await tx.employeeSession.findUnique({ where: { id: employeeSessionId }, select: { id: true, employeeId: true, status: true, revokedAt: true, createdAt: true, expiresAt: true, recentAuthenticatedAt: true } });
      if (!employeeSession || employeeSession.employeeId !== handoff.employeeId || employeeSession.status !== 'ACTIVE' || employeeSession.revokedAt
        || employeeSession.createdAt > handoff.createdAt || handoff.createdAt >= employeeSession.expiresAt
        || employeeSession.expiresAt.getTime() - employeeSession.createdAt.getTime() > 24 * 60 * 60 * 1000) throw new Stage1AuthError(403, 'employee_session_revoked', 'The employee session that authorized this handoff is no longer active');
      let requestId: string | undefined;
      let areaOptions: Array<{ id: string; name: string }> | undefined;
      if (permanentInstallation) {
        requestId = String(handoffScope.requestId || '');
        if (!/^[0-9a-f-]{36}$/i.test(requestId) || requestId !== work.permanentInstallationRequestId) throw new Stage1AuthError(403, 'installation_request_revoked', 'The assigned installation request changed');
        const currentRequest = await tx.permanentDeviceInstallationRequest.findFirst({ where: { id: requestId, homeId: handoff.homeId, status: 'IN_PROGRESS', workItem: { is: { id: work.id, assignedEmployeeId: handoff.employeeId, workRevision } } }, select: { id: true, requestedAreaId: true } });
        if (!currentRequest) throw new Stage1AuthError(403, 'installation_request_revoked', 'The assigned installation request is no longer current');
        const areas = await tx.area.findMany({ where: { homeId: handoff.homeId, status: 'ACTIVE', ...(currentRequest.requestedAreaId ? { id: currentRequest.requestedAreaId } : {}) }, select: { id: true, originalName: true }, orderBy: { originalName: 'asc' }, take: 64 });
        const suppliedOptions = Array.isArray(handoffScope.areaOptions) ? handoffScope.areaOptions as Array<{ id?: unknown; name?: unknown }> : [];
        areaOptions = suppliedOptions.filter((entry) => areas.some((area) => area.id === String(entry?.id || '')) && typeof entry?.name === 'string')
          .map((entry) => ({ id: String(entry.id), name: String(entry.name).slice(0, 120) }));
        if (!areas.length || areaOptions.length !== areas.length || areas.some((area) => !areaOptions!.some((option) => option.id === area.id && option.name === area.originalName))) throw new Stage1AuthError(403, 'installation_area_changed', 'The assigned original Area options changed; relaunch from Company Portal');
      }
      const credential = await tx.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: { in: ['ACTIVE', 'GRACE'] } }, orderBy: { version: 'desc' }, select: { version: true } });
      const issuedAt = Math.floor(now.getTime() / 1000) * 1000;
      const sessionLifetimeSeconds = OPERATOR_SESSION_SECONDS;
      const grantExpiresAt = issuedAt + sessionLifetimeSeconds * 1000;
      const operatorJti = crypto.randomUUID();
      const credentialVersion = credential?.version ?? 0;
      const grant = createHubBoundOperatorGrant({ employeeId: handoff.employeeId, hubId: hub.installation.serialNumberSnapshot, workflowId: handoff.workflowId, scope: permanentInstallation ? scopes : ['os:admin'], ...(areaOptions ? { areaIds: areaOptions.map((area) => area.id), areaOptions } : {}), ...(requestId ? { requestId } : {}), recentAuthAt: employeeSession.recentAuthenticatedAt.getTime(), issuedAt, expiresAt: grantExpiresAt, credentialVersion, homeId: handoff.homeId, identityGeneration: hub.identity.identityGeneration, handoffId: handoff.id, employeeSessionId, workRevision, operatorJti });
      const encryptedSessionGrant = encryptOperatorGrant(grant, hub.identity.encryptionPublicKey, 1);
      const consumed = await tx.operatorHandoff.updateMany({ where: { id: handoff.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now }, setupAttemptId, browserBindingHash: sha256(browserBinding) }, data: { consumedAt: now, scope: { ...handoffScope, operatorJti, credentialVersion, operatorIssuedAt: issuedAt, operatorExpiresAt: grantExpiresAt } } });
      if (consumed.count !== 1) throw new Stage1AuthError(401, 'handoff_replay', 'The operator handoff was already consumed or revoked');
      const attemptConsumed = await tx.operatorBrowserAttempt.updateMany({ where: { id: browserAttempt.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
      if (attemptConsumed.count !== 1) throw new Stage1AuthError(401, 'handoff_browser_replay', 'The originating browser attempt was already consumed or revoked');
      return { encryptedSessionGrant, expiresAt: new Date(grantExpiresAt) };
    });
    if ('handoffSecretEnvelope' in result) return NextResponse.json({ ok: true, handoffSecretEnvelope: result.handoffSecretEnvelope }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    return NextResponse.json({ ok: true, sessionGrant: { version: 1, envelope: result.encryptedSessionGrant }, expiresAt: result.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
