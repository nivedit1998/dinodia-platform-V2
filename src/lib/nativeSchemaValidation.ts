const MAX_JSON_BYTES = 64 * 1024;

export function boundedJson(value: unknown, maximumBytes = MAX_JSON_BYTES): value is Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== 'object') return false;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes; }
  catch { return false; }
}

export function canonicalPublicId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function boundedCustomerLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError('Customer label must be a string or null');
  const normalized = value.normalize('NFC').trim();
  const length = [...normalized].length;
  if (length < 1 || length > 40 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new RangeError('Customer label must contain 1–40 printable characters');
  return normalized;
}

export function assertFutureExpiry(expiresAt: Date, now = new Date()): void {
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now) throw new RangeError('Expiry must be a valid future timestamp');
}
