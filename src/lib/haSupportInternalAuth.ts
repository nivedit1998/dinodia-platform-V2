// Architecture: Shared platform helper src/lib/haSupportInternalAuth.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import crypto from 'crypto';
import { NextRequest } from 'next/server';

export function getHaSupportInternalSecret() {
  const secret = process.env.HA_SUPPORT_INTERNAL_SECRET;
  if (!secret) {
    throw new Error('HA_SUPPORT_INTERNAL_SECRET not set');
  }
  return secret;
}

export function isValidHaSupportInternalRequest(req: NextRequest) {
  const provided = req.headers.get('x-dinodia-ha-support-secret');
  if (!provided) return false;
  const expected = getHaSupportInternalSecret();
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
