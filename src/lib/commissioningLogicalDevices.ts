import { randomUUID } from 'node:crypto';
import type { Prisma, NativeDevice } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';
import { validateNativeDevice } from './contracts/dinodiaV1';
import { bindLogicalChildren, logicalOsId, validateLogicalBindings, type LogicalBinding } from './logicalDeviceIdentity';
import { changeAnalyticsInterval } from './analyticsIntervals';
import { deletedTargetReference } from './deletionReferences';

type Channel = { binding: LogicalBinding; catalogue: Record<string, unknown> };

/** The caller has rechecked the actual commissioning actor/session and exact reviewed parent. */
export async function commissionLogicalChildren(tx: Prisma.TransactionClient, input: {
  original: NativeDevice; channels: unknown; protocolIdentityHash: string; generation: number; now: Date;
  historicalCutover?: { expectedInventoryRevision: number };
  initialAreaId?: string;
  appendToParent?: { physicalId: string; parentId: string };
}) {
  const original = input.appendToParent ? { ...input.original, osDeviceId: input.appendToParent.physicalId,
    analyticsCategory: 'NONE' as const } : input.original;
  if (input.appendToParent && (input.original.physicalParentId !== input.appendToParent.parentId
    || original.managementClass !== 'PROPERTY_DEVICE' || original.ownerMembershipId
    || !['INSTALLED', 'VIEW_ONLY'].includes(original.lifecycle)))
    throw new Stage1AuthError(409, 'logical_parent_changed', 'The surviving permanent channel changed');
  if (!input.appendToParent && !input.historicalCutover && await tx.nativeAnalyticsInterval.count({ where: { deviceId: original.id } }) > 0)
    throw new Stage1AuthError(409, 'logical_conversion_review_required', 'Existing history requires an explicit channel conversion review');
  if (input.historicalCutover) {
    const current = await tx.nativeDevice.findFirst({ where: { id: original.id, homeId: original.homeId,
      hubInstallationId: original.hubInstallationId, inventoryRevision: input.historicalCutover.expectedInventoryRevision,
      lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] }, physicalParentId: null } });
    if (!current) throw new Stage1AuthError(409, 'logical_conversion_changed', 'The reviewed existing device changed');
    const last = await tx.nativeAnalyticsInterval.findFirst({ where: { deviceId: original.id }, orderBy: { revision: 'desc' } });
    if (last && input.now <= last.validFrom) throw new Stage1AuthError(409, 'logical_conversion_time_invalid', 'Wait for a later trusted cutover time');
    // Never split or copy old counters. The original identity and closed epochs
    // remain the sole authority for historical uploads.
    await tx.nativeAnalyticsInterval.updateMany({ where: { deviceId: original.id, validUntil: null }, data: { validUntil: input.now } });
  }
  if (!Array.isArray(input.channels) || input.channels.length < (input.appendToParent ? 1 : 2) || input.channels.length > 32) {
    throw new Stage1AuthError(400, 'logical_channels_invalid', 'A bounded independent channel manifest is required');
  }
  const channels = input.channels as Channel[];
  if (!validateLogicalBindings(original.osDeviceId, channels.map(channel => channel.binding))) {
    throw new Stage1AuthError(409, 'logical_binding_invalid', 'The independent channel bindings are invalid');
  }
  const retired = await tx.deletionSecurityReceipt.findMany({ where: { anonymousReference: {
    in: channels.map(channel => deletedTargetReference(original.hubInstallationId, 'device', String(channel.catalogue?.osDeviceId))) },
    actionType: { in: ['AREA_DEVICE_ERASURE', 'AREA_LEGACY_ERASURE'] } }, select: { id: true } });
  if (retired.length) throw new Stage1AuthError(409, 'logical_identity_retired',
    'Refresh current signed retirement evidence before commissioning a new channel generation');
  const initialArea = input.initialAreaId && !input.historicalCutover
    ? await tx.area.findFirst({ where: { id: input.initialAreaId, homeId: original.homeId, status: 'ACTIVE' }, select: { id: true } })
    : null;
  if (input.initialAreaId && !initialArea) throw new Stage1AuthError(409, 'logical_assignment_ambiguous', 'The initial channel Area changed');
  const originalAreas = initialArea ? [{ areaId: initialArea.id }]
    : await tx.deviceAreaAssignment.findMany({ where: { deviceId: original.id, homeId: original.homeId, validUntil: null }, select: { areaId: true } });
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
      osDeviceId, originalName: cat.name, overrideName: cat.name,
      technicalLabel: original.managementClass === 'TENANT_DEVICE' ? 'tenant_device' : String(cat.technicalLabel),
      customerLabel: original.customerLabel, analyticsCategory: original.analyticsCategory,
      managementClass: original.managementClass, ownerMembershipId: original.ownerMembershipId,
      installationRequestId: original.installationRequestId, deviceType: original.deviceType,
      manufacturer: original.manufacturer, model: original.model, protocol: original.protocol,
      descriptorRevision: Number(cat.descriptorRevision), descriptorDigest: String(cat.descriptorDigest),
      lifecycle: original.lifecycle, onlineState: 'UNKNOWN', installedAt: input.now,
      capabilitySummary: { controls: controls.map(control => ({ controlId: control.controlId, kind: control.valueType,
        readable: control.readable, writable: control.writable, domain: control.semanticRole })),
        controlCatalog: { revision: Number(cat.descriptorRevision), descriptorDigest: String(cat.descriptorDigest), controls },
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
  // Keep the historical assignment for conversion: interval authority bounds
  // admission, while a straddling legacy aggregate is retained as unallocated.
  if (!input.appendToParent && !input.historicalCutover && !input.initialAreaId)
    await tx.deviceAreaAssignment.updateMany({ where: { deviceId: original.id, validUntil: null }, data: { validUntil: input.now } });
  if (!input.appendToParent) await tx.nativeDevice.update({ where: { id: original.id }, data: { lifecycle: 'RETIRED', retiredAt: input.now, inventoryRevision: { increment: 1 },
    ...(input.historicalCutover ? { capabilitySummary: { ...(original.capabilitySummary as Record<string, unknown> || {}),
      logicalConversion: { version: 1, cutoverAt: input.now.toISOString(), children: created.map(child => child.row.id) } } as Prisma.InputJsonValue } : {}) } });
  if (!input.appendToParent) await tx.nativeDeviceSourceAlias.updateMany({ where: { deviceId: original.id, retiredAt: null }, data: { retiredAt: input.now } });
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
