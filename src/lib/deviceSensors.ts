// Architecture: Shared platform helper src/lib/deviceSensors.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import type { UIDevice } from '@/types/device';

export function isDetailState(state: string) {
  const trimmed = (state ?? '').toString().trim();
  if (!trimmed) return false;
  const isUnavailable = trimmed.toLowerCase() === 'unavailable';
  const isNumeric = !Number.isNaN(Number(trimmed));
  return isUnavailable || isNumeric;
}

export function hasLabel(device: UIDevice) {
  const main = (device.label ?? '').toString().trim();
  const labels = Array.isArray(device.labels) ? device.labels : [];
  const mainIsReal = main.length > 0 && main.toLowerCase() !== 'sensor';
  const hasExtraReal = labels.some((lbl) => {
    const t = (lbl ?? '').toString().trim();
    return t.length > 0 && t.toLowerCase() !== 'sensor';
  });
  return mainIsReal || hasExtraReal;
}

export function isSensorEntity(device: UIDevice) {
  // Sensors: labelCategory Sensor/Motion Sensor OR any entity with numeric/unavailable detail-style states
  const category = (device.labelCategory ?? '').toString().trim().toLowerCase();
  if (category === 'sensor' || category === 'motion sensor') return true;
  return isDetailState(device.state);
}
