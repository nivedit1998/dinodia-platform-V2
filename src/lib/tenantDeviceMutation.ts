// Architecture: Shared platform helper src/lib/tenantDeviceMutation.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { buildAreaAccessMatcher } from '@/lib/areaAccess';
import { normalizeDisplayText, normalizeLookupKey, buildTenantHaTechnicalName } from '@/lib/displayNormalization';
import { assignHaAreaToDevices, assignHaAreaToEntities } from '@/lib/haAreas';
import { getEntityRegistryEntriesForDevices, renameHaEntitiesForTenantDevice } from '@/lib/haEntityRegistry';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { removeDevicesFromHaRegistry, removeEntitiesFromHaRegistry } from '@/lib/haCleanup';
import { renameHaDevicesForTenantDevice } from '@/lib/haDeviceRegistry';
import { prisma } from '@/lib/prisma';
import { toStringSet } from '@/lib/tenantOwnership';
import {
  clearTriggerDeviceInventoryCache,
  removeTriggerBindingsForDeletedDeviceIds,
  removeTriggerBindingsReferencingTarget,
} from '@/lib/triggerDevices';
import { invalidateTenantInventoryBootstrap } from '@/lib/tenantInventoryBootstrap';
import { waitForTenantDeviceAbsence } from '@/lib/tenantDashboardVisibility';

type TenantWithContext = Awaited<ReturnType<typeof getUserWithHaConnection>>;

function normalize(value: string | null | undefined) {
  return (value ?? '').toString().trim();
}

function isManagedHaTechnicalName(userId: number, value: string | null | undefined) {
  const current = normalize(value).toLowerCase();
  return current.startsWith(`${userId}_`);
}

async function detectCommissionedRejoinRisk(args: {
  userId: number;
  haConnectionId: number;
  deviceIds: string[];
  entityIds: string[];
}) {
  const deviceIds = new Set(args.deviceIds.map(normalize).filter(Boolean));
  const entityIds = new Set(args.entityIds.map(normalize).filter(Boolean));
  if (deviceIds.size === 0 && entityIds.size === 0) return false;

  const sessions = await prisma.newDeviceCommissioningSession.findMany({
    where: {
      userId: args.userId,
      haConnectionId: args.haConnectionId,
    },
    select: {
      afterDeviceIds: true,
      afterEntityIds: true,
    },
  });

  return sessions.some((session) => {
    const afterDeviceIds = toStringSet(session.afterDeviceIds);
    const afterEntityIds = toStringSet(session.afterEntityIds);
    for (const deviceId of deviceIds) {
      if (afterDeviceIds.has(deviceId)) return true;
    }
    for (const entityId of entityIds) {
      if (afterEntityIds.has(entityId)) return true;
    }
    return false;
  });
}

async function resolveOverride(user: TenantWithContext['user'], haConnectionId: number, deviceId: string) {
  return prisma.tenantDeviceDisplayOverride.findFirst({
    where: {
      tenantUserId: user.id,
      haConnectionId,
      OR: [{ haDeviceId: deviceId }, { entityId: deviceId }],
    },
  });
}

async function resolveVirtualArea(args: {
  user: TenantWithContext['user'];
  haConnectionId: number;
  requestedParentAreaName: string;
  requestedParentAreaDisplayName: string;
  selectedVirtualAreaId?: string | null;
  newVirtualSubAreaName?: string | null;
}) {
  const tenantVirtualAreaId = normalize(args.selectedVirtualAreaId) || null;
  const newVirtualSubAreaName = normalize(args.newVirtualSubAreaName) || null;

  if (tenantVirtualAreaId) {
    const existing = await prisma.tenantVirtualArea.findFirst({
      where: {
        id: tenantVirtualAreaId,
        tenantUserId: args.user.id,
        haConnectionId: args.haConnectionId,
        parentHaAreaName: args.requestedParentAreaName,
      },
      select: { id: true },
    });
    if (!existing) {
      throw new Error('Selected sub-area is not available.');
    }
    return tenantVirtualAreaId;
  }

  if (!newVirtualSubAreaName) return null;

  const virtualArea = await prisma.tenantVirtualArea.upsert({
    where: {
      tenantUserId_haConnectionId_parentHaAreaName_displayKey: {
        tenantUserId: args.user.id,
        haConnectionId: args.haConnectionId,
        parentHaAreaName: args.requestedParentAreaName,
        displayKey: normalizeLookupKey(newVirtualSubAreaName),
      },
    },
    update: {
      displayName: newVirtualSubAreaName,
      parentAreaDisplaySnapshot: args.requestedParentAreaDisplayName,
    },
    create: {
      tenantUserId: args.user.id,
      haConnectionId: args.haConnectionId,
      parentHaAreaName: args.requestedParentAreaName,
      parentAreaDisplaySnapshot: args.requestedParentAreaDisplayName,
      displayName: newVirtualSubAreaName,
      displayKey: normalizeLookupKey(newVirtualSubAreaName),
    },
    select: { id: true },
  });
  return virtualArea.id;
}

export async function updateTenantOwnedDevice(args: {
  userWithHa: TenantWithContext;
  targetId: string;
  displayName: string;
  displayLabel?: string | null;
  parentAreaName?: string | null;
  selectedVirtualAreaId?: string | null;
  newVirtualSubAreaName?: string | null;
}) {
  const { user, haConnection } = args.userWithHa;
  const override = await resolveOverride(user, haConnection.id, args.targetId);
  if (!override) {
    throw new Error('Tenant-owned device not found.');
  }

  const displayName = normalizeDisplayText(args.displayName);
  if (!displayName) {
    throw new Error('Please enter a device name.');
  }
  if (args.displayLabel != null && !normalizeDisplayText(args.displayLabel)) {
    throw new Error('Please enter a label.');
  }

  const duplicate = await prisma.tenantDeviceDisplayOverride.findFirst({
    where: {
      tenantUserId: user.id,
      haConnectionId: haConnection.id,
      displayNameKey: normalizeLookupKey(displayName),
      NOT: { id: override.id },
    },
    select: { id: true },
  });
  if (duplicate) {
    const err = new Error('You already have a device with this name. Please choose another name.');
    err.name = 'ConflictError';
    throw err;
  }

  const requestedParentAreaName = normalizeDisplayText(args.parentAreaName);
  const areaAccess = await buildAreaAccessMatcher({
    haConnectionId: haConnection.id,
    accessAreas: user.accessRules.map((rule) => rule.area),
  });
  const resolvedParentAreaName = requestedParentAreaName
    ? areaAccess.resolveRequestedArea(requestedParentAreaName)
    : null;
  if (requestedParentAreaName && !resolvedParentAreaName) {
    throw new Error('You are not allowed to move devices to that area.');
  }
  const parentAreaDisplayName = resolvedParentAreaName
    ? areaAccess.displayNameForArea(resolvedParentAreaName) ?? requestedParentAreaName
    : null;

  const tenantVirtualAreaId = resolvedParentAreaName
    ? await resolveVirtualArea({
        user,
        haConnectionId: haConnection.id,
        requestedParentAreaName: resolvedParentAreaName,
        requestedParentAreaDisplayName: parentAreaDisplayName ?? resolvedParentAreaName,
        selectedVirtualAreaId: args.selectedVirtualAreaId,
        newVirtualSubAreaName: args.newVirtualSubAreaName,
      })
    : override.tenantVirtualAreaId;

  const deviceIds = override.haDeviceId ? [override.haDeviceId] : [];
  const entityIds = override.entityId ? [override.entityId] : [];
  const areaChanged =
    (resolvedParentAreaName ?? null) !== (override.parentHaAreaName ?? null) ||
    (tenantVirtualAreaId ?? null) !== (override.tenantVirtualAreaId ?? null);
  const ha = resolveHaCloudFirst(haConnection);
  const managedHaTechnicalName = isManagedHaTechnicalName(user.id, override.haTechnicalName)
    ? buildTenantHaTechnicalName(user.id, displayName)
    : normalize(override.haTechnicalName) || null;

  if (managedHaTechnicalName) {
    if (deviceIds.length > 0) {
      const [deviceRename, entityRename] = await Promise.all([
        renameHaDevicesForTenantDevice(ha, deviceIds, managedHaTechnicalName),
        renameHaEntitiesForTenantDevice(ha, { deviceIds, entityIds }, managedHaTechnicalName),
      ]);
      if (!deviceRename.ok) {
        throw new Error(deviceRename.warning || 'We could not rename this device in Home Assistant.');
      }
      if (!entityRename.ok && entityRename.failedCount > 0) {
        throw new Error(entityRename.warning || 'We could not rename this device in Home Assistant.');
      }
    } else if (entityIds.length > 0) {
      const entityRename = await renameHaEntitiesForTenantDevice(ha, { deviceIds, entityIds }, managedHaTechnicalName);
      if (!entityRename.ok) {
        throw new Error(entityRename.warning || 'We could not rename this device in Home Assistant.');
      }
    }
  }

  if (resolvedParentAreaName && areaChanged) {
    if (deviceIds.length > 0) {
      const [deviceMove, entityMove] = await Promise.all([
        assignHaAreaToDevices(ha, resolvedParentAreaName, deviceIds),
        assignHaAreaToEntities(ha, resolvedParentAreaName, entityIds),
      ]);
      if (!deviceMove.ok) {
        throw new Error(deviceMove.warning || 'We could not move this device in Home Assistant.');
      }
      if (!entityMove.ok && entityMove.failedCount > 0) {
        throw new Error(entityMove.warning || 'We could not move this device in Home Assistant.');
      }
    } else if (entityIds.length > 0) {
      const entityMove = await assignHaAreaToEntities(ha, resolvedParentAreaName, entityIds);
      if (!entityMove.ok) {
        throw new Error(entityMove.warning || 'We could not move this device in Home Assistant.');
      }
    }
  }

  const updated = await prisma.tenantDeviceDisplayOverride.update({
    where: { id: override.id },
    data: {
      displayName,
      displayNameKey: normalizeLookupKey(displayName),
      haTechnicalName: managedHaTechnicalName ?? override.haTechnicalName,
      displayLabel: normalizeDisplayText(args.displayLabel) ?? override.displayLabel,
      displayLabelKey: normalizeDisplayText(args.displayLabel)
        ? normalizeLookupKey(args.displayLabel)
        : override.displayLabelKey,
      parentHaAreaName: resolvedParentAreaName ?? override.parentHaAreaName,
      parentAreaDisplaySnapshot: parentAreaDisplayName ?? override.parentAreaDisplaySnapshot,
      tenantVirtualAreaId,
    },
  });

  invalidateTenantInventoryBootstrap(user.id);
  clearTriggerDeviceInventoryCache(ha);
  return updated;
}

export async function deleteTenantOwnedDevice(args: {
  userWithHa: TenantWithContext;
  targetId: string;
}) {
  const { user, haConnection } = args.userWithHa;
  const override = await resolveOverride(user, haConnection.id, args.targetId);
  if (!override) {
    return {
      ok: true,
      alreadyRemoved: true as const,
      removedDeviceId: null,
      removedEntityIds: [] as string[],
      removedTriggerBindings: 0,
      zigbeeRejoinPossible: false,
      postDeleteNotice: null,
    };
  }

  const ha = resolveHaCloudFirst(haConnection);
  const deviceIds = Array.from(new Set([normalize(override.haDeviceId)].filter(Boolean)));
  const linkedEntries = deviceIds.length > 0 ? await getEntityRegistryEntriesForDevices(ha, deviceIds) : [];
  const entityIds = Array.from(
    new Set([normalize(override.entityId), ...linkedEntries.map((entry) => normalize(entry.entity_id))].filter(Boolean))
  );
  const zigbeeRejoinPossible = await detectCommissionedRejoinRisk({
    userId: user.id,
    haConnectionId: haConnection.id,
    deviceIds,
    entityIds,
  });

  if (deviceIds.length > 0) {
    const removedDevices = await removeDevicesFromHaRegistry(ha, deviceIds);
    if (removedDevices.failed > 0) {
      throw new Error(removedDevices.errors[0] || 'We could not remove this device from Home Assistant.');
    }
  } else if (entityIds.length > 0) {
    const removedEntities = await removeEntitiesFromHaRegistry(ha, entityIds);
    if (removedEntities.failed > 0) {
      throw new Error(removedEntities.errors[0] || 'We could not remove this device from Home Assistant.');
    }
  }

  const removedRemoteBindings = await removeTriggerBindingsForDeletedDeviceIds({
    tenantUserId: user.id,
    haConnection,
    remoteDeviceIds: deviceIds,
  });
  const removedTargetBindings = await removeTriggerBindingsReferencingTarget({
    tenantUserId: user.id,
    haConnection,
    targetDeviceIds: deviceIds,
    targetEntityIds: entityIds,
  });

  await prisma.tenantDeviceDisplayOverride.deleteMany({
    where: {
      tenantUserId: user.id,
      haConnectionId: haConnection.id,
      OR: [
        { id: override.id },
        ...(deviceIds.length > 0 ? [{ haDeviceId: { in: deviceIds } }] : []),
        ...(entityIds.length > 0 ? [{ entityId: { in: entityIds } }] : []),
      ],
    },
  });

  invalidateTenantInventoryBootstrap(user.id);
  clearTriggerDeviceInventoryCache(ha);

  const absence = await waitForTenantDeviceAbsence({
    userId: user.id,
    removedDeviceIds: deviceIds,
    removedEntityIds: entityIds,
    timeoutMs: 10_000,
    pollIntervalMs: 750,
  });
  if (!absence.absent) {
    throw new Error('We could not confirm that this device has been removed from the dashboard yet.');
  }

  return {
    ok: true,
    alreadyRemoved: false as const,
    removedDeviceId: deviceIds[0] ?? null,
    removedEntityIds: entityIds,
    removedTriggerBindings:
      (removedRemoteBindings.removedBindings ?? 0) + (removedTargetBindings.removedBindings ?? 0),
    zigbeeRejoinPossible,
    postDeleteNotice: zigbeeRejoinPossible
      ? 'Device removed from Dinodia. If it is still paired to the Zigbee network, it may reappear until it is factory reset or removed from Zigbee.'
      : null,
  };
}
