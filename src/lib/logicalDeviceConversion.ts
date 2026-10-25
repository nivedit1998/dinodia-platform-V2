import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { commissionLogicalChildren } from './commissioningLogicalDevices';
import { suspendAutomationsForDeviceChange } from './nativeAutomations/revalidation';
import { refreshNativeAutomationCloudRevision } from './nativeAutomations/delivery';
import type { AreaDeleteScope } from './areaDeletion';
import { assertLifecycleReservationAvailable } from './areaDeletion';
import { validLogicalAssignment } from './logicalDeviceManagement';

function fail(code: string): never { throw new Stage1AuthError(409, code, 'The reviewed channel conversion changed; refresh its preview'); }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Called only after current full-Home authority, under the Home lock. No radio work. */
export async function logicalDeviceConversion(tx: Prisma.TransactionClient, scope: AreaDeleteScope, input: {
  action: string; operationId: string; osDeviceId: string; channels?: unknown; protocolIdentityHash?: string;
  digest?: string; confirmationName?: string; generation: number;
  assignment?: unknown;
}) {
  const key = `logical-convert:${scope.hubInstallationId}:${input.operationId}`;
  const prior = await tx.nativeDomainOutbox.findUnique({ where: { idempotencyKey: key } });
  const device = await tx.nativeDevice.findFirst({ where: { homeId: scope.homeId, hubInstallationId: scope.hubInstallationId,
    osDeviceId: input.osDeviceId } });
  if (!device) fail('logical_conversion_missing');
  if (input.action === 'assign') return validLogicalAssignment(tx, scope, { ...input, device });
  if (input.action === 'preview') {
    if (prior || !['INSTALLED', 'VIEW_ONLY'].includes(device.lifecycle) || device.physicalParentId
      || device.managementClass !== 'PROPERTY_DEVICE' || device.ownerMembershipId) fail('logical_conversion_unavailable');
    if (!Array.isArray(input.channels) || input.channels.length < 2 || input.channels.length > 32
      || !/^[a-f0-9]{64}$/.test(String(input.protocolIdentityHash))) fail('logical_conversion_invalid');
    const body = { version: 1, actorId: scope.employeeId, deviceId: device.id, inventoryRevision: device.inventoryRevision,
      descriptorRevision: device.descriptorRevision, channels: input.channels, protocolIdentityHash: input.protocolIdentityHash,
      confirmationName: device.overrideName || device.originalName };
    const hash = digest(body);
    await tx.nativeDomainOutbox.create({ data: { homeId: scope.homeId, hubInstallationId: scope.hubInstallationId,
      aggregateType: 'LogicalDeviceConversion', aggregateId: device.id, eventType: 'LOGICAL_CONVERSION_V1',
      idempotencyKey: key, state: 'PREVIEW', payload: { ...body, digest: hash } as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + 15 * 60000) } });
    return { state: 'PREVIEW', digest: hash, confirmationName: body.confirmationName };
  }
  if (!prior || prior.homeId !== scope.homeId || prior.hubInstallationId !== scope.hubInstallationId
    || prior.eventType !== 'LOGICAL_CONVERSION_V1') fail('logical_conversion_missing');
  const body = prior.payload as Record<string, unknown>;
  if ((input.action !== 'commit' && body.actorId !== scope.employeeId) || body.deviceId !== device.id || body.digest !== input.digest
    || body.confirmationName !== input.confirmationName) fail('logical_conversion_confirmation_invalid');
  if (prior.state === 'COMPLETE') return body.result as Record<string, unknown>;
  if (input.action === 'reserve') {
    if (!['PREVIEW', 'RESERVED'].includes(prior.state) || prior.expiresAt <= new Date()
      || device.inventoryRevision !== body.inventoryRevision || device.descriptorRevision !== body.descriptorRevision)
      fail('logical_conversion_changed');
    if (prior.state === 'PREVIEW') await assertLifecycleReservationAvailable(tx, scope.homeId, prior.id, [device.id]);
    await tx.nativeDomainOutbox.update({ where: { id: prior.id }, data: { state: 'RESERVED', expiresAt: new Date('9999-12-31T00:00:00Z') } });
    return { state: 'RESERVED' };
  }
  if (input.action !== 'commit' || prior.state !== 'RESERVED') fail('logical_conversion_not_reserved');
  await tx.$executeRaw`SELECT set_config('dinodia.logical_conversion_operation', ${prior.id}, true)`;
  const now = new Date();
  await suspendAutomationsForDeviceChange(tx, { homeId: scope.homeId, deviceId: device.id, now, reason: 'descriptor_changed' });
  const children = await commissionLogicalChildren(tx, { original: device, channels: body.channels,
    protocolIdentityHash: String(body.protocolIdentityHash), generation: input.generation, now,
    historicalCutover: { expectedInventoryRevision: Number(body.inventoryRevision) } });
  await tx.alexaNativeEndpointProjection.updateMany({ where: { homeId: scope.homeId, deviceId: device.id }, data: { status: 'REVOKED' } });
  await tx.home.update({ where: { id: scope.homeId }, data: { managementRevision: { increment: 1 } } });
  await refreshNativeAutomationCloudRevision(tx, scope);
  const result = { state: 'COMPLETE', cutoverAt: now.toISOString(), children };
  await tx.nativeDomainOutbox.update({ where: { id: prior.id }, data: { state: 'COMPLETE',
    payload: { ...body, result } as unknown as Prisma.InputJsonValue } });
  return result;
}
