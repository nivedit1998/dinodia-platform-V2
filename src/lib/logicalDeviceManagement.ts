import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma, type NativeDevice } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { validateNativeDevice } from './contracts/dinodiaV1';
import { changeAnalyticsInterval } from './analyticsIntervals';
import { refreshNativeAutomationCloudRevision } from './nativeAutomations/delivery';
import { suspendAutomationsForDeviceChange } from './nativeAutomations/revalidation';
import type { AreaDeleteScope } from './areaDeletion';
import type { LogicalBinding } from './logicalDeviceIdentity';

function fail(): never { throw new Stage1AuthError(409, 'logical_assignment_changed', 'The current channel or Area changed; refresh and retry'); }
/** Existing full-Home authority has been checked under the Home lock. */
export async function validLogicalAssignment(tx: Prisma.TransactionClient, scope: AreaDeleteScope, input: {
  operationId: string; device: NativeDevice; assignment?: unknown; generation: number;
}) {
  const d = input.device;
  const a = input.assignment as { expectedInventoryRevision: number; areaId: string; catalogue: Record<string, unknown>; binding: LogicalBinding };
  const requestHash = createHash('sha256').update(JSON.stringify(input.assignment)).digest('hex');
  const keyHash = createHash('sha256').update(`${scope.hubInstallationId}:${input.operationId}`).digest('hex');
  const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: 'logical-assignment:v1', keyHash } } });
  if (!d.physicalParentId || d.managementClass !== 'PROPERTY_DEVICE' || d.ownerMembershipId
    || !['INSTALLED', 'VIEW_ONLY'].includes(d.lifecycle)) fail();
  if (prior) {
    if (prior.actorId !== scope.employeeId || prior.homeId !== scope.homeId || prior.requestHash !== requestHash) fail();
    const result = prior.responseBody as { device?: { inventoryRevision?: number; binding?: unknown } } | null;
    if (d.inventoryRevision !== result?.device?.inventoryRevision
      || !isDeepStrictEqual(d.sourceBinding, result?.device?.binding)) fail();
    return prior.responseBody;
  }
  if (!a || !d.physicalParentId || d.managementClass !== 'PROPERTY_DEVICE' || d.ownerMembershipId
    || !['INSTALLED', 'VIEW_ONLY'].includes(d.lifecycle) || d.inventoryRevision !== a.expectedInventoryRevision) fail();
  const area = await tx.area.findFirst({ where: { id: a.areaId, homeId: scope.homeId, status: 'ACTIVE' } });
  const old = d.sourceBinding as unknown as LogicalBinding;
  const cat = a.catalogue;
  if (!area || !old || !cat || !a.binding || a.binding.mappingRevision !== old.mappingRevision + 1
    || !isDeepStrictEqual({ ...a.binding, mappingRevision: old.mappingRevision }, old)
    || cat.osDeviceId !== d.osDeviceId || cat.areaId !== area.id || typeof cat.name !== 'string'
    || [...cat.name].length < 1 || [...cat.name].length > 80 || typeof cat.customerLabel !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(cat.descriptorDigest))
    || !validateNativeDevice({ id: d.osDeviceId, homeId: d.homeId, managementClass: 'property_device', ownerMembershipId: null,
      lifecycle: 'installed', technicalLabel: cat.technicalLabel, customerLabel: cat.customerLabel,
      areaIds: [area.id], controls: cat.controls, descriptorRevision: cat.descriptorRevision },
      { homeId: d.homeId, role: 'OWNER', areaIds: [area.id] })) fail();
  const now = new Date();
  await suspendAutomationsForDeviceChange(tx, { homeId: d.homeId, deviceId: d.id, now, reason: 'area_changed' });
  await tx.deviceAreaAssignment.updateMany({ where: { deviceId: d.id, validUntil: null }, data: { validUntil: now } });
  await tx.deviceAreaAssignment.create({ data: { homeId: d.homeId, deviceId: d.id, areaId: area.id, source: 'LOGICAL_CHANNEL_ASSIGNMENT', validFrom: now } });
  const row = await tx.nativeDevice.update({ where: { id: d.id }, data: { overrideName: cat.name, customerLabel: cat.customerLabel,
    descriptorRevision: Number(cat.descriptorRevision), descriptorDigest: String(cat.descriptorDigest),
    mappingRevision: a.binding.mappingRevision, sourceBinding: a.binding as unknown as Prisma.InputJsonValue,
    capabilitySummary: { ...(d.capabilitySummary as Record<string, unknown> || {}),
      controlCatalog: { revision: Number(cat.descriptorRevision), controls: cat.controls } } as Prisma.InputJsonValue,
    inventoryRevision: { increment: 1 } } });
  const previousInterval = await tx.nativeAnalyticsInterval.findFirst({ where: { deviceId: d.id, validUntil: null },
    select: { selectedControlId: true } });
  await changeAnalyticsInterval(tx, { homeId: d.homeId, hubInstallationId: d.hubInstallationId, deviceId: d.id,
    category: d.analyticsCategory, selectedControlId: previousInterval?.selectedControlId || null,
    generation: input.generation, at: now, forceNew: true });
  await tx.home.update({ where: { id: d.homeId }, data: { managementRevision: { increment: 1 } } });
  await refreshNativeAutomationCloudRevision(tx, scope);
  const result = { state: 'COMPLETE', device: { id: row.id, osDeviceId: row.osDeviceId, overrideName: row.overrideName,
    customerLabel: row.customerLabel, descriptorRevision: row.descriptorRevision, descriptorDigest: row.descriptorDigest,
    inventoryRevision: row.inventoryRevision, binding: a.binding } };
  await tx.idempotencyRecord.create({ data: { namespace: 'logical-assignment:v1', keyHash, actorId: scope.employeeId,
    homeId: scope.homeId, hubInstallationId: scope.hubInstallationId, requestHash, responseStatus: 200,
    responseBody: result, responseDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    expiresAt: new Date(Date.now() + 24 * 3600000) } });
  return result;
}
