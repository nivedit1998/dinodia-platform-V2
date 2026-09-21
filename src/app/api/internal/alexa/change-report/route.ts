// Architecture: API boundary /internal/alexa/change-report; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
// Architecture boundary: internal platform route used to turn device changes
// into Alexa ChangeReport events. Device-control/monitoring callers reach this
// server-side flow; the Alexa skill consumes discovery/control separately.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveHaCloudFirst } from '@/lib/haConnection';
import { resolveHaLongLivedToken } from '@/lib/haSecrets';
import { fetchHaState } from '@/lib/homeAssistant';
import { buildAlexaPropertiesForDevice, type AlexaProperty } from '@/lib/alexaProperties';
import { sendAlexaChangeReportForHaConnection } from '@/lib/alexaEvents';

type AlexaChangeReportCause =
  | 'PHYSICAL_INTERACTION'
  | 'APP_INTERACTION'
  | 'VOICE_INTERACTION'
  | 'PERIODIC_POLL'
  | 'RULE_TRIGGER';

function getBearerToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function haveAlexaPropertiesChanged(prev: AlexaProperty[], next: AlexaProperty[]) {
  if (prev.length !== next.length) return true;
  const normalize = (props: AlexaProperty[]) =>
    props.map((prop) => ({
      namespace: prop.namespace,
      name: prop.name,
      instance: prop.instance ?? null,
      value: prop.value,
    }));
  return JSON.stringify(normalize(prev)) !== JSON.stringify(normalize(next));
}

function isAlexaProperty(value: unknown): value is AlexaProperty {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.namespace === 'string' && typeof obj.name === 'string' && 'value' in obj;
}

function coerceAlexaChangeReportCause(value: unknown): AlexaChangeReportCause {
  const raw = typeof value === 'string' ? value.trim() : '';
  switch (raw) {
    case 'APP_INTERACTION':
    case 'VOICE_INTERACTION':
    case 'PERIODIC_POLL':
    case 'RULE_TRIGGER':
    case 'PHYSICAL_INTERACTION':
      return raw;
    default:
      return 'PHYSICAL_INTERACTION';
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.ALEXA_CHANGE_REPORT_INTERNAL_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }

  const token = getBearerToken(req);
  if (token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const obj = body as Record<string, unknown>;
  const haConnectionId = typeof obj.haConnectionId === 'number' ? obj.haConnectionId : null;
  const entityId = typeof obj.entityId === 'string' ? obj.entityId.trim() : '';
  const label = typeof obj.label === 'string' ? obj.label.trim() : '';
  const causeType: AlexaChangeReportCause = coerceAlexaChangeReportCause(obj.causeType);
  const previousProperties = Array.isArray(obj.previousProperties)
    ? obj.previousProperties.filter(isAlexaProperty)
    : [];

  if (!haConnectionId || !entityId || !label) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  const haConnection = await prisma.haConnection.findUnique({
    where: { id: haConnectionId },
    select: {
      id: true,
      baseUrl: true,
      cloudUrl: true,
      longLivedToken: true,
      longLivedTokenCiphertext: true,
    },
  });
  if (!haConnection) {
    return NextResponse.json({ error: 'haConnection not found' }, { status: 404 });
  }

  const secrets = resolveHaLongLivedToken(haConnection);
  const effectiveHa = resolveHaCloudFirst({ ...haConnection, ...secrets });

  const state = await fetchHaState(effectiveHa, entityId);
  const attrs = (state.attributes ?? {}) as Record<string, unknown>;
  const nextProperties = buildAlexaPropertiesForDevice(
    {
      entityId,
      state: String(state.state ?? ''),
      attributes: attrs,
      label,
      domain: entityId.split('.')[0] ?? '',
    },
    label
  );

  if (nextProperties.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'no_properties' });
  }

  if (previousProperties.length > 0 && !haveAlexaPropertiesChanged(previousProperties, nextProperties)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'unchanged' });
  }

  await sendAlexaChangeReportForHaConnection(haConnectionId, entityId, nextProperties, causeType);
  return NextResponse.json({ ok: true });
}
