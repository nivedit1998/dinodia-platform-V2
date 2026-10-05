import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { validateLanEndpointObservation, validateLanTlsIdentity } from '@/lib/lanEndpoint';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { sha256 } from '@/lib/stage1Crypto';
import { parseHubSyncOutboxReport } from '@/lib/hubSyncTelemetry';

export const dynamic = 'force-dynamic';

function nativeSyncOutboxReport(runtime: Record<string, unknown>) {
  const capabilities = runtime.capabilities && typeof runtime.capabilities === 'object' && !Array.isArray(runtime.capabilities)
    ? runtime.capabilities as Record<string, unknown> : null;
  return parseHubSyncOutboxReport(capabilities?.nativeSyncOutbox);
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const runtime = hub.body.hubRuntime && typeof hub.body.hubRuntime === 'object' ? hub.body.hubRuntime as Record<string, unknown> : {};
    const syncReport = nativeSyncOutboxReport(runtime);
    const now = new Date();

    // Liveness is a separate signal: a malformed or stale endpoint report can
    // never become a browser route, but it does not erase a valid signed pulse.
    await prisma.hubInstallation.update({ where: { id: hub.installation.id }, data: {
      lastSeenAt: now,
      onlineStateEvaluatedAt: now,
      runtimeVersion: String(runtime.version ?? '').slice(0, 120) || undefined,
      capabilitySummary: runtime.capabilities && typeof runtime.capabilities === 'object' ? runtime.capabilities : undefined,
      ...(syncReport ? {
        lastQueueDepth: syncReport.queueDepth,
        lastSyncErrorCode: syncReport.lastErrorCode,
        syncGapDetected: syncReport.gapDetected,
        syncCriticalBacklog: syncReport.criticalBacklog,
        syncTelemetryPaused: syncReport.telemetryPaused,
        syncDroppedTelemetryCount: syncReport.droppedTelemetryCount,
      } : {}),
    } });

    if (hub.body.lanEndpoint === undefined && hub.body.lanTlsIdentity === undefined) {
      return NextResponse.json({ ok: true, online: true, lastSeenAt: now.toISOString() }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    }

    let accepted: { revision: number; state: string; reportedAt: string } | undefined;
    if (hub.body.lanEndpoint !== undefined) {
    const observation = validateLanEndpointObservation(hub.body.lanEndpoint, hub.identity.serialNumber, 80);
    const before = await prisma.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: { id: true, homeId: true, baseUrl: true, lanEndpointRevision: true, lanEndpointState: true, lanEndpointIdentityGeneration: true } });
    if (!before) throw new Stage1AuthError(409, 'hub_installation_unavailable', 'The authenticated installation is no longer available');
    if (observation.revision > before.lanEndpointRevision) {
      await enforcePersistentRateLimit(`hub-lan-endpoint:${before.id}`, 20, 60 * 60 * 1000);
    }

    for (let retry = 0; retry < 3 && !accepted; retry += 1) {
      try {
        accepted = await prisma.$transaction(async (tx) => {
      const installation = await tx.hubInstallation.findUnique({ where: { id: before.id }, select: { id: true, homeId: true, baseUrl: true, serialNumberSnapshot: true, lanEndpointRevision: true, lanEndpointState: true, lanEndpointIdentityGeneration: true } });
      const currentIdentity = await tx.hubManufacturingIdentity.findFirst({ where: { serialNumber: hub.identity.serialNumber, identityGeneration: hub.identity.identityGeneration, status: 'ACTIVE' }, select: { id: true, identityGeneration: true } });
      if (!installation || installation.serialNumberSnapshot !== hub.identity.serialNumber || !currentIdentity) throw new Stage1AuthError(401, 'hub_identity_revoked', 'The authenticated hub identity is no longer active');
      const currentRevision = installation.lanEndpointRevision;
      const knownGeneration = installation.lanEndpointIdentityGeneration;
      if (currentRevision > 0 && knownGeneration !== hub.identity.identityGeneration) {
        throw new Stage1AuthError(409, 'lan_endpoint_generation_reset_required', 'LAN endpoint revision recovery is required for this identity generation');
      }
      if (observation.revision < currentRevision) throw new Stage1AuthError(409, 'lan_endpoint_revision_stale', 'A newer LAN endpoint revision is already recorded');
      const samePayload = installation.lanEndpointState === observation.state
        && (observation.state === 'UNAVAILABLE' || installation.baseUrl === observation.baseUrl)
        && (knownGeneration === null || knownGeneration === hub.identity.identityGeneration);
      if (observation.revision === currentRevision && currentRevision > 0 && !samePayload) {
        throw new Stage1AuthError(409, 'lan_endpoint_revision_conflict', 'This LAN endpoint revision was already used for different endpoint data');
      }
      if (observation.revision === currentRevision && currentRevision === 0) {
        throw new Stage1AuthError(409, 'lan_endpoint_revision_stale', 'The initial LAN endpoint revision must be positive');
      }

      const isRefresh = observation.revision === currentRevision;
      const data = {
        baseUrl: observation.state === 'CURRENT' ? observation.baseUrl : installation.baseUrl,
        lanEndpointRevision: observation.revision,
        lanEndpointReportedAt: now,
        lanEndpointState: observation.state,
        lanEndpointIdentityGeneration: hub.identity.identityGeneration,
      };
      await tx.hubInstallation.update({ where: { id: installation.id }, data });
      if (!isRefresh && (installation.lanEndpointState !== observation.state || installation.baseUrl !== (observation.baseUrl || installation.baseUrl))) {
        await tx.auditEvent.create({ data: {
          homeId: installation.homeId,
          actorType: 'HUB',
          actorId: installation.id,
          category: 'SECURITY',
          action: 'hub_lan_endpoint_changed',
          targetType: 'HubInstallation',
          targetId: installation.id,
          metadata: {
            revision: observation.revision,
            identityGeneration: hub.identity.identityGeneration,
            state: observation.state,
            receiptAt: now.toISOString(),
            oldEndpointFingerprint: installation.baseUrl ? sha256(installation.baseUrl) : null,
            newEndpointFingerprint: observation.baseUrl ? sha256(observation.baseUrl) : null,
          },
          purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        } });
      }
      return { revision: observation.revision, state: observation.state, reportedAt: now.toISOString() };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if (code === 'P2034' && retry < 2) continue;
        if (code === 'P2034') throw new Stage1AuthError(409, 'lan_endpoint_concurrent_update', 'A concurrent LAN endpoint update won; retry with the latest signed revision');
        throw error;
      }
    }
    if (!accepted) throw new Stage1AuthError(503, 'lan_endpoint_retry_exhausted', 'The signed LAN endpoint update could not be serialized safely');
    }

    let acceptedTls: { revision: number; publicHubId: string; state: string; acknowledgedGeneration: number; reportedAt: string } | undefined;
    if (hub.body.lanTlsIdentity !== undefined) {
      const observation = hub.body.lanTlsIdentity;
      if (!validateLanTlsIdentity(observation, now.getTime())) throw new Stage1AuthError(400, 'lan_tls_identity_invalid', 'The signed customer LAN TLS identity report is invalid');
      const report = observation as {
        version: 1; revision: number; state: 'CURRENT'|'UNAVAILABLE'; publicHubId: string; host: string; port: 8123;
        certificateGeneration: number; currentSpkiPin: string; currentNotBefore: string; currentNotAfter: string;
        nextCertificateGeneration?: number; nextSpkiPin?: string; nextNotBefore?: string; nextNotAfter?: string; acknowledgedGeneration: number;
      };
      let tlsAccepted = false;
      for (let retry = 0; retry < 3 && !tlsAccepted; retry += 1) {
        try {
          acceptedTls = await prisma.$transaction(async (tx) => {
            const installation = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: {
              id: true, homeId: true, serialNumberSnapshot: true, publicHubId: true, lanTlsRevision: true,
              lanTlsIdentityGeneration: true, lanTlsState: true, lanTlsCertificateGeneration: true,
              lanTlsCurrentSpkiPin: true, lanTlsCurrentNotBefore: true, lanTlsCurrentNotAfter: true,
              lanTlsNextCertificateGeneration: true, lanTlsNextSpkiPin: true, lanTlsNextNotBefore: true,
              lanTlsNextNotAfter: true, lanTlsAcknowledgedGeneration: true,
            } });
            const activeIdentity = await tx.hubManufacturingIdentity.findFirst({ where: { serialNumber: hub.identity.serialNumber, identityGeneration: hub.identity.identityGeneration, status: 'ACTIVE' }, select: { id: true } });
            if (!installation || installation.serialNumberSnapshot !== hub.identity.serialNumber || !activeIdentity) throw new Stage1AuthError(401, 'hub_identity_revoked', 'The authenticated hub identity is no longer active');
            if (installation.publicHubId && installation.publicHubId !== report.publicHubId) throw new Stage1AuthError(409, 'lan_tls_public_identity_immutable', 'The enrolled customer LAN identity cannot be replaced by a heartbeat');
            if (report.revision < installation.lanTlsRevision) throw new Stage1AuthError(409, 'lan_tls_revision_stale', 'A newer customer LAN identity report is already recorded');
            if (installation.lanTlsRevision > 0 && installation.lanTlsIdentityGeneration !== hub.identity.identityGeneration) throw new Stage1AuthError(409, 'lan_tls_generation_recovery_required', 'Customer LAN identity recovery is required for this enrolled identity generation');
            const samePayload = installation.publicHubId === report.publicHubId
              && installation.lanTlsState === report.state
              && installation.lanTlsCertificateGeneration === report.certificateGeneration
              && installation.lanTlsCurrentSpkiPin === report.currentSpkiPin
              && installation.lanTlsCurrentNotBefore?.toISOString() === new Date(report.currentNotBefore).toISOString()
              && installation.lanTlsCurrentNotAfter?.toISOString() === new Date(report.currentNotAfter).toISOString()
              && (installation.lanTlsNextCertificateGeneration ?? undefined) === report.nextCertificateGeneration
              && (installation.lanTlsNextSpkiPin ?? undefined) === report.nextSpkiPin
              && installation.lanTlsNextNotBefore?.toISOString() === (report.nextNotBefore ? new Date(report.nextNotBefore).toISOString() : undefined)
              && installation.lanTlsNextNotAfter?.toISOString() === (report.nextNotAfter ? new Date(report.nextNotAfter).toISOString() : undefined);
            if (report.revision === installation.lanTlsRevision && installation.lanTlsRevision > 0 && !samePayload) throw new Stage1AuthError(409, 'lan_tls_revision_conflict', 'This customer LAN identity revision is already bound to different pins');
            if (report.revision === installation.lanTlsRevision && installation.lanTlsRevision === 0) throw new Stage1AuthError(409, 'lan_tls_revision_stale', 'The initial customer LAN identity revision must be positive');
            if (report.certificateGeneration < Number(installation.lanTlsCertificateGeneration || 0)
              || report.nextCertificateGeneration && report.nextCertificateGeneration <= report.certificateGeneration) throw new Stage1AuthError(409, 'lan_tls_certificate_generation_stale', 'The customer LAN certificate generation is not monotonic');
            const acknowledgedGeneration = report.nextCertificateGeneration ?? Number(installation.lanTlsAcknowledgedGeneration || 0);
            await tx.hubInstallation.update({ where: { id: installation.id }, data: {
              publicHubId: report.publicHubId,
              lanTlsRevision: report.revision,
              lanTlsReportedAt: now,
              lanTlsState: report.state,
              lanTlsIdentityGeneration: hub.identity.identityGeneration,
              lanTlsCertificateGeneration: report.certificateGeneration,
              lanTlsCurrentSpkiPin: report.currentSpkiPin,
              lanTlsCurrentNotBefore: new Date(report.currentNotBefore),
              lanTlsCurrentNotAfter: new Date(report.currentNotAfter),
              lanTlsNextCertificateGeneration: report.nextCertificateGeneration ?? null,
              lanTlsNextSpkiPin: report.nextSpkiPin ?? null,
              lanTlsNextNotBefore: report.nextNotBefore ? new Date(report.nextNotBefore) : null,
              lanTlsNextNotAfter: report.nextNotAfter ? new Date(report.nextNotAfter) : null,
              lanTlsAcknowledgedGeneration: acknowledgedGeneration,
            } });
            if (!samePayload) await tx.auditEvent.create({ data: {
              homeId: installation.homeId, actorType: 'HUB', actorId: installation.id, category: 'SECURITY',
              action: 'hub_customer_lan_tls_identity_changed', targetType: 'HubInstallation', targetId: installation.id,
              metadata: { revision: report.revision, publicHubId: report.publicHubId, identityGeneration: hub.identity.identityGeneration, certificateGeneration: report.certificateGeneration, currentPinFingerprint: sha256(report.currentSpkiPin), nextCertificateGeneration: report.nextCertificateGeneration ?? null, nextPinFingerprint: report.nextSpkiPin ? sha256(report.nextSpkiPin) : null, state: report.state, receiptAt: now.toISOString() },
              purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            } });
            return { revision: report.revision, publicHubId: report.publicHubId, state: report.state, acknowledgedGeneration, reportedAt: now.toISOString() };
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          tlsAccepted = true;
        } catch (error) {
          const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
          if (code === 'P2034' && retry < 2) continue;
          if (code === 'P2034') throw new Stage1AuthError(409, 'lan_tls_concurrent_update', 'A concurrent customer LAN identity report won; retry with the latest signed revision');
          throw error;
        }
      }
    }

    return NextResponse.json({ ok: true, online: true, lastSeenAt: now.toISOString(), ...(accepted ? { lanEndpoint: accepted } : {}), ...(acceptedTls ? { lanTlsIdentity: acceptedTls } : {}) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
