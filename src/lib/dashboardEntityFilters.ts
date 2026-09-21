// Architecture: Shared platform helper src/lib/dashboardEntityFilters.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import type { UIDevice } from '@/types/device';

export type DashboardEntityLike = Pick<UIDevice, 'entityId' | 'domain' | 'attributes'>;

const IGNORED_BUTTON_TOKENS = new Set([
  'identify',
  'identify_button',
  'locate',
  'ping',
  'find',
  'find_my',
  'diagnostic',
]);

const PASSIVE_HELPER_DEVICE_CLASSES = new Set([
  'battery',
  'signal_strength',
  'voltage',
  'current',
  'power_factor',
  'linkquality',
  'rssi',
  'lqi',
  'last_seen',
  'timestamp',
  'enum',
  'connectivity',
  'problem',
  'update',
]);

const PASSIVE_HELPER_TOKENS = new Set([
  'battery',
  'linkquality',
  'lqi',
  'rssi',
  'last_seen',
  'last_seen_time',
  'voltage',
  'signal_strength',
]);

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function domainOf(device: DashboardEntityLike): string {
  return normalizeToken(device.domain || String(device.entityId || '').split('.')[0]);
}

function attr(device: DashboardEntityLike, key: string): unknown {
  return (device.attributes ?? {})[key];
}

function tokenMatches(text: string, token: string): boolean {
  const normalized = normalizeToken(text);
  const target = normalizeToken(token);
  if (!normalized || !target) return false;
  return (
    normalized === target ||
    normalized.startsWith(`${target}_`) ||
    normalized.endsWith(`_${target}`) ||
    normalized.includes(`_${target}_`)
  );
}

function technicalClassificationText(device: DashboardEntityLike): string {
  return [
    device.entityId,
    device.domain,
    attr(device, 'device_class'),
    attr(device, 'original_device_class'),
    attr(device, 'entity_category'),
  ]
    .map(normalizeToken)
    .filter(Boolean)
    .join('_');
}

export function isIgnoredDashboardHelperEntity(device: DashboardEntityLike): boolean {
  const domain = domainOf(device);
  const entityCategory = normalizeToken(attr(device, 'entity_category'));
  const deviceClass = normalizeToken(attr(device, 'device_class') ?? attr(device, 'original_device_class'));
  const classification = technicalClassificationText(device);

  if (entityCategory === 'diagnostic') return true;

  if (domain === 'button') {
    if (deviceClass === 'identify') return true;
    return [...IGNORED_BUTTON_TOKENS].some((token) => tokenMatches(classification, token));
  }

  if (domain === 'sensor' || domain === 'binary_sensor' || domain === 'event') {
    if (PASSIVE_HELPER_DEVICE_CLASSES.has(deviceClass)) return true;
    return [...PASSIVE_HELPER_TOKENS].some((token) => tokenMatches(classification, token));
  }

  return false;
}

export function isBlockingButtonActionEntity(device: DashboardEntityLike): boolean {
  if (domainOf(device) !== 'button') return false;
  if (isIgnoredDashboardHelperEntity(device)) return false;

  // Conservative by design: any non-helper button can cause a real side effect.
  return true;
}

export function isNormalDashboardCardEntity(device: DashboardEntityLike): boolean {
  return !isIgnoredDashboardHelperEntity(device);
}
