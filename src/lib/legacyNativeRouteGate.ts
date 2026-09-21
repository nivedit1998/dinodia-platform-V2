import { NextResponse } from 'next/server';

/**
 * Legacy Home Assistant/bootstrap routes remain in the repository only as
 * historical compatibility source. They must not be reachable in a native
 * Dinodia OS production deployment. Stage 1 deliberately does not delete the
 * source because later migration stages own that cleanup.
 */
export function legacyNativeRouteDisabled(): NextResponse | null {
  if (process.env.NODE_ENV !== 'production') return null;
  return NextResponse.json(
    {
      ok: false,
      errorCode: 'LEGACY_ROUTE_DISABLED',
      error: 'This legacy route is disabled in native Dinodia OS production.',
    },
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}
