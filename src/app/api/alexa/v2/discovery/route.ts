// Architecture: public Alexa-native discovery boundary. Legacy /api/alexa/devices remains untouched for HA homes.
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { resolveAlexaAuthUser } from '@/app/api/alexa/auth';
import { getNativeAlexaContext, toAlexaDiscoveryEndpoint } from '@/lib/alexaNativeProjection';
import { checkRateLimit } from '@/lib/rateLimit';

function response(endpoints: unknown[]) {
  return NextResponse.json({ event: { header: { namespace: 'Alexa.Discovery', name: 'Discover.Response', messageId: randomUUID(), payloadVersion: '3' }, payload: { endpoints } } });
}

export async function GET(req: NextRequest) {
  const authUser = await resolveAlexaAuthUser(req);
  if (!authUser) return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  if (!(await checkRateLimit(`alexa-native-discovery:${authUser.id}`, { maxRequests: 20, windowMs: 60_000 }))) return NextResponse.json({ error: 'Slow down. Please retry discovery shortly.' }, { status: 429 });
  try {
    const context = await getNativeAlexaContext(authUser.id);
    return response(context.endpoints.map(toAlexaDiscoveryEndpoint));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Native Alexa discovery is unavailable.' }, { status: Number((error as { statusCode?: number })?.statusCode || 500) });
  }
}

export const POST = GET;
