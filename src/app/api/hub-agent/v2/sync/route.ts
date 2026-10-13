import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { buildHubCloudConfiguration, finalizeHubCloudConfiguration } from '@/lib/hubCloudConfiguration';
import { applyHubSyncEvent } from '@/lib/hubSyncIngestion';
import { canReconcileHubSyncStream, HUB_SYNC_MAX_BODY_BYTES, hubSyncBodyHash, isInstallationBootstrapEvent, validateHubSyncEnvelope } from '@/lib/hubSyncEnvelope';
import { resolveNativeInstallationSyncMode } from '@/lib/nativeInstallationSyncMode';

export const dynamic = 'force-dynamic';

function isSyncReceiptUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('meta' in error)) return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const description = Array.isArray(target) ? target.map(String).join(',') : typeof target === 'string' ? target : '';
  return description.includes('HubSyncReceipt_one_body_per_range_key')
    || description.includes('HubSyncReceipt_exact_range_body_key')
    || ['streamId', 'fromSequence', 'toSequence'].every((field) => description.includes(field));
}

async function readBoundedBody(request: Request): Promise<string> {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > HUB_SYNC_MAX_BODY_BYTES) throw new Stage1AuthError(413, 'hub_body_too_large', 'The hub request is too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > HUB_SYNC_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Stage1AuthError(413, 'hub_body_too_large', 'The hub request is too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function POST(request: Request) {
  try {
    const raw = await readBoundedBody(request);
    const hub = await authenticateHub(request, raw, { maxBodyBytes: HUB_SYNC_MAX_BODY_BYTES });
    const { serial, identityGeneration, ...syncBody } = hub.body;
    const envelope = syncBody;
    if (serial !== hub.identity.serialNumber || Number(identityGeneration) !== hub.identity.identityGeneration
      || !validateHubSyncEnvelope(envelope, raw) || envelope.hubInstallationId !== hub.installation.id) {
      throw new Stage1AuthError(400, 'hub_sync_envelope_invalid', 'The native sync envelope is invalid');
    }
    // sentAt is durable batch metadata and remains stable across process restart,
    // response loss and retry. Freshness is enforced by authenticateHub's
    // signed request timestamp/nonce, not by expiring this persisted body.
    const bodyHash = hubSyncBodyHash(raw);
    const rawSyncStatus = envelope.runtime.capabilities.nativeSyncOutbox;
    const syncStatus = rawSyncStatus && typeof rawSyncStatus === 'object' && !Array.isArray(rawSyncStatus)
      ? rawSyncStatus as { gapDetected: boolean; criticalBacklog: boolean; telemetryPaused: boolean; droppedTelemetryCount: number }
      : null;
    const syncStatusUpdate = syncStatus ? {
      syncGapDetected: syncStatus.gapDetected,
      syncCriticalBacklog: syncStatus.criticalBacklog,
      syncTelemetryPaused: syncStatus.telemetryPaused,
      syncDroppedTelemetryCount: syncStatus.droppedTelemetryCount,
    } : {};
    const from = BigInt(envelope.fromSequence);
    const to = BigInt(envelope.toSequence);
    const now = new Date();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const current = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: {
            id: true, homeId: true, manufacturingIdentityId: true, serialNumberSnapshot: true, state: true, lifecycleStatus: true,
            cloudUrlVerifiedAt: true, remoteVerificationAt: true,
            syncStreamId: true, syncAcceptedSequence: true, acknowledgedCloudRevision: true, accessPolicyRevision: true,
            cloudConfigurationRevision: true, cloudConfigurationChecksum: true,
            syncGapDetected: true, syncCriticalBacklog: true, syncTelemetryPaused: true, syncDroppedTelemetryCount: true,
          } });
          const home = current ? await tx.home.findUnique({ where: { id: current.homeId }, select: { id: true, lifecycle: true, installationStatus: true, activeHubInstallationId: true, managementRevision: true } }) : null;
          const activeIdentity = await tx.hubManufacturingIdentity.findFirst({ where: { id: hub.identity.id, serialNumber: hub.identity.serialNumber, identityGeneration: hub.identity.identityGeneration, status: 'ACTIVE' }, select: { id: true } });
          const [openAssignedInstallationWorkCount, activeMembershipCount] = current && home ? await Promise.all([
            tx.companyOperationalWorkItem.count({ where: {
              homeId: current.homeId, hubInstallationId: current.id, kind: 'INITIAL_HUB_INSTALLATION',
              state: { in: ['IN_PROGRESS', 'REOPENED'] }, assignedEmployee: { status: 'ACTIVE' },
            } }),
            tx.homeMembership.count({ where: { homeId: current.homeId, status: 'ACTIVE' } }),
          ]) : [0, 0];
          const syncMode = current && home ? resolveNativeInstallationSyncMode({
            hubId: current.id, hubState: current.state, hubLifecycleStatus: current.lifecycleStatus,
            cloudUrlVerifiedAt: current.cloudUrlVerifiedAt, remoteVerificationAt: current.remoteVerificationAt,
            homeId: home.id, homeLifecycle: home.lifecycle, installationStatus: home.installationStatus,
            activeHubInstallationId: home.activeHubInstallationId, openAssignedInstallationWorkCount, activeMembershipCount, now,
          }) : 'UNAVAILABLE';
          if (!current || !home || !activeIdentity || current.manufacturingIdentityId !== hub.identity.id || current.serialNumberSnapshot !== hub.identity.serialNumber
            || syncMode === 'UNAVAILABLE') {
            throw new Stage1AuthError(401, 'hub_sync_authority_changed', 'The enrolled hub no longer has current synchronization authority');
          }
          if (envelope.configurationRefreshOnly === true) {
            if (syncMode !== 'ACTIVE') throw new Stage1AuthError(409, 'hub_sync_configuration_refresh_unavailable', 'Configuration refresh is available only to an active Home installation');
            if (envelope.events.length !== 0) throw new Stage1AuthError(400, 'hub_sync_configuration_refresh_invalid', 'A configuration refresh cannot contain event data');
            const candidate = await buildHubCloudConfiguration(tx, { homeId: current.homeId, hubInstallationId: current.id });
            const sameRevisionConfiguration = finalizeHubCloudConfiguration(candidate, current.cloudConfigurationRevision);
            const cloudConfigurationRevision = sameRevisionConfiguration.checksum === current.cloudConfigurationChecksum
              ? current.cloudConfigurationRevision : current.cloudConfigurationRevision + 1;
            const configuration = finalizeHubCloudConfiguration(candidate, cloudConfigurationRevision);
            if (cloudConfigurationRevision !== current.cloudConfigurationRevision
              || configuration.checksum !== current.cloudConfigurationChecksum) {
              const updated = await tx.hubInstallation.updateMany({
                where: { id: current.id, homeId: current.homeId, syncStreamId: current.syncStreamId,
                  syncAcceptedSequence: current.syncAcceptedSequence, cloudConfigurationRevision: current.cloudConfigurationRevision,
                  cloudConfigurationChecksum: current.cloudConfigurationChecksum },
                data: { cloudConfigurationRevision, cloudConfigurationChecksum: configuration.checksum },
              });
              if (updated.count !== 1) throw new Stage1AuthError(409, 'hub_sync_configuration_race', 'Cloud policy changed during configuration refresh; request the current configuration again');
            }
            // This authenticated read/refresh applies no events and does not
            // advance the stream, event cursor, acknowledged cloud revision,
            // or receipt ledger. The hub must separately apply this snapshot
            // and acknowledge its revision with an ordinary empty/inventory
            // sync before any queued event can be accepted.
            return {
              configurationRefreshOnly: true,
              streamId: envelope.streamId,
              syncStreamId: current.syncStreamId,
              syncAcceptedSequence: Number(current.syncAcceptedSequence),
              cloudRevision: configuration.revision,
              configurationAppliedRevision: Number(envelope.acknowledgedCloudRevision),
              configuration,
              resnapshotRequired: Boolean(syncStatus?.gapDetected || syncStatus?.criticalBacklog),
              nextPollAfterSeconds: 30,
            };
          }
          if (syncMode === 'INSTALLATION_BOOTSTRAP' && (envelope.events.length === 0 || envelope.events.some((event) => !isInstallationBootstrapEvent(event)))) {
            throw new Stage1AuthError(409, envelope.events.length === 0 ? 'hub_sync_installation_area_required' : 'hub_sync_installation_area_only', 'An ownerless or in-progress installation may synchronize only bounded installer events');
          }

          const priorRange = await tx.hubSyncReceipt.findFirst({ where: { hubInstallationId: current.id, streamId: envelope.streamId, fromSequence: from, toSequence: to } });
          if (priorRange) {
            if (priorRange.bodyHash !== bodyHash) {
              return { __hubSyncConflict: true, homeId: current.homeId, hubInstallationId: current.id } as Record<string, unknown>;
            }
            // The event receipt is immutable, but its original response may
            // contain an older policy snapshot. A hub can lose that response,
            // then retry the same durable batch after cloud policy changes.
            // Reconcile no event effects on an exact retry, while returning
            // the latest authoritative configuration so a revoked grant or
            // changed descriptor is never replayed as stale policy.
            const candidate = await buildHubCloudConfiguration(tx, { homeId: current.homeId, hubInstallationId: current.id });
            const sameRevisionConfiguration = finalizeHubCloudConfiguration(candidate, current.cloudConfigurationRevision);
            const cloudConfigurationRevision = sameRevisionConfiguration.checksum === current.cloudConfigurationChecksum
              ? current.cloudConfigurationRevision : current.cloudConfigurationRevision + 1;
            const configuration = finalizeHubCloudConfiguration(candidate, cloudConfigurationRevision);
            if (cloudConfigurationRevision !== current.cloudConfigurationRevision
              || configuration.checksum !== current.cloudConfigurationChecksum) {
              const updated = await tx.hubInstallation.updateMany({
                where: { id: current.id, homeId: current.homeId, syncStreamId: current.syncStreamId, syncAcceptedSequence: current.syncAcceptedSequence,
                  cloudConfigurationRevision: current.cloudConfigurationRevision, cloudConfigurationChecksum: current.cloudConfigurationChecksum },
                data: { cloudConfigurationRevision, cloudConfigurationChecksum: configuration.checksum },
              });
              if (updated.count !== 1) throw new Stage1AuthError(409, 'hub_sync_configuration_race', 'Cloud policy changed during sync retry; retry the same durable batch');
            }
            const recorded = priorRange.response as Record<string, unknown>;
            return {
              ...recorded,
              cloudRevision: configuration.revision,
              configurationAppliedRevision: Number(envelope.acknowledgedCloudRevision),
              configuration,
              duplicate: true,
            };
          }

          const streamReconciled = Boolean(current.syncStreamId && current.syncStreamId !== envelope.streamId
            && canReconcileHubSyncStream(envelope, {
              installationSyncMode: syncMode,
              syncStreamId: current.syncStreamId,
              syncAcceptedSequence: Number(current.syncAcceptedSequence),
              syncGapDetected: current.syncGapDetected,
              syncCriticalBacklog: current.syncCriticalBacklog,
              syncTelemetryPaused: current.syncTelemetryPaused,
              syncDroppedTelemetryCount: current.syncDroppedTelemetryCount,
            }));
          if (current.syncStreamId && current.syncStreamId !== envelope.streamId && !streamReconciled) {
            throw new Stage1AuthError(409, 'hub_sync_stream_reconciliation_required', 'The durable local stream cannot be reconciled against the current signed server cursor');
          }
          if (envelope.streamReconciliation && current.syncStreamId === envelope.streamId
            && Number(current.syncAcceptedSequence) < envelope.toSequence) {
            throw new Stage1AuthError(409, 'hub_sync_stream_reconciliation_required', 'The server stream transition is not confirmed by its accepted cursor');
          }
          const cursor = streamReconciled ? 0 : Number(current.syncAcceptedSequence);
          if (Number(envelope.acknowledgedCloudRevision) < current.acknowledgedCloudRevision
            || Number(envelope.acknowledgedCloudRevision) > current.cloudConfigurationRevision) {
            throw new Stage1AuthError(409, 'hub_sync_configuration_ack_invalid', 'The hub configuration acknowledgement is stale or ahead of the current revision');
          }
          if (current.syncStreamId && current.syncStreamId !== envelope.streamId && !streamReconciled) throw new Stage1AuthError(409, 'hub_sync_stream_conflict', 'A new sync stream requires explicit full reconciliation');
          if (!current.syncStreamId && envelope.fromSequence !== 1) throw new Stage1AuthError(409, 'hub_sync_initial_cursor_invalid', 'The first sync batch must begin at sequence one');
          if (envelope.events.length === 0) {
            if (envelope.toSequence !== cursor || envelope.fromSequence !== cursor + 1) throw new Stage1AuthError(409, 'hub_sync_empty_range_invalid', 'An empty sync request must match the current cursor');
          } else if (envelope.toSequence <= cursor) {
            // Receipts are intentionally short-lived; the durable cursor is
            // enough to prevent old accepted effects from being replayed.
            const candidate = await buildHubCloudConfiguration(tx, { homeId: current.homeId, hubInstallationId: current.id });
            const configuration = finalizeHubCloudConfiguration(candidate, current.cloudConfigurationRevision);
            return { acceptedThroughSequence: cursor, streamId: envelope.streamId, cloudRevision: configuration.revision, configurationAppliedRevision: Number(envelope.acknowledgedCloudRevision), configuration, duplicate: true, resnapshotRequired: Boolean(syncStatus?.gapDetected || syncStatus?.criticalBacklog), nextPollAfterSeconds: 30 };
          } else if (envelope.fromSequence !== cursor + 1) {
            throw new Stage1AuthError(409, 'hub_sync_sequence_gap', 'The next sync batch does not continue the accepted cursor');
          }

          if (envelope.events.length) {
            for (const event of envelope.events) await applyHubSyncEvent(tx, {
              event, homeId: current.homeId, hubInstallationId: current.id,
              identityGeneration: hub.identity.identityGeneration, now,
            });
          }
          const configCandidate = await buildHubCloudConfiguration(tx, { homeId: current.homeId, hubInstallationId: current.id });
          const currentConfig = finalizeHubCloudConfiguration(configCandidate, current.cloudConfigurationRevision);
          const cloudConfigurationRevision = currentConfig.checksum === current.cloudConfigurationChecksum
            ? current.cloudConfigurationRevision : current.cloudConfigurationRevision + 1;
          const configuration = finalizeHubCloudConfiguration(configCandidate, cloudConfigurationRevision);
          const acceptedThroughSequence = envelope.events.length ? envelope.toSequence : cursor;
          const response = {
            acceptedThroughSequence,
            streamId: envelope.streamId,
            ...(streamReconciled ? {
              streamReconciled: true,
              reconciledFromStreamId: current.syncStreamId,
              reconciledFromSequence: Number(current.syncAcceptedSequence),
            } : {}),
            cloudRevision: configuration.revision,
            configurationAppliedRevision: Number(envelope.acknowledgedCloudRevision),
            configuration,
            // Never clear an OS-reported telemetry/retention gap just because
            // the current contiguous batch was accepted. The hub and portal
            // retain the explicit recovery-required state until reconciliation.
            resnapshotRequired: Boolean(syncStatus?.gapDetected || syncStatus?.criticalBacklog),
            nextPollAfterSeconds: 30,
          };

          if (envelope.events.length) {
            if (streamReconciled) {
              await tx.auditEvent.create({ data: {
                homeId: current.homeId, actorType: 'HUB', actorId: current.id,
                category: 'SECURITY', action: 'hub_sync_stream_reconciled', targetType: 'HubInstallation', targetId: current.id,
                metadata: {
                  version: 1,
                  fromStreamId: current.syncStreamId,
                  fromAcceptedSequence: Number(current.syncAcceptedSequence),
                  toStreamId: envelope.streamId,
                  fromSequence: envelope.fromSequence,
                  toSequence: envelope.toSequence,
                  eventCount: envelope.events.length,
                  bodyHash,
                },
                purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
              } });
            }
            const advanced = await tx.hubInstallation.updateMany({ where: { id: current.id, homeId: current.homeId, state: current.state, lifecycleStatus: current.lifecycleStatus, syncStreamId: current.syncStreamId, syncAcceptedSequence: current.syncAcceptedSequence }, data: {
              syncStreamId: envelope.streamId,
              syncAcceptedSequence: to,
              acknowledgedCloudRevision: Number(envelope.acknowledgedCloudRevision),
              cloudConfigurationRevision,
              cloudConfigurationChecksum: configuration.checksum,
              lastSuccessfulSyncAt: now,
              lastQueueDepth: envelope.queueDepth,
              lastSyncErrorCode: null,
              ...syncStatusUpdate,
              runtimeVersion: String(envelope.runtime.version).slice(0, 120),
              capabilitySummary: envelope.runtime.capabilities as Prisma.InputJsonValue,
            } });
            if (advanced.count !== 1) throw new Stage1AuthError(409, 'hub_sync_cursor_race', 'A concurrent sync batch advanced the hub cursor');
            await tx.hubSyncReceipt.create({ data: { hubInstallationId: current.id, streamId: envelope.streamId, fromSequence: from, toSequence: to, bodyHash, response, acceptedAt: now, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) } });
          } else {
            await tx.hubInstallation.update({ where: { id: current.id }, data: {
              acknowledgedCloudRevision: Number(envelope.acknowledgedCloudRevision), lastSuccessfulSyncAt: now,
              cloudConfigurationRevision, cloudConfigurationChecksum: configuration.checksum,
              lastQueueDepth: envelope.queueDepth, lastSyncErrorCode: null,
              ...syncStatusUpdate,
              runtimeVersion: String(envelope.runtime.version).slice(0, 120), capabilitySummary: envelope.runtime.capabilities as Prisma.InputJsonValue,
            } });
          }
          return response;
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          // Sync applies a bounded (<=200 event) durable batch plus its
          // configuration projection and receipt in one transaction. Keep
          // this atomic route independent of Prisma's five-second default,
          // while bounding both pool acquisition and transaction lifetime
          // below the platform function's request deadline.
          maxWait: 10_000,
          timeout: 60_000,
        });
        if ('__hubSyncConflict' in result) {
          const conflictHomeId = String(result.homeId);
          const conflictHubInstallationId = String(result.hubInstallationId);
          await prisma.auditEvent.create({ data: {
            homeId: conflictHomeId, actorType: 'HUB', actorId: conflictHubInstallationId,
            category: 'SECURITY', action: 'hub_sync_range_conflict', targetType: 'HubInstallation', targetId: conflictHubInstallationId,
            metadata: { streamId: envelope.streamId, fromSequence: envelope.fromSequence, toSequence: envelope.toSequence, receivedBodyHash: bodyHash },
            purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
          } });
          throw new Stage1AuthError(409, 'hub_sync_range_conflict', 'This sync range was already accepted with different contents');
        }
        return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
        const receiptConflict = code === 'P2002' && isSyncReceiptUniqueConflict(error);
        if ((code === 'P2034' || receiptConflict) && attempt < 2) continue;
        if (receiptConflict) throw new Stage1AuthError(409, 'hub_sync_receipt_race', 'A concurrent sync receipt could not be reconciled; retry the same durable batch');
        if (code === 'P2002') throw new Stage1AuthError(409, 'hub_sync_event_conflict', 'A synchronized event conflicts with current cloud state; no events were accepted');
        throw error;
      }
    }
    throw new Stage1AuthError(409, 'hub_sync_cursor_race', 'Concurrent sync requests could not be reconciled; retry the same durable batch');
  } catch (error) { return authErrorResponse(error); }
}
