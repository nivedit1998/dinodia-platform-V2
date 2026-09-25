import { NextResponse } from 'next/server';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

/**
 * Return only the installation-bound Cloudflare reservation to the paired hub.
 * The browser never supplies or chooses these values in production.  The hub
 * asks for them over its authenticated outbound channel immediately before
 * opening the local Connect Cloudflare ceremony.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { allowIdentity: true });
    if (!hub.installation.reservedHostname || !hub.installation.reservedTunnelName) throw new Stage1AuthError(409, 'cloudflare_reservation_missing', 'The installation has no reserved Cloudflare identity');
    return NextResponse.json({
      ok: true,
      reservedHostname: hub.installation.reservedHostname,
      reservedTunnelName: hub.installation.reservedTunnelName,
      tunnelId: hub.installation.cloudflareTunnelId,
      reservationToken: hub.installation.cloudflareReservationToken,
    }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
