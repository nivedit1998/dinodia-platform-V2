// Architecture: public Alexa-native state-report boundary backed by the latest signed hub projection.
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { resolveAlexaAuthUser } from '@/app/api/alexa/auth';
import { getNativeAlexaContext, toAlexaContextProperties } from '@/lib/alexaNativeProjection';
import { checkRateLimit } from '@/lib/rateLimit';
import { getPublishedHubTokenPlaintext } from '@/lib/hubTokens';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const authUser = await resolveAlexaAuthUser(req);
  if (!authUser) return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  if (!(await checkRateLimit(`alexa-native-report-state:${authUser.id}`, { maxRequests: 60, windowMs: 60_000 }))) return NextResponse.json({ error: 'Slow down. Please retry state reports shortly.' }, { status: 429 });
  const body = await req.json().catch(() => null);
  const directive = body?.directive || body;
  try {
    const context = await getNativeAlexaContext(authUser.id);
    const endpointId = directive?.endpoint?.endpointId;
    const endpoint = context.endpoints.find((item) => item.endpointId === endpointId);
    if (!endpoint) return NextResponse.json({ error: 'Endpoint is no longer available.' }, { status: 404 });
    let properties = toAlexaContextProperties(endpoint);
    const stateAgeMs = Date.now() - endpoint.sourceUpdatedAt.getTime();
    if (stateAgeMs > 120_000) {
      const home = await prisma.home.findUnique({ where: { id: context.user.homeId! }, select: { haConnection: { select: { cloudUrl: true, baseUrl: true } }, hubInstall: { select: { id: true, publishedHubTokenVersion: true } } } });
      const baseUrl = home?.haConnection.cloudUrl?.trim() || home?.haConnection.baseUrl?.trim();
      if (!baseUrl || !home?.hubInstall) return NextResponse.json({ error: 'Dinodia OS is not reachable for this home.' }, { status: 503 });
      const token = await getPublishedHubTokenPlaintext(home.hubInstall.id, home.hubInstall.publishedHubTokenVersion);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const remote = await fetch(`${baseUrl.replace(/\/$/, '')}/_dinodia/platform/v1/alexa/state?endpointId=${encodeURIComponent(endpointId)}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
        const payload = await remote.json().catch(() => ({})) as { state?: unknown };
        if (!remote.ok) return NextResponse.json({ error: 'Dinodia OS state is unavailable.' }, { status: 503 });
        if (!Array.isArray(payload.state)) return NextResponse.json({ error: 'Dinodia OS state is unavailable.' }, { status: 503 });
        properties = payload.state;
      } catch {
        return NextResponse.json({ error: 'Dinodia OS state is unavailable.' }, { status: 503 });
      } finally {
        clearTimeout(timeout);
      }
    }
    return NextResponse.json({ context: { properties }, event: { header: { namespace: 'Alexa', name: 'StateReport', messageId: randomUUID(), payloadVersion: '3' }, endpoint: { endpointId: endpoint.endpointId }, payload: {} } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Native Alexa state report is unavailable.' }, { status: Number((error as { statusCode?: number })?.statusCode || 500) });
  }
}
