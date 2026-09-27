import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { validateLanEndpointObservation } from '@/lib/lanEndpoint';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const runtime = hub.body.hubRuntime && typeof hub.body.hubRuntime === 'object' ? hub.body.hubRuntime as Record<string, unknown> : {};
    const now = new Date();

    // Liveness is a separate signal: a malformed or stale endpoint report can
    // never become a browser route, but it does not erase a valid signed pulse.
    await prisma.hubInstallation.update({ where: { id: hub.installation.id }, data: {
      lastSeenAt: now,
      onlineStateEvaluatedAt: now,
      runtimeVersion: String(runtime.version ?? '').slice(0, 120) || undefined,
      capabilitySummary: runtime.capabilities && typeof runtime.capabilities === 'object' ? runtime.capabilities : undefined,
    } });

    if (hub.body.lanEndpoint === undefined) {
      return NextResponse.json({ ok: true, online: true, lastSeenAt: now.toISOString() }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    }

    const observation = validateLanEndpointObservation(hub.body.lanEndpoint, hub.identity.serialNumber, 8123);
    const before = await prisma.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: { id: true, homeId: true, baseUrl: true, lanEndpointRevision: true, lanEndpointState: true, lanEndpointIdentityGeneration: true } });
    if (!before) throw new Stage1AuthError(409, 'hub_installation_unavailable', 'The authenticated installation is no longer available');
    if (observation.revision > before.lanEndpointRevision) {
      await enforcePersistentRateLimit(`hub-lan-endpoint:${before.id}`, 20, 60 * 60 * 1000);
    }

    let accepted: { revision: number; state: string; reportedAt: string } | undefined;
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

    return NextResponse.json({ ok: true, online: true, lastSeenAt: now.toISOString(), lanEndpoint: accepted }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
