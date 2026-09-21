// Architecture: public Alexa-native directive boundary. Authorization and home/area access are checked before forwarding to the hub.
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { resolveAlexaAuthUser } from '@/app/api/alexa/auth';
import { getNativeAlexaContext } from '@/lib/alexaNativeProjection';
import { getPublishedHubTokenPlaintext } from '@/lib/hubTokens';
import { checkRateLimit } from '@/lib/rateLimit';
import { prisma } from '@/lib/prisma';

type AlexaDirective = { header?: { namespace?: string; messageId?: string }; endpoint?: { endpointId?: string }; payload?: unknown };

function responseFor(directive: AlexaDirective, endpointId: string, properties: unknown[]) {
  return { context: { properties }, event: { header: { namespace: directive?.header?.namespace || 'Alexa', name: 'Response', messageId: randomUUID(), payloadVersion: '3' }, endpoint: { endpointId }, payload: {} } };
}

export async function POST(req: NextRequest) {
  const authUser = await resolveAlexaAuthUser(req);
  if (!authUser) return NextResponse.json({ error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  if (!(await checkRateLimit(`alexa-native-directive:${authUser.id}`, { maxRequests: 60, windowMs: 60_000 }))) return NextResponse.json({ error: 'Slow down. Please retry shortly.' }, { status: 429 });
  const body = await req.json().catch(() => null);
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const directive = (raw.directive && typeof raw.directive === 'object' ? raw.directive : raw) as AlexaDirective;
  try {
    const context = await getNativeAlexaContext(authUser.id);
    const messageId = typeof directive?.header?.messageId === 'string' ? directive.header.messageId.slice(0, 180) : '';
    const messageIdHash = messageId ? createHash('sha256').update(messageId).digest('hex') : '';
    if (messageIdHash) {
      const prior = await prisma.alexaDirectiveReceipt.findUnique({ where: { messageIdHash } });
      if (prior?.status === 'COMPLETED' && prior.response) return NextResponse.json(prior.response);
      if (prior?.status === 'PENDING' && prior.expiresAt > new Date()) return NextResponse.json({ error: 'This directive is already being processed.' }, { status: 409 });
    }
    const endpointId = typeof directive?.endpoint?.endpointId === 'string' ? directive.endpoint.endpointId : '';
    const endpoint = context.endpoints.find((item) => item.endpointId === endpointId);
    if (!endpoint) return NextResponse.json({ error: 'Endpoint is not available to this account.' }, { status: 404 });
    if (messageIdHash) {
      try {
        await prisma.alexaDirectiveReceipt.create({ data: { messageIdHash, userId: authUser.id, homeId: context.user.homeId!, endpointId, status: 'PENDING', expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
      } catch (error) {
        if ((error as { code?: string })?.code !== 'P2002') throw error;
        const concurrent = await prisma.alexaDirectiveReceipt.findUnique({ where: { messageIdHash } });
        if (concurrent?.status === 'COMPLETED' && concurrent.response) return NextResponse.json(concurrent.response);
        return NextResponse.json({ error: 'This directive is already being processed.' }, { status: 409 });
      }
    }
    const home = await prisma.home.findUnique({ where: { id: context.user.homeId! }, select: { haConnection: { select: { cloudUrl: true, baseUrl: true } }, hubInstall: { select: { id: true, publishedHubTokenVersion: true } } } });
    const baseUrl = home?.haConnection.cloudUrl?.trim() || home?.haConnection.baseUrl?.trim();
    if (!baseUrl || !home?.hubInstall) return NextResponse.json({ error: 'Dinodia OS is not reachable for this home.' }, { status: 503 });
    const token = await getPublishedHubTokenPlaintext(home.hubInstall.id, home.hubInstall.publishedHubTokenVersion);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    let result: Record<string, unknown>;
    try {
      const remote = await fetch(`${baseUrl.replace(/\/$/, '')}/_dinodia/platform/v1/alexa/directives`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(directive), signal: controller.signal });
      result = await remote.json().catch(() => ({})) as Record<string, unknown>;
      if (!remote.ok) return NextResponse.json({ error: typeof result.error === 'string' ? result.error : 'Dinodia OS rejected this Alexa directive.' }, { status: remote.status >= 500 ? 503 : remote.status });
    } finally {
      clearTimeout(timeout);
    }
    const response = responseFor(directive, endpointId, Array.isArray(result.state) ? result.state : []);
    if (messageIdHash) await prisma.alexaDirectiveReceipt.update({ where: { messageIdHash }, data: { status: 'COMPLETED', response: JSON.parse(JSON.stringify(response)) } });
    return NextResponse.json(response);
  } catch (error) {
    const messageId = typeof directive?.header?.messageId === 'string' ? directive.header.messageId.slice(0, 180) : '';
    if (messageId) await prisma.alexaDirectiveReceipt.updateMany({ where: { messageIdHash: createHash('sha256').update(messageId).digest('hex'), status: 'PENDING' }, data: { status: 'FAILED' } }).catch(() => {});
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Native Alexa directive failed.' }, { status: Number((error as { statusCode?: number })?.statusCode || 500) });
  }
}
