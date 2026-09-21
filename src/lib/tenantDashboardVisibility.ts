// Architecture: Shared platform helper src/lib/tenantDashboardVisibility.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getTenantDashboardDevices } from '@/lib/deviceCapabilities';
import { isIgnoredDashboardHelperEntity } from '@/lib/dashboardEntityFilters';
import { getTenantInventoryBootstrap } from '@/lib/tenantInventoryBootstrap';
import {
  inferTenantOwnerFromTechnicalName,
  isOwnedByAnotherTenantDeviceFirst,
  isOwnedByTenantDeviceFirst,
} from '@/lib/tenantOwnership';
import { hasTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';
import { getTriggerDeviceDashboardContextForTenant } from '@/lib/triggerDevices';

function normalize(value: string | null | undefined) {
  return (value ?? '').toString().trim();
}

function normalizeId(value: string | null | undefined) {
  return normalize(value).toLowerCase();
}

type BootstrapSnapshot = Awaited<ReturnType<typeof getTenantInventoryBootstrap>>;

export function buildTenantVisibleDevicesFromBootstrap(bootstrap: BootstrapSnapshot) {
  const {
    user,
    labelledDevices: devices,
    ownershipIndex,
    sourceAreaByEntity,
    displayAreaByEntity,
    hasAreaAccess,
  } = bootstrap;

  let finalResult = devices.filter((device) => {
    if (isIgnoredDashboardHelperEntity(device)) return false;

    const rawLabels = device.technicalLabels ?? device.labels ?? [];
    const hasTenantLabel = hasTenantDeviceLabelValue(rawLabels);
    const pending =
      (device.deviceId ? ownershipIndex.pendingDeviceIds.has(device.deviceId) : false) ||
      ownershipIndex.pendingEntityIds.has(device.entityId);
    if (pending) return false;

    if (isOwnedByTenantDeviceFirst(device, ownershipIndex, user.id)) {
      return true;
    }

    if (isOwnedByAnotherTenantDeviceFirst(device, ownershipIndex, user.id)) {
      return false;
    }

    if (hasTenantLabel) {
      const ownerFromName = inferTenantOwnerFromTechnicalName(device.name);
      if (ownerFromName !== user.id) return false;
    }

    return hasAreaAccess(
      sourceAreaByEntity.get(device.entityId) ??
        device.sourceAreaName ??
        displayAreaByEntity.get(device.entityId) ??
        device.displayAreaName ??
        device.areaName ??
        device.area
    );
  });

  const allowedDeviceIds = new Set(
    finalResult
      .map((d) => (d.deviceId ?? '').toString().trim())
      .filter((v) => v.length > 0)
  );

  if (allowedDeviceIds.size > 0) {
    const merged = new Map(finalResult.map((d) => [d.entityId, d]));
    for (const device of devices) {
      if (isIgnoredDashboardHelperEntity(device)) continue;

      const deviceId = (device.deviceId ?? '').toString().trim();
      if (!deviceId || !allowedDeviceIds.has(deviceId)) continue;
      const pending =
        ownershipIndex.pendingDeviceIds.has(deviceId) ||
        ownershipIndex.pendingEntityIds.has(device.entityId);
      if (pending) continue;
      if (isOwnedByTenantDeviceFirst(device, ownershipIndex, user.id)) {
        merged.set(device.entityId, device);
        continue;
      }
      if (isOwnedByAnotherTenantDeviceFirst(device, ownershipIndex, user.id)) {
        continue;
      }
      const rawLabels = device.technicalLabels ?? device.labels ?? [];
      if (hasTenantDeviceLabelValue(rawLabels)) continue;
      merged.set(device.entityId, device);
    }
    finalResult = Array.from(merged.values());
  }

  return finalResult;
}

type VisibilityResult = {
  visible: boolean;
  surface: 'devices' | 'trigger_devices' | null;
  matchedDeviceId: string | null;
  matchedEntityId: string | null;
};

function hasMatch(args: {
  deviceIdSet: Set<string>;
  entityIdSet: Set<string>;
  deviceId?: string | null;
  entityId?: string | null;
  fallbackId?: string | null;
}) {
  const { deviceIdSet, entityIdSet, deviceId, entityId, fallbackId } = args;
  const normalizedDeviceId = normalizeId(deviceId ?? fallbackId);
  const normalizedEntityId = normalizeId(entityId);
  return (
    (normalizedDeviceId && deviceIdSet.has(normalizedDeviceId)) ||
    (normalizedEntityId && entityIdSet.has(normalizedEntityId))
  );
}

export async function checkCommissionedDeviceVisibility(args: {
  userId: number;
  newDeviceIds: string[];
  newEntityIds: string[];
  fresh?: boolean;
}): Promise<VisibilityResult> {
  const deviceIdSet = new Set(args.newDeviceIds.map(normalizeId).filter(Boolean));
  const entityIdSet = new Set(args.newEntityIds.map(normalizeId).filter(Boolean));

  const bootstrap = await getTenantInventoryBootstrap(args.userId, {
    fresh: args.fresh === true,
  });
  const visibleDevices = buildTenantVisibleDevicesFromBootstrap(bootstrap);
  const dashboardDevices = getTenantDashboardDevices(visibleDevices);
  const matchedDashboardDevice = dashboardDevices.find((device) =>
    hasMatch({
      deviceIdSet,
      entityIdSet,
      deviceId: device.deviceId,
      entityId: device.entityId,
    })
  );
  if (matchedDashboardDevice) {
    return {
      visible: true,
      surface: 'devices',
      matchedDeviceId: normalize(matchedDashboardDevice.deviceId) || null,
      matchedEntityId: normalize(matchedDashboardDevice.entityId) || null,
    };
  }

  try {
    const triggerContext = await getTriggerDeviceDashboardContextForTenant({
      userId: args.userId,
      fresh: args.fresh === true,
      includeTargetOptions: false,
    });
    const matchedTriggerDevice = triggerContext.triggerDevices.find((device) =>
      hasMatch({
        deviceIdSet,
        entityIdSet,
        deviceId: device.deviceId ?? device.triggerDeviceId,
        entityId: device.entityId,
        fallbackId: device.triggerDeviceId,
      })
    );
    if (matchedTriggerDevice) {
      return {
        visible: true,
        surface: 'trigger_devices',
        matchedDeviceId:
          normalize(matchedTriggerDevice.deviceId ?? matchedTriggerDevice.triggerDeviceId) || null,
        matchedEntityId: normalize(matchedTriggerDevice.entityId) || null,
      };
    }
  } catch {
    // Trigger visibility is best-effort here; normal dashboard visibility already checked first.
  }

  return {
    visible: false,
    surface: null,
    matchedDeviceId: null,
    matchedEntityId: null,
  };
}

export async function waitForCommissionedDeviceVisibility(args: {
  userId: number;
  newDeviceIds: string[];
  newEntityIds: string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<VisibilityResult> {
  const timeoutMs = Math.max(1_000, args.timeoutMs ?? 10_000);
  const pollIntervalMs = Math.max(250, args.pollIntervalMs ?? 750);
  const deadline = Date.now() + timeoutMs;

  let lastResult: VisibilityResult = {
    visible: false,
    surface: null,
    matchedDeviceId: null,
    matchedEntityId: null,
  };

  while (Date.now() <= deadline) {
    lastResult = await checkCommissionedDeviceVisibility({
      userId: args.userId,
      newDeviceIds: args.newDeviceIds,
      newEntityIds: args.newEntityIds,
      fresh: true,
    });
    if (lastResult.visible) {
      return lastResult;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return lastResult;
}

export async function checkTenantDeviceAbsence(args: {
  userId: number;
  removedDeviceIds: string[];
  removedEntityIds: string[];
  fresh?: boolean;
}): Promise<{ absent: boolean }> {
  const deviceIdSet = new Set(args.removedDeviceIds.map(normalizeId).filter(Boolean));
  const entityIdSet = new Set(args.removedEntityIds.map(normalizeId).filter(Boolean));

  const bootstrap = await getTenantInventoryBootstrap(args.userId, {
    fresh: args.fresh === true,
  });
  const visibleDevices = buildTenantVisibleDevicesFromBootstrap(bootstrap);
  const dashboardDevices = getTenantDashboardDevices(visibleDevices);
  if (
    dashboardDevices.some((device) =>
      hasMatch({
        deviceIdSet,
        entityIdSet,
        deviceId: device.deviceId,
        entityId: device.entityId,
      })
    )
  ) {
    return { absent: false };
  }

  try {
    const triggerContext = await getTriggerDeviceDashboardContextForTenant({
      userId: args.userId,
      fresh: args.fresh === true,
      includeTargetOptions: false,
    });
    if (
      triggerContext.triggerDevices.some((device) =>
        hasMatch({
          deviceIdSet,
          entityIdSet,
          deviceId: device.deviceId ?? device.triggerDeviceId,
          entityId: device.entityId,
          fallbackId: device.triggerDeviceId,
        })
      )
    ) {
      return { absent: false };
    }
  } catch {
    return { absent: false };
  }

  return { absent: true };
}

export async function waitForTenantDeviceAbsence(args: {
  userId: number;
  removedDeviceIds: string[];
  removedEntityIds: string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ absent: boolean }> {
  const timeoutMs = Math.max(1_000, args.timeoutMs ?? 10_000);
  const pollIntervalMs = Math.max(250, args.pollIntervalMs ?? 750);
  const deadline = Date.now() + timeoutMs;
  let lastResult = { absent: false };

  while (Date.now() <= deadline) {
    lastResult = await checkTenantDeviceAbsence({
      userId: args.userId,
      removedDeviceIds: args.removedDeviceIds,
      removedEntityIds: args.removedEntityIds,
      fresh: true,
    });
    if (lastResult.absent) {
      return lastResult;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return lastResult;
}
