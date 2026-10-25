import { randomUUID } from 'node:crypto';

/** Explicit, fail-closed Stage boundary for contract paths whose product service is owned by a later stage. */
export function nativeFeatureNotEnabled(feature: string): Response {
  return Response.json({
    error: {
      code: 'FEATURE_NOT_ENABLED',
      message: `${feature} is not enabled in this release stage. No legacy or static fallback is available.`,
      requestId: randomUUID(),
      retryable: false,
    },
  }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
}
