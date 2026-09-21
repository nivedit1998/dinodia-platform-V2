// Architecture: Shared platform helper src/lib/requestLog.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { NextRequest } from 'next/server';
import { classifyUserAgent, hashForLog, sanitizeLogPayload } from '@/lib/safeLogger';

type Extra = Record<string, unknown>;

/**
 * Lightweight structured log for CloudWatch/Edge to attribute API traffic by route.
 * Avoids sensitive data; focuses on request metadata useful for volume baselines.
 */
export function logApiHit(req: NextRequest, route: string, extra: Extra = {}): void {
  try {
    const forwardedFor = req.headers.get('x-forwarded-for');
    const clientIp = forwardedFor ? forwardedFor.split(',')[0]?.trim() || null : null;
    const entry = {
      msg: 'api_hit',
      route,
      method: req.method,
      path: req.nextUrl.pathname,
      ipHash: hashForLog(clientIp),
      deviceIdHash: hashForLog(req.headers.get('x-device-id')),
      hasDeviceLabel: Boolean(req.headers.get('x-device-label')),
      userAgentFamily: classifyUserAgent(req.headers.get('user-agent')),
      ts: new Date().toISOString(),
      ...sanitizeLogPayload(extra),
    };
    console.log(JSON.stringify(entry));
  } catch {
    // never throw from logging
  }
}
