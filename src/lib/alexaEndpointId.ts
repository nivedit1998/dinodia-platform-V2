// Architecture: Shared platform helper src/lib/alexaEndpointId.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
const ENDPOINT_ID_PREFIX = 'ha_';

function base64UrlEncode(value: string): string {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isValidHaEntityId(value: string): boolean {
  return /^([a-zA-Z0-9_]+)\.([a-zA-Z0-9_-]+)$/.test(value);
}

export function encodeAlexaEndpointIdFromEntityId(entityId: string): string {
  return `${ENDPOINT_ID_PREFIX}${base64UrlEncode(entityId)}`;
}

export function normalizeAlexaEndpointId(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  if (raw.startsWith(ENDPOINT_ID_PREFIX)) return raw;
  if (isValidHaEntityId(raw)) return encodeAlexaEndpointIdFromEntityId(raw);
  // If we ever get a non-HA id, still keep it stable and Alexa-safe.
  return `${ENDPOINT_ID_PREFIX}${base64UrlEncode(raw)}`;
}
