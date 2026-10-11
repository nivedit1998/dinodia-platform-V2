import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { validateLanEndpointObservation } from '@/lib/lanEndpoint';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

class LanEndpointRevisionError extends Stage1AuthError {
  readonly currentRevision: number;

  constructor(code: 'lan_endpoint_revision_stale' | 'lan_endpoint_revision_conflict', message: string, currentRevision: number) {
    super(409, code, message);
    this.currentRevision = currentRevision;
  }
}

/**
 * Recovery-only factory-identity path for publishing the current private LAN
 * endpoint when the installation machine credential is unavailable. This is
 * deliberately not a heartbeat: it changes no liveness, sync, credential,
 * configuration, or customer-data state.
 */
export async function POST(request: Request) {
  try {
    if (request.headers.has('x-dinodia-machine-version') || request.headers.has('x-dinodia-machine-signature')) {
      throw new Stage1AuthError(400, 'lan_endpoint_identity_only', 'This recovery route accepts only the enrolled manufacturing identity');
    }
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { allowIdentity: true, maxBodyBytes: 16 * 1024 });
    if (Object.keys(hub.body).some((key) => !['serial', 'identityGeneration', 'lanEndpoint'].includes(key))
      || Object.keys(hub.body).length !== 3) {
      throw new Stage1AuthError(400, 'lan_endpoint_recovery_shape_invalid', 'A recovery report may contain only the current LAN endpoint');
    }
    const observation = validateLanEndpointObservation(hub.body.lanEndpoint, hub.identity.serialNumber, 80);
    await enforcePersistentRateLimit(`hub-lan-endpoint:${hub.installation.id}`, 45, 60 * 60 * 1000);
    const now = new Date();
    let accepted: { revision: number; state: string; reportedAt: string } | undefined;
    for (let retry = 0; retry < 3 && !accepted; retry += 1) {
      try {
        accepted = await prisma.$transaction(async (tx) => {
          const installation = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: {
            id: true, homeId: true, state: true, lifecycleStatus: true, serialNumberSnapshot: true, baseUrl: true,
            lanEndpointRevision: true, lanEndpointState: true, lanEndpointIdentityGeneration: true,
          } });
          const currentIdentity = await tx.hubManufacturingIdentity.findFirst({ where: {
            serialNumber: hub.identity.serialNumber, identityGeneration: hub.identity.identityGeneration, status: 'ACTIVE',
          }, select: { id: true, identityGeneration: true } });
          const home = installation ? await tx.home.findUnique({ where: { id: installation.homeId }, select: { activeHubInstallationId: true } }) : null;
          if (!installation || installation.serialNumberSnapshot !== hub.identity.serialNumber || !currentIdentity
            || installation.lifecycleStatus !== 'ACTIVE' || installation.state !== 'ACTIVE'
            || home?.activeHubInstallationId !== installation.id) {
            throw new Stage1AuthError(409, 'lan_endpoint_installation_not_current', 'The enrolled identity is not the current active Home installation');
          }
          const currentRevision = installation.lanEndpointRevision;
          const knownGeneration = installation.lanEndpointIdentityGeneration;
          if (currentRevision > 0 && knownGeneration !== hub.identity.identityGeneration) {
            throw new Stage1AuthError(409, 'lan_endpoint_generation_reset_required', 'LAN endpoint revision recovery is required for this identity generation');
          }
          if (observation.revision < currentRevision) throw new LanEndpointRevisionError('lan_endpoint_revision_stale', 'A newer LAN endpoint revision is already recorded', currentRevision);
          const samePayload = installation.lanEndpointState === observation.state
            && (observation.state === 'UNAVAILABLE' || installation.baseUrl === observation.baseUrl)
            && (knownGeneration === null || knownGeneration === hub.identity.identityGeneration);
          if (observation.revision === currentRevision && currentRevision > 0 && !samePayload) {
            throw new LanEndpointRevisionError('lan_endpoint_revision_conflict', 'This LAN endpoint revision was already used for different endpoint data', currentRevision);
          }
          if (observation.revision === currentRevision && currentRevision === 0) {
            throw new Stage1AuthError(409, 'lan_endpoint_revision_stale', 'The initial LAN endpoint revision must be positive');
          }
          const changed = installation.lanEndpointState !== observation.state
            || (observation.state === 'CURRENT' && installation.baseUrl !== observation.baseUrl);
          await tx.hubInstallation.update({ where: { id: installation.id }, data: {
            baseUrl: observation.state === 'CURRENT' ? observation.baseUrl : installation.baseUrl,
            lanEndpointRevision: observation.revision,
            lanEndpointReportedAt: now,
            lanEndpointState: observation.state,
            lanEndpointIdentityGeneration: hub.identity.identityGeneration,
          } });
          if (changed) await tx.auditEvent.create({ data: {
            homeId: installation.homeId,
            actorType: 'HUB', actorId: installation.id, category: 'SECURITY', action: 'hub_lan_endpoint_changed',
            targetType: 'HubInstallation', targetId: installation.id,
            metadata: {
              revision: observation.revision, identityGeneration: hub.identity.identityGeneration,
              state: observation.state, receiptAt: now.toISOString(),
              oldEndpointFingerprint: installation.baseUrl ? sha256(installation.baseUrl) : null,
              newEndpointFingerprint: observation.baseUrl ? sha256(observation.baseUrl) : null,
              recoveryOnly: true,
            },
            purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
          } });
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
    return NextResponse.json({ ok: true, lanEndpoint: accepted }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof LanEndpointRevisionError) {
      return NextResponse.json({ ok: false, error: error.message, errorCode: error.code, currentRevision: error.currentRevision }, {
        status: error.status,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      });
    }
    return authErrorResponse(error);
  }
}
