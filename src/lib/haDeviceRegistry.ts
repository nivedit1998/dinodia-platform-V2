// Architecture: Shared platform helper src/lib/haDeviceRegistry.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { HaWsClient } from '@/lib/haWebSocket';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { hashForLog, safeLog } from '@/lib/safeLogger';

export async function renameHaDevicesForTenantDevice(
  ha: HaConnectionLike,
  deviceIds: string[],
  haTechnicalName: string
): Promise<{ ok: boolean; warning?: string }> {
  const targets = Array.from(new Set(deviceIds.map((id) => id.trim()).filter(Boolean)));
  if (!haTechnicalName.trim() || targets.length === 0) return { ok: true };

  const client = await HaWsClient.connect(ha);
  const errors: string[] = [];
  try {
    for (const deviceId of targets) {
      try {
        await client.call('config/device_registry/update', {
          device_id: deviceId,
          name_by_user: haTechnicalName,
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        safeLog('warn', '[haDeviceRegistry] Failed tenant device rename', {
          deviceIdHash: hashForLog(deviceId),
          err,
        });
      }
    }
  } finally {
    client.close();
  }

  return {
    ok: errors.length === 0,
    warning: errors.length > 0 ? errors.join('; ') : undefined,
  };
}
