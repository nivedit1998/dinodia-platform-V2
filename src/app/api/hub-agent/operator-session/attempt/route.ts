import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { lanEndpointFresh } from '@/lib/lanEndpoint';

export const dynamic = 'force-dynamic';

/**
 * Registers the browser attempt created by the hub. Secure attempts require
 * the active machine credential; the enrolled manufacturing identity may
 * register only a local recovery attempt. Company Portal cannot invent the
 * attempt id or browser binding and a second browser cannot replace it.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const machineAuthPresent = request.headers.has('x-dinodia-machine-version') || request.headers.has('x-dinodia-machine-signature');
    const hub = await authenticateHub(request, raw, { allowIdentity: !machineAuthPresent, maxBodyBytes: 16 * 1024 });
    const attemptId = String(hub.body.setupAttemptId ?? '').trim();
    const browserBindingHash = String(hub.body.browserBindingHash ?? '').trim().toLowerCase();
    const accessMode = String(hub.body.accessMode ?? '');
    const endpointOrigin = String(hub.body.operatorOrigin ?? '').trim();
    const expectedKeys = ['serial', 'identityGeneration', 'setupAttemptId', 'browserBindingHash', 'accessMode', 'operatorOrigin'];
    if (Object.keys(hub.body).length !== expectedKeys.length || Object.keys(hub.body).some((key) => !expectedKeys.includes(key))) {
      throw new Stage1AuthError(400, 'operator_attempt_invalid', 'The browser attempt contains unsupported authority');
    }
    if (!machineAuthPresent && accessMode !== 'local') {
      throw new Stage1AuthError(401, 'operator_attempt_machine_auth_required', 'Secure browser attempts require the active installation machine credential');
    }
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(attemptId) || !/^[a-f0-9]{64}$/.test(browserBindingHash)
      || !['secure', 'local'].includes(accessMode) || endpointOrigin.length > 500) {
      throw new Stage1AuthError(400, 'operator_attempt_invalid', 'A valid hub-created setup attempt is required');
    }
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(endpointOrigin); } catch { throw new Stage1AuthError(400, 'operator_origin_invalid', 'The operator browser origin is invalid'); }
    if (parsedOrigin.origin !== endpointOrigin || parsedOrigin.username || parsedOrigin.password || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.pathname !== '/') {
      throw new Stage1AuthError(400, 'operator_origin_invalid', 'The operator browser origin must be an exact origin');
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const result = await prisma.$transaction(async (tx) => {
      const installation = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: { id: true, homeId: true, cloudUrl: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, baseUrl: true, lanEndpointRevision: true, lanEndpointReportedAt: true, lanEndpointState: true, lanEndpointIdentityGeneration: true, manufacturingIdentity: { select: { identityGeneration: true, status: true } } } });
      if (!installation || installation.homeId !== hub.installation.homeId || installation.manufacturingIdentity?.status !== 'ACTIVE') throw new Stage1AuthError(409, 'hub_endpoint_unavailable', 'The paired hub endpoint is unavailable');
      const endpointRevision = accessMode === 'local' ? installation.lanEndpointRevision : 0;
      if (accessMode === 'secure') {
        if (!installation.cloudUrl || !installation.cloudUrlVerifiedAt || !installation.remoteVerificationAt || installation.cloudUrlVerifiedAt > now || installation.remoteVerificationAt > now) {
          throw new Stage1AuthError(409, 'secure_endpoint_unverified', 'The hub secure endpoint has not been verified');
        }
        let secureOrigin = '';
        try { const secure = new URL(installation.cloudUrl); if (secure.protocol === 'https:' && secure.pathname === '/' && !secure.search && !secure.hash && !secure.username && !secure.password) secureOrigin = secure.origin; } catch { /* fail closed below */ }
        if (!secureOrigin || endpointOrigin !== secureOrigin) throw new Stage1AuthError(403, 'operator_origin_mismatch', 'This browser is not using the verified secure hub endpoint');
      } else {
        let localOrigin = '';
        try {
          const local = new URL(installation.baseUrl || '');
          if (local.protocol === 'http:' && local.pathname === '/' && !local.search && !local.hash && !local.username && !local.password) localOrigin = local.origin;
        } catch { /* fail closed below */ }
        if (installation.lanEndpointIdentityGeneration !== installation.manufacturingIdentity.identityGeneration
          || !lanEndpointFresh(installation.lanEndpointState, installation.lanEndpointReportedAt, now.getTime())
          || !localOrigin || endpointOrigin !== localOrigin) {
          throw new Stage1AuthError(409, 'local_endpoint_stale', 'The paired hub has no current local endpoint for this browser');
        }
      }
      const existing = await tx.operatorBrowserAttempt.findUnique({ where: { attemptId }, select: { id: true, homeId: true, hubInstallationId: true, browserBindingHash: true, accessMode: true, endpointOrigin: true, endpointRevision: true, expiresAt: true, consumedAt: true, revokedAt: true } });
      if (existing) {
        if (existing.hubInstallationId !== hub.installation.id || existing.homeId !== hub.installation.homeId || existing.browserBindingHash !== browserBindingHash
          || existing.accessMode !== accessMode || existing.endpointOrigin !== endpointOrigin || existing.endpointRevision !== endpointRevision
          || existing.revokedAt || existing.consumedAt || existing.expiresAt <= now) {
          throw new Stage1AuthError(409, 'operator_attempt_rejected', 'The setup attempt is already bound or expired');
        }
        return { id: existing.id, attemptId, expiresAt: existing.expiresAt, reused: true };
      }
      const created = await tx.operatorBrowserAttempt.create({ data: { attemptId, homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, browserBindingHash, accessMode, endpointOrigin, endpointRevision, expiresAt }, select: { id: true, attemptId: true, expiresAt: true } });
      await tx.auditEvent.create({ data: { homeId: hub.installation.homeId, actorType: 'HUB', actorId: hub.installation.id, category: 'SECURITY', action: 'operator_browser_attempt_registered', targetType: 'OperatorBrowserAttempt', targetId: created.id, metadata: { attemptId: created.attemptId, accessMode, endpointRevision, outcome: 'registered', expiresAt: created.expiresAt.toISOString() }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { id: created.id, attemptId: created.attemptId, expiresAt: created.expiresAt, reused: false };
    });
    return NextResponse.json({ ok: true, setupAttemptId: result.attemptId, expiresAt: result.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
