// Architecture: Shared platform helper src/lib/displayNormalization.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export function normalizeDisplayText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function normalizeLookupKey(value: unknown): string {
  return normalizeDisplayText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugifyHaTechnicalName(value: unknown): string {
  const slug = normalizeDisplayText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'device';
}

export function buildTenantHaTechnicalName(userId: number, displayName: string): string {
  return `${Number(userId)}_${slugifyHaTechnicalName(displayName)}`;
}

export function stripTenantHaTechnicalPrefix(userId: number, haName: string): string {
  const prefix = `${Number(userId)}_`;
  const normalized = normalizeDisplayText(haName);
  if (!normalized.toLowerCase().startsWith(prefix)) return normalized;
  return normalized
    .slice(prefix.length)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
