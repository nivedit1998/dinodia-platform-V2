// Architecture: Shared platform helper src/lib/haRegistrySnapshot.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { HaWsClient } from '@/lib/haWebSocket';
import type { HaConnectionLike } from '@/lib/homeAssistant';

export type RegistrySnapshot = {
  deviceIds: string[];
  entityIds: string[];
};

function filterIds(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function fetchRegistrySnapshot(ha: HaConnectionLike): Promise<RegistrySnapshot> {
  const client = await HaWsClient.connect(ha);
  try {
    const [devices, entities] = await Promise.all([
      client.call<Array<{ id?: string }>>('config/device_registry/list'),
      client.call<Array<{ entity_id?: string }>>('config/entity_registry/list'),
    ]);

    return {
      deviceIds: filterIds((devices ?? []).map((d) => d.id)),
      entityIds: filterIds((entities ?? []).map((e) => e.entity_id)),
    };
  } finally {
    client.close();
  }
}

export function diffRegistrySnapshots(
  before: RegistrySnapshot | null | undefined,
  after: RegistrySnapshot
): { newDeviceIds: string[]; newEntityIds: string[] } {
  const beforeDevices = new Set(before?.deviceIds ?? []);
  const beforeEntities = new Set(before?.entityIds ?? []);

  const newDeviceIds = after.deviceIds.filter((id) => !beforeDevices.has(id));
  const newEntityIds = after.entityIds.filter((id) => !beforeEntities.has(id));

  return { newDeviceIds, newEntityIds };
}
