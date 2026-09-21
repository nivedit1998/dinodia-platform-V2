// Architecture: Shared platform helper src/lib/requestInfo.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { NextRequest } from 'next/server';

export function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const ip = xff.split(',')[0]?.trim();
    if (ip) return ip;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  try {
    // next/server req.ip can be undefined; fall back to socket remoteAddress is not available here.
    // @ts-expect-error - ip is not typed on NextRequest but can exist in some runtimes.
    if (req.ip && typeof req.ip === 'string') return req.ip;
  } catch {
    // ignore
  }
  return 'unknown';
}
