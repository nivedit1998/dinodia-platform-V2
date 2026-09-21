// Architecture: Shared platform helper src/lib/haServiceBypass.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import crypto from 'crypto';

const SERVICE_ID = process.env.HA_SERVICE_BYPASS_ID || 'dinodia-platform';

function getSecret() {
  const secret = process.env.HA_SERVICE_BYPASS_SECRET;
  if (!secret) {
    throw new Error('HA_SERVICE_BYPASS_SECRET not set');
  }
  return secret;
}

function sha256(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildCanonicalString(input: {
  method: string;
  url: string;
  timestamp: string;
  bodyHash?: string | null;
}) {
  const parsed = new URL(input.url);
  return [
    input.method.toUpperCase(),
    parsed.host,
    parsed.pathname,
    parsed.search,
    input.timestamp,
    input.bodyHash ?? '',
  ].join('\n');
}

export function signHaServiceBypassRequest(input: {
  method: string;
  url: string;
  body?: string | null;
}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = input.body ? sha256(input.body) : '';
  const canonical = buildCanonicalString({
    method: input.method,
    url: input.url,
    timestamp,
    bodyHash,
  });
  const signature = crypto.createHmac('sha256', getSecret()).update(canonical, 'utf8').digest('hex');
  return {
    serviceId: SERVICE_ID,
    timestamp,
    signature,
  };
}

export function buildHaServiceBypassHeaders(input: {
  method: string;
  url: string;
  body?: string | null;
}) {
  const signed = signHaServiceBypassRequest(input);
  return {
    'x-dinodia-service-id': signed.serviceId,
    'x-dinodia-service-timestamp': signed.timestamp,
    'x-dinodia-service-signature': signed.signature,
  };
}

export function buildHaWebSocketBypassHeaders(url: string) {
  return buildHaServiceBypassHeaders({
    method: 'GET',
    url,
  });
}
