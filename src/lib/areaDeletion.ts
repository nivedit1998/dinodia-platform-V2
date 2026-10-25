import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { retireNativeAutomations } from './nativeAutomations/lifecycle';
import { refreshNativeAutomationCloudRevision } from './nativeAutomations/delivery';
import { deletedTargetReference } from './deletionReferences';
import { purgeAreaPayloads } from './areaDeletionPayloadPurge';

type Tx = Prisma.TransactionClient;
const EVENT = 'AREA_DELETE_V1';
const KEEP_SECURITY_RECEIPT = new Date('9999-12-31T00:00:00.000Z');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type AreaDeleteScope = { homeId: string; hubInstallationId: string; employeeId: string };
type Snapshot = { areaId: string; osAreaId: string; areaRevision: number; managementRevision: number;
  deviceIds: string[]; osDeviceIds: string[]; membershipIds: string[];
  legacyDeviceIds: string[]; legacyOsDeviceIds: string[] };
type DeletePayload = { version: 1; actorId: string; snapshot: Snapshot; digest: string; localFenceDigest?: string };

function denied(code: string, message: string): never { throw new Stage1AuthError(409, code, message); }

/** Caller holds the Home row lock. Reject overlap before the Hub can fence. */
export async function assertLifecycleReservationAvailable(tx: Tx, homeId: string, operationRowId: string,
  deviceIds: string[], areaId: string | null = null) {
  const ids = deviceIds.length ? deviceIds : ['no-device-in-empty-area'];
  const conflicts = await tx.$queryRaw<Array<{ id: string }>>`SELECT o."id" FROM "NativeDomainOutbox" o
    WHERE o."homeId" = ${homeId}::uuid AND o."id" <> ${operationRowId}::uuid
    AND (
      (o."aggregateType" = 'LogicalDeviceConversion' AND o."eventType" = 'LOGICAL_CONVERSION_V1'
        AND o."state" = 'RESERVED' AND o."payload" ->> 'deviceId' = ANY(ARRAY[${Prisma.join(ids)}]::text[]))
      OR (o."aggregateType" = 'AreaDeletion' AND o."eventType" = 'AREA_DELETE_V1'
        AND o."state" IN ('RESERVED','WAITING_HUB') AND (
          o."payload" #>> '{snapshot,areaId}' = ${areaId}
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(o."payload" #> '{snapshot,deviceIds}', '[]'::jsonb)
            || COALESCE(o."payload" #> '{snapshot,legacyDeviceIds}', '[]'::jsonb)) d(value)
            WHERE d.value = ANY(ARRAY[${Prisma.join(ids)}]::text[]))
        ))
    ) LIMIT 1`;
  if (conflicts.length) denied('lifecycle_scope_reserved', 'Finish the existing operation before reserving overlapping device data');
}

async function snapshot(tx: Tx, scope: AreaDeleteScope, areaId: string): Promise<Snapshot> {
  const area = await tx.area.findFirst({ where: { id: areaId, homeId: scope.homeId, status: 'ACTIVE' }, select: { id: true, osAreaId: true, revision: true } });
  const home = await tx.home.findFirst({ where: { id: scope.homeId, activeHubInstallationId: scope.hubInstallationId, lifecycle: 'ACTIVE' }, select: { managementRevision: true } });
  if (!area || !home) denied('area_delete_unavailable', 'The active Area or Hub changed');
  const devices = await tx.nativeDevice.findMany({ where: { homeId: scope.homeId, hubInstallationId: scope.hubInstallationId,
    lifecycle: { in: ['INSTALLED', 'VIEW_ONLY', 'DISCOVERED'] }, assignments: { some: { areaId, validUntil: null } } },
    select: { id: true, osDeviceId: true, assignments: { where: { validUntil: null }, select: { areaId: true } } } });
  if (devices.some(device => device.assignments.some(assignment => assignment.areaId !== areaId)))
    denied('area_delete_legacy_shared_assignment', 'Review the shared device channel assignments before deleting this Area');
  // Converted parents are historical-only, not live children. They must not
  // enter the Hub's physical unpair inventory, but their retained values and
  // historical rows still belong to the erased room.
  const legacy = await tx.nativeDevice.findMany({ where: { homeId: scope.homeId,
    hubInstallationId: scope.hubInstallationId, lifecycle: 'RETIRED',
    capabilitySummary: { path: ['logicalConversion', 'version'], equals: 1 },
    assignments: { some: { areaId } } }, select: { id: true, osDeviceId: true } });
  const grants = await tx.tenantAreaGrant.findMany({ where: { homeId: scope.homeId, areaId, revokedAt: null }, select: { membershipId: true } });
  return { areaId, osAreaId: area.osAreaId, areaRevision: area.revision, managementRevision: home.managementRevision,
    deviceIds: devices.map(device => device.id).sort(), osDeviceIds: devices.map(device => device.osDeviceId).sort(),
    membershipIds: [...new Set(grants.map(grant => grant.membershipId))].sort(),
    legacyDeviceIds: legacy.map(row => row.id).sort(), legacyOsDeviceIds: legacy.map(row => row.osDeviceId).sort() };
}

/** Must be called after current full-Home operator authority is checked in this transaction. */
export async function previewAreaDeletion(tx: Tx, scope: AreaDeleteScope, input: { operationId: string; areaId: string }) {
  const current = await snapshot(tx, scope, input.areaId);
  const digest = hash(current);
  const key = `area-delete:${scope.hubInstallationId}:${input.operationId}`;
  const prior = await tx.nativeDomainOutbox.findUnique({ where: { idempotencyKey: key } });
  if (prior) {
    const body = prior.payload as unknown as DeletePayload;
    if (prior.homeId !== scope.homeId || body.actorId !== scope.employeeId || body.snapshot.areaId !== input.areaId
      || prior.expiresAt <= new Date()) denied('area_delete_operation_conflict', 'This operation is no longer available');
    return { operationId: input.operationId, digest: body.digest, state: prior.state, deviceCount: body.snapshot.deviceIds.length,
      expectedManagementRevision: body.snapshot.managementRevision, osAreaId: body.snapshot.osAreaId,
      osDeviceIds: body.snapshot.osDeviceIds };
  }
  await tx.nativeDomainOutbox.create({ data: { homeId: scope.homeId, hubInstallationId: scope.hubInstallationId,
    aggregateType: 'AreaDeletion', aggregateId: input.areaId, eventType: EVENT, idempotencyKey: key,
    state: 'PREVIEW', payload: { version: 1, actorId: scope.employeeId, snapshot: current, digest } as Prisma.InputJsonValue,
    expiresAt: new Date(Date.now() + 15 * 60_000) } });
  return { operationId: input.operationId, digest, state: 'PREVIEW', deviceCount: current.deviceIds.length,
    expectedManagementRevision: current.managementRevision, osAreaId: current.osAreaId, osDeviceIds: current.osDeviceIds };
}

async function operation(tx: Tx, scope: Pick<AreaDeleteScope, 'homeId' | 'hubInstallationId'>, operationId: string) {
  const row = await tx.nativeDomainOutbox.findUnique({ where: { idempotencyKey: `area-delete:${scope.hubInstallationId}:${operationId}` } });
  if (!row || row.eventType !== EVENT || row.homeId !== scope.homeId || row.hubInstallationId !== scope.hubInstallationId)
    denied('area_delete_operation_missing', 'The deletion operation is unavailable');
  return row;
}

/** Reserve the exact confirmed intent ONLINE, before local fencing. No grant/data is changed. */
export async function reserveAreaDeletion(tx: Tx, scope: AreaDeleteScope, input: {
  operationId: string; digest: string; confirmationName: string;
}) {
  const row = await operation(tx, scope, input.operationId);
  const payload = row.payload as unknown as DeletePayload;
  if (payload.actorId !== scope.employeeId || payload.digest !== input.digest)
    denied('area_delete_operation_conflict', 'The deletion confirmation does not match its reviewed scope');
  if (row.state !== 'PREVIEW') return { operationId: input.operationId, state: row.state };
  if (row.expiresAt <= new Date()) denied('area_delete_preview_expired', 'Refresh the deletion preview');
  await tx.$queryRaw`SELECT id FROM "Home" WHERE id = ${scope.homeId}::uuid FOR UPDATE`;
  const current = await snapshot(tx, scope, payload.snapshot.areaId);
  const area = await tx.area.findUniqueOrThrow({ where: { id: current.areaId }, select: { originalName: true } });
  if (hash(current) !== payload.digest || input.confirmationName !== area.originalName)
    denied('area_delete_preview_changed', 'The Area or its assignments changed; review a new preview');
  await assertLifecycleReservationAvailable(tx, scope.homeId, row.id,
    [...current.deviceIds, ...current.legacyDeviceIds], current.areaId);
  await tx.nativeDomainOutbox.update({ where: { id: row.id }, data: {
    state: 'RESERVED', expiresAt: KEEP_SECURITY_RECEIPT } });
  return { operationId: input.operationId, state: 'RESERVED' };
}

/** The authenticated Hub must have durably fenced the exact local affected set BEFORE this call. */
export async function commitAreaDeletion(tx: Tx, scope: AreaDeleteScope, input: {
  operationId: string; digest: string; localFenceDigest: string; confirmationName: string;
}) {
  const row = await operation(tx, scope, input.operationId);
  const payload = row.payload as unknown as DeletePayload;
  if (payload.digest !== input.digest || !/^[a-f0-9]{64}$/.test(input.localFenceDigest))
    denied('area_delete_operation_conflict', 'The deletion confirmation does not match its reviewed scope');
  if (!['PREVIEW', 'RESERVED'].includes(row.state)) {
    if (payload.localFenceDigest !== input.localFenceDigest) denied('area_delete_fence_conflict', 'The local deletion fence changed');
    return { operationId: input.operationId, state: row.state };
  }
  if (row.state !== 'RESERVED') denied('area_delete_reservation_missing', 'Reserve the reviewed intent before fencing the Hub');
  await tx.$queryRaw`SELECT id FROM "Home" WHERE id = ${scope.homeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT set_config('dinodia.area_deletion_operation', ${row.id}, true)`;
  const current = await snapshot(tx, scope, payload.snapshot.areaId);
  const area = await tx.area.findUniqueOrThrow({ where: { id: current.areaId }, select: { originalName: true } });
  const destructiveScope = (value: Snapshot) => ({ areaId: value.areaId, osAreaId: value.osAreaId,
    areaRevision: value.areaRevision, deviceIds: value.deviceIds, osDeviceIds: value.osDeviceIds,
    legacyDeviceIds: value.legacyDeviceIds, legacyOsDeviceIds: value.legacyOsDeviceIds });
  if (hash(destructiveScope(current)) !== hash(destructiveScope(payload.snapshot)) || input.confirmationName !== area.originalName)
    denied('area_delete_preview_changed', 'The Area or its assignments changed; review a new preview');
  const now = new Date();
  await tx.area.update({ where: { id: current.areaId }, data: { status: 'RETIRED', retiredAt: now, revision: { increment: 1 } } });
  await tx.tenantAreaGrant.updateMany({ where: { homeId: scope.homeId, areaId: current.areaId, revokedAt: null }, data: {
    revokedAt: now, revokeReason: 'area_deleted', policyRevision: current.managementRevision + 1 } });
  await tx.homeMembership.updateMany({ where: { homeId: scope.homeId, id: { in: current.membershipIds } }, data: { accessRevision: { increment: 1 } } });
  await tx.areaQrCredential.updateMany({ where: { areaId: current.areaId }, data: { status: 'DISABLED', disabledAt: now, encryptedPrintablePayload: Prisma.JsonNull } });
  await tx.areaAccessRequest.updateMany({ where: { homeId: scope.homeId, areaId: current.areaId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: now } });
  await retireNativeAutomations(tx, { homeId: scope.homeId, losingAreaIds: [current.areaId], now, actorId: scope.employeeId, reason: 'area_deleted' });
  await tx.nativeDevice.updateMany({ where: { homeId: scope.homeId, id: { in: [...current.deviceIds, ...current.legacyDeviceIds] } }, data: { lifecycle: 'REMOVAL_PENDING', inventoryRevision: { increment: 1 } } });
  await tx.alexaNativeAreaSelection.updateMany({ where: { areaId: current.areaId, revokedAt: null }, data: { revokedAt: now } });
  await tx.home.update({ where: { id: scope.homeId }, data: { managementRevision: { increment: 1 } } });
  // Suppression records are anonymous security fences, retained while old backups/replays may exist.
  const references = [deletedTargetReference(scope.hubInstallationId, 'area', current.osAreaId),
    ...current.osDeviceIds.map(id => deletedTargetReference(scope.hubInstallationId, 'device', id))];
  for (const anonymousReference of references) await tx.deletionSecurityReceipt.upsert({
    where: { anonymousReference }, create: { anonymousReference, actionType: 'AREA_DEVICE_ERASURE', purgeAt: KEEP_SECURITY_RECEIPT }, update: {} });
  for (const osDeviceId of current.legacyOsDeviceIds) {
    const anonymousReference = deletedTargetReference(scope.hubInstallationId, 'device', osDeviceId);
    await tx.deletionSecurityReceipt.upsert({ where: { anonymousReference }, create: {
      anonymousReference, actionType: 'AREA_LEGACY_ERASURE', purgeAt: KEEP_SECURITY_RECEIPT }, update: {} });
  }
  await tx.nativeDomainOutbox.update({ where: { id: row.id }, data: { state: 'WAITING_HUB',
    payload: { ...payload, localFenceDigest: input.localFenceDigest } as unknown as Prisma.InputJsonValue,
    expiresAt: KEEP_SECURITY_RECEIPT } });
  await refreshNativeAutomationCloudRevision(tx, { homeId: scope.homeId, hubInstallationId: scope.hubInstallationId });
  return { operationId: input.operationId, state: 'WAITING_HUB' };
}

/** Exact target purge after genuine Hub cleanup acknowledgement. Runs atomically or rolls back. */
export async function finishAreaDeletion(tx: Tx, scope: Pick<AreaDeleteScope, 'homeId' | 'hubInstallationId'>, input: {
  operationId: string; localFenceDigest: string;
}) {
  const row = await operation(tx, scope, input.operationId);
  if (row.state === 'COMPLETE') return { operationId: input.operationId, state: 'COMPLETE' };
  const payload = row.payload as unknown as DeletePayload;
  if (row.state !== 'WAITING_HUB' || payload.localFenceDigest !== input.localFenceDigest)
    denied('area_delete_fence_conflict', 'The cleanup acknowledgement does not match the committed operation');
  const { areaId } = payload.snapshot;
  const deviceIds = [...payload.snapshot.deviceIds, ...(payload.snapshot.legacyDeviceIds || [])];
  await tx.$queryRaw`SELECT id FROM "Home" WHERE id = ${scope.homeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT set_config('dinodia.area_deletion_operation', ${row.id}, true)`;
  await purgeAreaPayloads(tx, { ...scope, areaId, osAreaId: payload.snapshot.osAreaId, deviceIds,
    osDeviceIds: [...payload.snapshot.osDeviceIds, ...(payload.snapshot.legacyOsDeviceIds || [])], operationRowId: row.id });
  const target = { homeId: scope.homeId, OR: [{ areaId }, { deviceId: { in: deviceIds } }] };
  await purgeDailyAnalytics(tx, { homeId: scope.homeId, areaId, deviceIds });
  await tx.nativeDeviceUsageBucket.deleteMany({ where: target });
  await tx.nativeTemperatureSample.deleteMany({ where: target });
  await tx.nativeAnalyticsUnallocated.deleteMany({ where: target });
  await tx.nativeAnalyticsInterval.deleteMany({ where: { homeId: scope.homeId, deviceId: { in: deviceIds } } });
  await tx.nativeDeviceOutageIncident.deleteMany({ where: { homeId: scope.homeId, deviceId: { in: deviceIds } } });
  await tx.nativeCommissioningSession.deleteMany({ where: { homeId: scope.homeId, OR: [{ requestedAreaId: areaId }, { finalDeviceId: { in: deviceIds } }] } });
  await tx.permanentDeviceInstallationRequest.updateMany({ where: { homeId: scope.homeId, requestedAreaId: areaId }, data: { requestedAreaId: null } });
  // Remove only the deleted room's goods; another room's order item remains unchanged.
  const items = await tx.roomPlaqueRequestItem.findMany({ where: { areaId, request: { homeId: scope.homeId } }, select: { requestId: true } });
  await tx.roomPlaqueRequestItem.deleteMany({ where: { areaId, request: { homeId: scope.homeId } } });
  for (const requestId of new Set(items.map(item => item.requestId))) {
    if (await tx.roomPlaqueRequestItem.count({ where: { requestId } }) === 0)
      await tx.roomPlaqueRequest.deleteMany({ where: { id: requestId, homeId: scope.homeId } });
    else await tx.roomPlaqueRequest.update({ where: { id: requestId }, data: { revision: { increment: 1 } } });
  }
  await tx.roomAccessEmailAttempt.deleteMany({ where: { homeId: scope.homeId, areaId } });
  await tx.areaAccessRequest.deleteMany({ where: { homeId: scope.homeId, areaId } });
  await tx.alexaNativeEndpointProjection.deleteMany({ where: { homeId: scope.homeId, OR: [{ areaId }, { deviceId: { in: deviceIds } }] } });
  await tx.nativeDevice.deleteMany({ where: { homeId: scope.homeId, hubInstallationId: scope.hubInstallationId, id: { in: deviceIds }, lifecycle: 'REMOVAL_PENDING' } });
  await tx.area.deleteMany({ where: { id: areaId, homeId: scope.homeId, status: 'RETIRED' } });
  await tx.auditEvent.create({ data: { homeId: scope.homeId, actorType: 'EMPLOYEE', actorId: payload.actorId,
    category: 'INSTALLATION', action: 'area_deletion_completed', targetType: 'Area', targetId: areaId,
    metadata: { operationId: input.operationId, removedDeviceCount: deviceIds.length },
    purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60_000) } });
  await tx.nativeDomainOutbox.update({ where: { id: row.id }, data: { state: 'COMPLETE',
    payload: { version: 1, operationId: input.operationId, removedDeviceCount: deviceIds.length },
    expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60_000) } });
  return { operationId: input.operationId, state: 'COMPLETE' };
}
import { purgeDailyAnalytics } from './dailyAnalyticsErasure';
