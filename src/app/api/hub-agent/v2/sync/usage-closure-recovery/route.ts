import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { resolveNativeInstallationSyncMode } from '@/lib/nativeInstallationSyncMode';
import { HUB_SYNC_MAX_BODY_BYTES, validateHubSyncEnvelope } from '@/lib/hubSyncEnvelope';
import type { HubSyncEnvelope } from '@/lib/hubSyncEnvelope';
import {
  canonicalDigest, eligibleOpenFullHourEvent, eventDigests, HUB_USAGE_CLOSURE_AUTH_ACTION,
  HUB_USAGE_CLOSURE_REJECTION_ACTION, recoveryNormalizedFingerprint, signedEnvelopeFingerprint,
} from '@/lib/hubUsageClosureRecovery';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > HUB_SYNC_MAX_BODY_BYTES) throw new Stage1AuthError(413, 'hub_body_too_large', 'The hub recovery request is too large');
    const hub = await authenticateHub(request, raw, { maxBodyBytes: HUB_SYNC_MAX_BODY_BYTES });
    const body = hub.body as Record<string, unknown>;
    const rejectedBodyHash = String(body.rejectedBodyHash || '').toLowerCase();
    const targetEventId = String(body.targetEventId || '');
    const targetSequence = Number(body.targetSequence);
    const targetPayloadHash = String(body.targetPayloadHash || '').toLowerCase();
    const rejectedEnvelope = body.rejectedEnvelope as HubSyncEnvelope;
    if (body.serial !== hub.identity.serialNumber || Number(body.identityGeneration) !== hub.identity.identityGeneration
      || !/^[a-f0-9]{64}$/.test(rejectedBodyHash) || !/^[0-9a-f-]{36}$/i.test(targetEventId)
      || !Number.isSafeInteger(targetSequence) || !/^[a-f0-9]{64}$/.test(targetPayloadHash) || !validateHubSyncEnvelope(rejectedEnvelope)
      || rejectedEnvelope.hubInstallationId !== hub.installation.id || Object.hasOwn(rejectedEnvelope, 'usageClosureRecovery')) {
      throw new Stage1AuthError(400, 'hub_sync_usage_recovery_request_invalid', 'The rejected sync request cannot be used for usage recovery');
    }
    const now = new Date();
    const target = eligibleOpenFullHourEvent(rejectedEnvelope, now, targetEventId);
    if (!target) throw new Stage1AuthError(409, 'hub_sync_usage_recovery_not_eligible', 'The rejected batch does not contain exactly one eligible full-hour closure event');
    if (target.sequence !== targetSequence || canonicalDigest(target.payload) !== targetPayloadHash) {
      throw new Stage1AuthError(409, 'hub_sync_usage_recovery_request_invalid', 'The selected rejected event does not match its exact local rejection evidence');
    }
    const targetPayload = target.payload;
    const closedAt = new Date(Date.parse(String(targetPayload.bucketStart)) + 3_600_000);
    const correctedEnvelope = structuredClone(rejectedEnvelope);
    const correctedTarget = correctedEnvelope.events.find((event) => event.id === target.id);
    if (!correctedTarget || correctedTarget.type !== 'usage.bucket') throw new Stage1AuthError(409, 'hub_sync_usage_recovery_not_eligible', 'The target event changed during recovery validation');
    correctedTarget.payload.closedAt = closedAt.toISOString();
    if (!validateHubSyncEnvelope(correctedEnvelope)) throw new Stage1AuthError(409, 'hub_sync_usage_recovery_not_eligible', 'Adding only the encoded hour closure does not produce a valid sync envelope');

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: {
        id: true, homeId: true, manufacturingIdentityId: true, serialNumberSnapshot: true, state: true, lifecycleStatus: true,
        cloudUrlVerifiedAt: true, remoteVerificationAt: true, syncStreamId: true, syncAcceptedSequence: true,
        acknowledgedCloudRevision: true, cloudConfigurationRevision: true,
      } });
      const home = current ? await tx.home.findUnique({ where: { id: current.homeId }, select: {
        id: true, lifecycle: true, installationStatus: true, activeHubInstallationId: true,
      } }) : null;
      const activeIdentity = await tx.hubManufacturingIdentity.findFirst({ where: {
        id: hub.identity.id, serialNumber: hub.identity.serialNumber,
        identityGeneration: hub.identity.identityGeneration, status: 'ACTIVE',
      }, select: { id: true } });
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
      if (!current || !home || !activeIdentity || current.manufacturingIdentityId !== hub.identity.id
        || current.serialNumberSnapshot !== hub.identity.serialNumber || syncMode !== 'ACTIVE') {
        throw new Stage1AuthError(401, 'hub_sync_authority_changed', 'Current active Home sync authority is required');
      }
      if (current.syncStreamId !== rejectedEnvelope.streamId
        || Number(current.syncAcceptedSequence) !== rejectedEnvelope.fromSequence - 1
        || rejectedEnvelope.toSequence < rejectedEnvelope.fromSequence
        || Number(rejectedEnvelope.acknowledgedCloudRevision) < Number(current.acknowledgedCloudRevision)
        || Number(rejectedEnvelope.acknowledgedCloudRevision) > Number(current.cloudConfigurationRevision)) {
        throw new Stage1AuthError(409, 'hub_sync_usage_recovery_cursor_changed', 'The rejected range or configuration acknowledgement no longer matches the authoritative Hub cursor');
      }
      const priorReceipt = await tx.hubSyncReceipt.findFirst({ where: {
        hubInstallationId: current.id, streamId: rejectedEnvelope.streamId,
        fromSequence: BigInt(rejectedEnvelope.fromSequence), toSequence: BigInt(rejectedEnvelope.toSequence),
      }, select: { id: true, bodyHash: true } });
      if (priorReceipt) throw new Stage1AuthError(409, 'hub_sync_usage_recovery_receipt_exists', 'A receipt already exists for this range; preserve and reconcile the exact accepted request');

      const priorRejection = await tx.auditEvent.findFirst({ where: {
        homeId: current.homeId, actorType: 'HUB', actorId: current.id, category: 'SECURITY',
        action: HUB_USAGE_CLOSURE_REJECTION_ACTION, targetType: 'HubInstallation', targetId: current.id,
        metadata: { path: ['bodyHash'], equals: rejectedBodyHash },
      }, orderBy: { occurredAt: 'desc' }, select: { id: true, metadata: true } });
      const rejection = priorRejection?.metadata && typeof priorRejection.metadata === 'object' && !Array.isArray(priorRejection.metadata)
        ? priorRejection.metadata as Record<string, unknown> : null;
      const originalFingerprint = signedEnvelopeFingerprint({ serial: hub.identity.serialNumber, identityGeneration: hub.identity.identityGeneration, envelope: rejectedEnvelope });
      if (!priorRejection || !rejection || rejection.version !== 1 || rejection.status !== 409
        || rejection.code !== 'hub_sync_usage_bucket_closure_invalid' || rejection.streamId !== rejectedEnvelope.streamId
        || Number(rejection.fromSequence) !== rejectedEnvelope.fromSequence || Number(rejection.toSequence) !== rejectedEnvelope.toSequence
        || rejection.hubInstallationId !== current.id || Number(rejection.identityGeneration) !== hub.identity.identityGeneration
        || rejection.envelopeFingerprint !== originalFingerprint
        || rejection.normalizedFingerprint !== recoveryNormalizedFingerprint({ serial: hub.identity.serialNumber, identityGeneration: hub.identity.identityGeneration, envelope: rejectedEnvelope }, target.id)
        || !Array.isArray(rejection.eventDigests) || canonicalDigest(eventDigests(rejectedEnvelope)) !== canonicalDigest(rejection.eventDigests)
        || !rejection.target || typeof rejection.target !== 'object'
        || (rejection.target as Record<string, unknown>).eventId !== target.id
        || Number((rejection.target as Record<string, unknown>).sequence) !== target.sequence
        || (rejection.target as Record<string, unknown>).payloadHash !== canonicalDigest(target.payload)
        || targetEventId !== (rejection.target as Record<string, unknown>).eventId
        || targetSequence !== Number((rejection.target as Record<string, unknown>).sequence)
        || targetPayloadHash !== String((rejection.target as Record<string, unknown>).payloadHash)) {
        throw new Stage1AuthError(409, 'hub_sync_usage_recovery_rejection_unproven', 'The exact rejected request is not backed by a matching signed Platform rejection record');
      }

      const device = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: {
        hubInstallationId: current.id, osDeviceId: String(targetPayload.osDeviceId),
      } }, select: { id: true, homeId: true, managementClass: true, analyticsCategory: true, lifecycle: true, descriptorRevision: true, capabilitySummary: true } });
      const category = String(targetPayload.analyticsCategory);
      if (!device || device.homeId !== current.homeId || device.managementClass !== 'PROPERTY_DEVICE'
        || device.analyticsCategory !== category || !['LIGHT', 'BOILER', 'RADIATOR'].includes(category)
        || ['RETIRED', 'REMOVED', 'REMOVAL_PENDING'].includes(device.lifecycle)
        || Number(targetPayload.sourceGeneration) !== hub.identity.identityGeneration) {
        throw new Stage1AuthError(409, 'hub_sync_usage_recovery_policy_changed', 'Current permanent-device analytics authority no longer permits this bucket');
      }
      const summary = device.capabilitySummary && typeof device.capabilitySummary === 'object' && !Array.isArray(device.capabilitySummary)
        ? device.capabilitySummary as Record<string, unknown> : {};
      const catalog = summary.controlCatalog && typeof summary.controlCatalog === 'object' && !Array.isArray(summary.controlCatalog)
        ? summary.controlCatalog as Record<string, unknown> : {};
      const controls = Array.isArray(catalog.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
      const roles = category === 'LIGHT' ? ['power', 'brightness'] : category === 'RADIATOR' ? ['active_heat_demand'] : ['active_heat_production'];
      if (Number(catalog.revision) !== Number(device.descriptorRevision)
        || !controls.some((control) => control.controlId === targetPayload.controlId
          && roles.includes(String(control.semanticRole)) && control.observable === true)) {
        throw new Stage1AuthError(409, 'hub_sync_usage_recovery_policy_changed', 'The current descriptor does not authorize this Radiator observation');
      }
      const area = await tx.area.findUnique({ where: { homeId_osAreaId: {
        homeId: current.homeId, osAreaId: String(targetPayload.osAreaId),
      } }, select: { id: true, status: true } });
      const start = new Date(String(targetPayload.coverageStartAt));
      const end = new Date(String(targetPayload.coverageEndAt));
      const assignment = area?.status === 'ACTIVE' ? await tx.deviceAreaAssignment.findFirst({ where: {
        homeId: current.homeId, deviceId: device.id, areaId: area.id, validFrom: { lte: start },
        OR: [{ validUntil: null }, { validUntil: { gte: end } }],
      }, select: { id: true } }) : null;
      if (!area || area.status !== 'ACTIVE' || !assignment) {
        throw new Stage1AuthError(409, 'hub_sync_usage_recovery_policy_changed', 'The device was not assigned to the current active Area for the complete usage interval');
      }
      const bucket = await tx.nativeDeviceUsageBucket.findUnique({ where: {
        deviceId_areaId_analyticsCategory_controlId_bucketStart_sourceGeneration: {
          deviceId: device.id, areaId: area.id, analyticsCategory: category as 'LIGHT' | 'BOILER' | 'RADIATOR', controlId: String(targetPayload.controlId),
          bucketStart: new Date(String(targetPayload.bucketStart)), sourceGeneration: Number(targetPayload.sourceGeneration), bindingRevision: Number(targetPayload.bindingRevision || 0),
        },
      }, select: { revision: true, onSeconds: true, offSeconds: true, unknownSeconds: true, closedAt: true } });
      if (bucket && (bucket.closedAt || bucket.revision >= Number(targetPayload.revision)
        || bucket.onSeconds > Number(targetPayload.onSeconds) || bucket.offSeconds > Number(targetPayload.offSeconds)
        || bucket.unknownSeconds > Number(targetPayload.unknownSeconds))) {
        throw new Stage1AuthError(409, 'hub_sync_usage_recovery_state_changed', 'The cloud already contains this or a newer usage revision; no local event rewrite is authorized');
      }

      const existingGrant = await tx.auditEvent.findFirst({ where: {
        homeId: current.homeId, actorType: 'HUB', actorId: current.id, category: 'SECURITY',
        action: HUB_USAGE_CLOSURE_AUTH_ACTION, targetType: 'HubInstallation', targetId: current.id,
        metadata: { path: ['bodyHash'], equals: rejectedBodyHash },
      }, orderBy: { occurredAt: 'desc' }, select: { id: true, metadata: true } });
      const existingMetadata = existingGrant?.metadata && typeof existingGrant.metadata === 'object' && !Array.isArray(existingGrant.metadata)
        ? existingGrant.metadata as Record<string, unknown> : null;
      if (existingGrant && existingMetadata?.consumedAt == null && Date.parse(String(existingMetadata?.expiresAt || '')) > now.getTime()
        && existingMetadata?.targetEventId === target.id) {
        return { authorizationId: existingGrant.id, rejectedBodyHash, targetEventId: target.id, targetSequence: target.sequence,
          closedAt: closedAt.toISOString(), expiresAt: existingMetadata.expiresAt };
      }
      const expiresAt = new Date(now.getTime() + 10 * 60_000);
      const grant = await tx.auditEvent.create({ data: {
        homeId: current.homeId, actorType: 'HUB', actorId: current.id, category: 'SECURITY',
        action: HUB_USAGE_CLOSURE_AUTH_ACTION, targetType: 'HubInstallation', targetId: current.id,
        metadata: {
          version: 1, bodyHash: rejectedBodyHash, envelopeFingerprint: originalFingerprint,
          normalizedFingerprint: recoveryNormalizedFingerprint({ serial: hub.identity.serialNumber, identityGeneration: hub.identity.identityGeneration, envelope: rejectedEnvelope }, target.id),
          streamId: rejectedEnvelope.streamId, fromSequence: rejectedEnvelope.fromSequence, toSequence: rejectedEnvelope.toSequence,
          hubInstallationId: current.id, identityGeneration: hub.identity.identityGeneration,
          target: { eventId: target.id, sequence: target.sequence, payloadHash: canonicalDigest(target.payload), correctedPayloadHash: canonicalDigest(correctedTarget.payload) },
          eventDigests: eventDigests(rejectedEnvelope), changedFields: ['closedAt'], closedAt: closedAt.toISOString(),
          previousBucketRevision: bucket?.revision ?? null, incomingBucketRevision: Number(targetPayload.revision),
          expiresAt: expiresAt.toISOString(), consumedAt: null,
        },
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      }, select: { id: true } });
      return { authorizationId: grant.id, rejectedBodyHash, targetEventId: target.id, targetSequence: target.sequence,
        closedAt: closedAt.toISOString(), expiresAt: expiresAt.toISOString() };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 8_000, timeout: 15_000 });

    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
