// Architecture: Shared platform helper src/lib/tenantInventoryClient.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
'use client';

import type { UIDevice } from '@/types/device';
import type { TriggerDeviceSummary, TriggerTargetOption } from '@/types/triggerDevice';
import { platformFetchJson } from '@/lib/platformFetchClient';

const TENANT_INVENTORY_TTL_MS = 15_000;

export type TenantInventorySnapshot = {
  devices: UIDevice[];
  triggerDevices: TriggerDeviceSummary[];
  previewTriggerDevices: TriggerDeviceSummary[];
  acceptedTriggerDeviceIds: string[];
  targetOptions: TriggerTargetOption[];
  loadedAt: number;
};

type CacheEntry = {
  snapshot: TenantInventorySnapshot | null;
  inFlight: Promise<TenantInventorySnapshot> | null;
};

const cache: CacheEntry = {
  snapshot: null,
  inFlight: null,
};

function isFresh(snapshot: TenantInventorySnapshot | null) {
  if (!snapshot) return false;
  return Date.now() - snapshot.loadedAt <= TENANT_INVENTORY_TTL_MS;
}

async function fetchTenantInventoryFromApi(force = false): Promise<TenantInventorySnapshot> {
  const devicesEndpoint = force
    ? '/api/devices?fresh=1&include_services_for_target=1'
    : '/api/devices?include_services_for_target=1';
  const triggerEndpoint = force ? '/api/trigger-devices?fresh=1' : '/api/trigger-devices';

  const [devicesPayload, triggerPayload] = await Promise.all([
    platformFetchJson<{
      devices?: UIDevice[];
      triggerDevicesPreview?: TriggerDeviceSummary[];
      acceptedTriggerDeviceIds?: string[];
    }>(
      devicesEndpoint,
      { credentials: 'include' },
      'We couldn’t load your devices. Please check your connection and try again.'
    ),
    platformFetchJson<{
      triggerDevices?: TriggerDeviceSummary[];
      targetOptions?: TriggerTargetOption[];
      degraded?: boolean;
      targetOptionsReady?: boolean;
    }>(
      triggerEndpoint,
      { credentials: 'include' },
      'We couldn’t load your trigger devices. Please check your connection and try again.'
    ),
  ]);

  const snapshot: TenantInventorySnapshot = {
    devices: Array.isArray(devicesPayload.devices) ? devicesPayload.devices : [],
    previewTriggerDevices: Array.isArray(devicesPayload.triggerDevicesPreview)
      ? devicesPayload.triggerDevicesPreview
      : [],
    acceptedTriggerDeviceIds: Array.isArray(devicesPayload.acceptedTriggerDeviceIds)
      ? devicesPayload.acceptedTriggerDeviceIds
      : [],
    triggerDevices:
      triggerPayload.degraded === true && triggerPayload.targetOptionsReady === false
        ? cache.snapshot?.triggerDevices ?? []
        : Array.isArray(triggerPayload.triggerDevices)
          ? triggerPayload.triggerDevices
          : [],
    targetOptions:
      triggerPayload.degraded === true && triggerPayload.targetOptionsReady === false
        ? cache.snapshot?.targetOptions ?? []
        : Array.isArray(triggerPayload.targetOptions)
          ? triggerPayload.targetOptions
          : [],
    loadedAt: Date.now(),
  };

  cache.snapshot = snapshot;
  return snapshot;
}

export function peekTenantInventorySnapshot() {
  return cache.snapshot;
}

export function invalidateTenantInventorySnapshot() {
  cache.snapshot = null;
}

export async function fetchTenantInventorySnapshot(opts?: {
  force?: boolean;
  preferWarm?: boolean;
}) {
  const force = opts?.force === true;
  const preferWarm = opts?.preferWarm !== false;

  if (!force && preferWarm && isFresh(cache.snapshot)) {
    return cache.snapshot as TenantInventorySnapshot;
  }

  if (!force && cache.inFlight) {
    return cache.inFlight;
  }

  const promise = fetchTenantInventoryFromApi(force).finally(() => {
    if (cache.inFlight === promise) {
      cache.inFlight = null;
    }
  });

  cache.inFlight = promise;
  return promise;
}
