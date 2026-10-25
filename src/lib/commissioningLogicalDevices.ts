import { randomUUID } from 'node:crypto';
import type { Prisma, NativeDevice } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { validateNativeDevice } from './contracts/dinodiaV1';
import { bindLogicalChildren, logicalOsId, validateLogicalBindings, type LogicalBinding } from './logicalDeviceIdentity';
import { changeAnalyticsInterval } from './analyticsIntervals';

type Channel = { binding: LogicalBinding; catalogue: Record<string, unknown> };

/** The caller has rechecked the actual commissioning actor/session and exact reviewed parent. */
export async function commissionLogicalChildren(tx: Prisma.TransactionClient, input: {
  original: NativeDevice; channels: unknown; protocolIdentityHash: string; generation: number; now: Date;
}) {
  const original = input.original;
  if (await tx.nativeAnalyticsInterval.count({ where: { deviceId: original.id } }) > 0)
    throw new Stage1AuthError(409, 'logical_conversion_review_required', 'Existing history requires an explicit channel conversion review');
  if (!Array.isArray(input.channels) || input.channels.length < 2 || input.channels.length > 32) {
    throw new Stage1AuthError(400, 'logical_channels_invalid', 'A bounded independent channel manifest is required');
  }
  const channels = input.channels as Channel[];
  if (!validateLogicalBindings(original.osDeviceId, channels.map(channel => channel.binding))) {
    throw new Stage1AuthError(409, 'logical_binding_invalid', 'The independent channel bindings are invalid');
  }
  const originalAreas = await tx.deviceAreaAssignment.findMany({ where: { deviceId: original.id, homeId: original.homeId, validUntil: null }, select: { areaId: true } });
  if (originalAreas.length !== 1) throw new Stage1AuthError(409, 'logical_assignment_ambiguous', 'The physical device needs one reviewed initial Area');
  const areaId = originalAreas[0].areaId;
  const created = [];
  for (const channel of channels) {
    const cat = channel.catalogue;
    const osDeviceId = logicalOsId(original.osDeviceId, channel.binding.channelKey, channel.binding.channelGeneration);
    if (!cat || cat.osDeviceId !== osDeviceId || cat.areaId !== areaId
      || !/^[a-f0-9]{64}$/.test(String(cat.descriptorDigest || ''))
      || typeof cat.name !== 'string' || [...cat.name].length < 1 || [...cat.name].length > 80
      || !validateNativeDevice({ id: osDeviceId, homeId: original.homeId,
        managementClass: original.managementClass === 'PROPERTY_DEVICE' ? 'property_device' : 'tenant_device',
        ownerMembershipId: original.ownerMembershipId, lifecycle: 'installed', technicalLabel: cat.technicalLabel,
        customerLabel: original.customerLabel, areaIds: [areaId], controls: cat.controls,
        descriptorRevision: cat.descriptorRevision }, { homeId: original.homeId,
          homeMembershipId: original.ownerMembershipId || undefined, role: original.managementClass === 'TENANT_DEVICE' ? 'TENANT' : 'OWNER', areaIds: [areaId] })) {
      throw new Stage1AuthError(409, 'logical_catalogue_invalid', 'The channel catalogue does not match its authorized device');
    }
    const controls = cat.controls as Array<Record<string, unknown>>;
    const row = await tx.nativeDevice.create({ data: {
      id: randomUUID(), homeId: original.homeId, hubInstallationId: original.hubInstallationId,
      osDeviceId, originalName: cat.name, overrideName: cat.name, technicalLabel: String(cat.technicalLabel),
      customerLabel: original.customerLabel, analyticsCategory: original.analyticsCategory,
      managementClass: original.managementClass, ownerMembershipId: original.ownerMembershipId,
      installationRequestId: original.installationRequestId, deviceType: original.deviceType,
      manufacturer: original.manufacturer, model: original.model, protocol: original.protocol,
      descriptorRevision: Number(cat.descriptorRevision), descriptorDigest: String(cat.descriptorDigest),
      lifecycle: original.lifecycle, onlineState: 'UNKNOWN', installedAt: input.now,
      capabilitySummary: { controls: controls.map(control => ({ controlId: control.controlId, kind: control.valueType,
        readable: control.readable, writable: control.writable, domain: control.semanticRole })),
        controlCatalog: { revision: Number(cat.descriptorRevision), controls },
        commissioning: { status: 'ready', usefulReadings: cat.usefulReadings === true,
          catalogueVersion: 'DINODIA-NATIVE-COMMISSIONING-V1', descriptorDigest: String(cat.descriptorDigest) } } as Prisma.InputJsonValue,
      assignments: { create: { homeId: original.homeId, areaId, source: 'NATIVE_LOGICAL_CHANNEL_COMMISSIONING', validFrom: input.now } },
    } });
    created.push({ row, binding: channel.binding });
  }
  await bindLogicalChildren(tx, { homeId: original.homeId, hubInstallationId: original.hubInstallationId,
    physicalId: original.osDeviceId, protocol: String(original.protocol), protocolIdentityHash: input.protocolIdentityHash,
    managementClass: original.managementClass, ownerMembershipId: original.ownerMembershipId,
    children: created.map(child => ({ deviceId: child.row.id, osDeviceId: child.row.osDeviceId, binding: child.binding })) });
  // This record was created in the SAME finalization transaction; it has no pre-existing history.
  await tx.deviceAreaAssignment.updateMany({ where: { deviceId: original.id, validUntil: null }, data: { validUntil: input.now } });
  await tx.nativeDevice.update({ where: { id: original.id }, data: { lifecycle: 'RETIRED', retiredAt: input.now, inventoryRevision: { increment: 1 } } });
  await tx.nativeDeviceSourceAlias.updateMany({ where: { deviceId: original.id, retiredAt: null }, data: { retiredAt: input.now } });
  for (const child of created) {
    if (original.managementClass === 'PROPERTY_DEVICE') await changeAnalyticsInterval(tx, { homeId: original.homeId,
      hubInstallationId: original.hubInstallationId, deviceId: child.row.id, category: child.row.analyticsCategory,
      selectedControlId: null, generation: input.generation, at: input.now });
  }
  return created.map(({ row, binding }) => ({ id: row.id, osDeviceId: row.osDeviceId,
    managementClass: row.managementClass, ownerMembershipId: row.ownerMembershipId, lifecycle: row.lifecycle,
    customerLabel: row.customerLabel, descriptorRevision: row.descriptorRevision, descriptorDigest: row.descriptorDigest,
    analyticsCategory: row.analyticsCategory, inventoryRevision: row.inventoryRevision, binding }));
}
