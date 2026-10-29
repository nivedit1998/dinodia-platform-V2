import type { Prisma } from '@prisma/client';
import { currentNativeDisplayName } from './nativeDisplayNames';
import { nativeDisplayGroups } from './nativeDisplayGroups';
import { completeFloorplan } from './homeFloorplan';
import { currentCloudflareTunnelStatus } from './hubSyncTelemetry';

const HEARTBEAT_ONLINE_SECONDS = 420;
export class HomeownerProjectionError extends Error {
  constructor(readonly code: 'MEMBERSHIP_FORBIDDEN' | 'HOME_UNAVAILABLE') { super(code); }
}

/** Build a bounded, selected-home owner/manager projection. Tenant-owned devices
 * are excluded in the database predicate, before any response is serialized. */
export async function readHomeownerProjection(db: Prisma.TransactionClient, input: {
  accountId: string; membershipId: string; homeId: string; now?: Date;
}) {
  const now = input.now ?? new Date();
  const membership = await db.homeMembership.findFirst({
    where: {
      id: input.membershipId, customerAccountId: input.accountId, homeId: input.homeId,
      status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, customerAccount: { status: 'ACTIVE' },
    },
    select: {
      id: true, role: true, accessRevision: true,
      customerAccount: { select: { id: true, displayName: true, username: true, email: true, emailVerifiedAt: true, phoneNumber: true } },
      home: {
        select: {
          id: true, addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true,
          lifecycle: true, installationStatus: true, installationCompletedAt: true, installationReopenedAt: true,
          managementRevision: true, activeHubInstallationId: true,
          areas: { where: { status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 64,
            select: { id: true, originalName: true, overrideName: true, revision: true, createdAt: true } },
        },
      },
    },
  });
  if (!membership) throw new HomeownerProjectionError('MEMBERSHIP_FORBIDDEN');
  const home = membership.home;
  if (home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE' || !home.activeHubInstallationId) {
    throw new HomeownerProjectionError('HOME_UNAVAILABLE');
  }
  const [hub, floorplanRow, deviceRows, members, tenantCount, pendingRoomRequestRows, pendingRoomRequestCount, requests, pendingTransfers] = await Promise.all([
    db.hubInstallation.findFirst({
      where: { id: home.activeHubInstallationId, homeId: home.id, lifecycleStatus: 'ACTIVE' },
      select: { id: true, state: true, lastSeenAt: true, onlineStateEvaluatedAt: true, cleanupState: true, cleanupGeneration: true, runtimeVersion: true, updatePhase: true, updateStatusAt: true, capabilitySummary: true, manufacturingIdentity: { select: { identityGeneration: true, status: true } } },
    }),
    db.homeDocument.findUnique({ where: { homeId_kind: { homeId: home.id, kind: 'FLOORPLAN' } }, select: { revision: true, document: true } }),
    db.nativeDevice.findMany({
      where: {
        homeId: home.id, hubInstallationId: home.activeHubInstallationId,
        managementClass: 'PROPERTY_DEVICE', lifecycle: { notIn: ['RETIRED', 'REMOVED'] },
        assignments: { some: { validUntil: null, area: { status: 'ACTIVE' } } },
      },
      select: {
        id: true, originalName: true, overrideName: true, deviceType: true, manufacturer: true, model: true, protocol: true,
        onlineState: true, lastSeenAt: true, lifecycle: true, installedAt: true, inventoryRevision: true,
        radiatorTemperature: true, radiatorReadingAt: true,
        temperatureSamples: { where: { sourceObservedAt: { lte: now }, purgeAt: { gt: now } },
          orderBy: { sourceObservedAt: 'desc' }, take: 1,
          select: { temperature: true, sourceObservedAt: true, validUntil: true, currentnessEndedAt: true, analyticsPolicyVersion: true } },
        assignments: { where: { validUntil: null, area: { status: 'ACTIVE' } }, orderBy: { areaId: 'asc' }, take: 8, select: { areaId: true } },
      },
      orderBy: [{ originalName: 'asc' }, { id: 'asc' }], take: 500,
    }),
    db.homeMembership.findMany({
      where: { homeId: home.id, status: 'ACTIVE', role: { in: ['TENANT', 'PROPERTY_MANAGER'] }, customerAccount: { status: 'ACTIVE' } },
      select: {
        id: true, role: true, accessRevision: true, activatedAt: true,
        customerAccount: { select: { id: true, displayName: true, username: true, email: true, emailVerifiedAt: true } },
        tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true, policyRevision: true, area: { select: { originalName: true, overrideName: true } } }, orderBy: { areaId: 'asc' } },
      },
      orderBy: [{ role: 'asc' }, { activatedAt: 'asc' }, { id: 'asc' }], take: 250,
    }),
    db.homeMembership.count({ where: { homeId: home.id, status: 'ACTIVE', role: 'TENANT', customerAccount: { status: 'ACTIVE' } } }),
    db.areaAccessRequest.findMany({
      where: { homeId: home.id, status: 'PENDING', expiresAt: { gt: now }, emailVerifiedAt: { not: null }, area: { status: 'ACTIVE' } },
      select: { id: true, areaId: true, expiresAt: true, createdAt: true, updatedAt: true, area: { select: { originalName: true, overrideName: true } },
        requester: { select: { id: true, displayName: true, username: true, email: true, emailVerifiedAt: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
    }),
    db.areaAccessRequest.count({ where: { homeId: home.id, status: 'PENDING', expiresAt: { gt: now }, emailVerifiedAt: { not: null }, area: { status: 'ACTIVE' }, requester: { is: { emailVerifiedAt: { not: null }, status: 'ACTIVE' } } } }),
    db.permanentDeviceInstallationRequest.findMany({
      where: { homeId: home.id, requesterMembershipId: membership.id, cancelledAt: null },
      select: { id: true, customerReference: true, category: true, status: true, revision: true, createdAt: true, workStartedAt: true },
      orderBy: { createdAt: 'desc' }, take: 20,
    }),
    db.homeClaimReference.count({ where: { homeId: home.id, purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE', consumedAt: null, cancelledAt: null } }),
  ]);
  if (!hub) throw new HomeownerProjectionError('HOME_UNAVAILABLE');

  const grouped = nativeDisplayGroups(home.areas);
  const areaIds = new Set(grouped.areas.map((area) => area.id));
  const devices = deviceRows.flatMap((device) => {
    const canonicalAreaIds = device.assignments.map((row) => row.areaId).filter((id) => areaIds.has(id));
    if (canonicalAreaIds.length === 0) return [];
    const latestTemperature = device.temperatureSamples[0];
    const readingAt = latestTemperature?.sourceObservedAt ?? device.radiatorReadingAt;
    const readingAge = readingAt ? now.getTime() - readingAt.getTime() : Number.POSITIVE_INFINITY;
    const readingValue = latestTemperature ? Number(latestTemperature.temperature) : device.radiatorTemperature;
    const effectiveValidUntil = latestTemperature?.currentnessEndedAt && latestTemperature.currentnessEndedAt < latestTemperature.validUntil
      ? latestTemperature.currentnessEndedAt : latestTemperature?.validUntil;
    const readingFresh = latestTemperature?.analyticsPolicyVersion === 3 && Boolean(effectiveValidUntil && effectiveValidUntil > now) && readingAge >= 0;
    return [{
      id: device.id, originalName: device.originalName, overrideName: device.overrideName,
      displayName: currentNativeDisplayName(device.originalName, device.overrideName),
      deviceType: device.deviceType, manufacturer: device.manufacturer, model: device.model, protocol: device.protocol,
      canonicalAreaIds, onlineState: device.onlineState, lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      lifecycle: device.lifecycle, installedAt: device.installedAt?.toISOString() ?? null, revision: device.inventoryRevision,
      readings: readingValue === null ? [] : [{
        kind: 'radiator_temperature', value: Number(readingValue),
        unit: 'celsius', quality: readingFresh ? 'fresh' : 'stale', sourceAt: readingAt?.toISOString() ?? null,
      }],
    }];
  });
  const heartbeatAge = hub.lastSeenAt ? (now.getTime() - hub.lastSeenAt.getTime()) / 1000 : null;
  const heartbeatState = heartbeatAge === null || heartbeatAge < -30 ? 'UNKNOWN'
    : heartbeatAge <= HEARTBEAT_ONLINE_SECONDS ? 'ONLINE' : 'OFFLINE';
  const activeFloorplan = completeFloorplan(grouped.areas.map((area) => area.id), floorplanRow?.document);
  const capabilities = hub.capabilitySummary && typeof hub.capabilitySummary === 'object' && !Array.isArray(hub.capabilitySummary)
    ? hub.capabilitySummary as Record<string, unknown> : {};
  const cloudflareStatus = hub.manufacturingIdentity?.status === 'ACTIVE'
    ? currentCloudflareTunnelStatus(capabilities.cloudflareTunnel, hub.manufacturingIdentity.identityGeneration, now.getTime()) : null;

  return {
    schemaVersion: 'dinodia.v1', ok: true, generatedAt: now.toISOString(), homeId: home.id,
    membership: { id: membership.id, role: membership.role, accessRevision: membership.accessRevision },
    account: {
      id: membership.customerAccount.id, displayName: membership.customerAccount.displayName,
      username: membership.customerAccount.username, email: membership.customerAccount.email,
      emailVerified: membership.customerAccount.emailVerifiedAt !== null, phoneNumber: membership.customerAccount.phoneNumber,
    },
    home: {
      address: { line1: home.addressLine1, line2: home.addressLine2, city: home.city, region: home.region, postcode: home.postcode, country: home.country },
      managementRevision: home.managementRevision, installationStatus: home.installationStatus,
      installationReopenedAt: home.installationReopenedAt?.toISOString() ?? null,
      installationCompletedAt: home.installationCompletedAt?.toISOString() ?? null,
    },
    hub: {
      state: heartbeatState, lastHeartbeatAt: hub.lastSeenAt?.toISOString() ?? null,
      lastOnlineAt: hub.lastSeenAt?.toISOString() ?? null, cleanupState: hub.cleanupState,
      cleanupGeneration: hub.cleanupGeneration, runtimeVersion: hub.runtimeVersion,
      updatePhase: hub.updatePhase, updateStatusAt: hub.updateStatusAt?.toISOString() ?? null,
      remoteAccessState: cloudflareStatus?.recoveryState ?? 'UNKNOWN',
    },
    areas: grouped.areas.map((area) => ({ id: area.id, originalName: area.originalName, overrideName: area.overrideName, displayName: area.displayName, revision: area.revision, displayGroupId: area.displayGroupId })),
    displayGroups: grouped.groups,
    floorplan: { revision: floorplanRow?.revision ?? 0, document: { version: 1, areas: activeFloorplan } },
    devices,
    members: members.map((row) => ({
      membershipId: row.id, role: row.role, accessRevision: row.accessRevision,
      activatedAt: row.activatedAt.toISOString(), account: {
        id: row.customerAccount.id, displayName: row.customerAccount.displayName,
        username: row.customerAccount.username, email: row.customerAccount.email,
        emailVerified: row.customerAccount.emailVerifiedAt !== null,
      },
      areaGrants: row.tenantAreaGrants.map((grant) => ({ areaId: grant.areaId, policyRevision: grant.policyRevision,
        originalName: grant.area.originalName, overrideName: grant.area.overrideName,
        displayName: currentNativeDisplayName(grant.area.originalName, grant.area.overrideName) })),
    })),
    roomAccessRequests: pendingRoomRequestRows.flatMap((row) => row.requester?.emailVerifiedAt ? [{
      requestId: row.id, areaId: row.areaId,
      areaName: currentNativeDisplayName(row.area.originalName, row.area.overrideName),
      expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(), revision: row.updatedAt.toISOString(),
      requester: { id: row.requester.id, displayName: row.requester.displayName, username: row.requester.username, email: row.requester.email },
    }] : []),
    summaries: { activeTenants: tenantCount, pendingRoomRequests: pendingRoomRequestCount, pendingOwnershipTransfers: pendingTransfers },
    installationRequests: requests.map((request) => ({
      id: request.id, customerReference: request.customerReference, category: request.category, status: request.status,
      revision: request.revision, submittedAt: request.createdAt.toISOString(), workStarted: request.workStartedAt !== null,
    })),
  };
}
