// Architecture: Shared platform helper src/lib/alexaEvents.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { AlexaProperty } from '@/lib/alexaProperties';
import { normalizeAlexaEndpointId } from '@/lib/alexaEndpointId';
import { Role } from '@prisma/client';
import { getAlexaDiscoveryEndpointsForUser } from '@/lib/alexaDiscoveryEndpoints';
import { logServerError } from '@/lib/serverErrorLog';
import { hashForLog } from '@/lib/safeLogger';

type AlexaEventTokenPayload = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
};

type AlexaChangeReportCause =
  | 'PHYSICAL_INTERACTION'
  | 'APP_INTERACTION'
  | 'VOICE_INTERACTION'
  | 'PERIODIC_POLL'
  | 'RULE_TRIGGER';

type AlexaDiscoveryEndpoint = Record<string, unknown>;

function getGatewayEndpoint() {
  return process.env.ALEXA_EVENT_GATEWAY_ENDPOINT || 'https://api.amazonalexa.com/v3/events';
}

function getEventsClientCredentials() {
  const clientId = process.env.ALEXA_EVENTS_CLIENT_ID;
  const clientSecret = process.env.ALEXA_EVENTS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Alexa events client credentials are not configured');
  }
  return { clientId, clientSecret };
}

export async function exchangeAcceptGrantCode(
  code: string
): Promise<AlexaEventTokenPayload> {
  const { clientId, clientSecret } = getEventsClientCredentials();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    // Do not log the raw response body: OAuth errors can include sensitive details.
    logServerError('[alexaEvents] accept_grant_exchange_failed', new Error('AcceptGrant exchange failed'), {
      status: res.status,
    });
    throw new Error('Failed to exchange AcceptGrant code');
  }

  const data = await res.json();
  const now = Date.now();
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + expiresIn * 1000,
  };
}

export async function refreshAlexaEventToken(
  refreshToken: string
): Promise<AlexaEventTokenPayload> {
  const { clientId, clientSecret } = getEventsClientCredentials();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    // Do not log the raw response body: OAuth errors can include sensitive details.
    logServerError('[alexaEvents] refresh_token_failed', new Error('Token refresh failed'), {
      status: res.status,
    });
    throw new Error('Failed to refresh Alexa event token');
  }

  const data = await res.json();
  const now = Date.now();
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: now + expiresIn * 1000,
  };
}

export async function getAlexaEventAccessTokenForUser(userId: number): Promise<string> {
  let record = await prisma.alexaEventToken.findUnique({ where: { userId } });

  if (!record) {
    console.warn('[alexaEvents] No Event Gateway token for user', userId);
    throw new Error('No Alexa Event Gateway token for user');
  }

  const now = Date.now();
  if (record.expiresAt.getTime() - 5000 < now) {
    const refreshed = await refreshAlexaEventToken(record.refreshToken);
    record = await prisma.alexaEventToken.update({
      where: { userId },
      data: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(refreshed.expiresAt),
      },
    });
  }

  return record.accessToken;
}

export async function sendAlexaChangeReport(
  userId: number,
  endpointId: string,
  properties: AlexaProperty[],
  causeType: AlexaChangeReportCause = 'PHYSICAL_INTERACTION'
) {
  if (!endpointId) {
    console.warn('[alexaEvents] Missing endpointId for ChangeReport');
    return;
  }

  const normalizedEndpointId = normalizeAlexaEndpointId(endpointId);

  if (!properties || properties.length === 0) {
    console.warn('[alexaEvents] No properties provided for ChangeReport', normalizedEndpointId);
    return;
  }

  const gateway = getGatewayEndpoint();
  const token = await getAlexaEventAccessTokenForUser(userId);

  const namespaces = Array.from(new Set(properties.map((p) => p.namespace)));
  console.log('[alexaEvents] ChangeReport POST', {
    endpoint: gateway,
    endpointId: normalizedEndpointId,
    causeType,
    namespaces,
  });

  const changePayload = {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ChangeReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      endpoint: {
        endpointId: normalizedEndpointId,
      },
      payload: {
        change: {
          cause: {
            type: causeType,
          },
          properties,
        },
      },
    },
    context: {
      properties,
    },
  };

  const res = await fetch(gateway, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(changePayload),
  });

  console.log('[alexaEvents] ChangeReport response', {
    endpointIdHash: hashForLog(normalizedEndpointId),
    status: res.status,
    ok: res.ok,
  });

  if (!res.ok) {
    logServerError('[alexaEvents] change_report_failed', new Error('ChangeReport failed'), {
      endpointIdHash: hashForLog(normalizedEndpointId),
      status: res.status,
    });
    return;
  }

  console.log('[alexaEvents] ChangeReport sent', normalizedEndpointId, causeType);
}

export async function sendAlexaAddOrUpdateReport(userId: number, endpoints: AlexaDiscoveryEndpoint[]) {
  const normalizedEndpoints = (endpoints ?? [])
    .map((ep) => {
      if (!ep || typeof ep !== 'object') return null;
      const record = ep as Record<string, unknown>;
      const endpointId = record.endpointId;
      if (typeof endpointId !== 'string' || !endpointId.trim()) return null;
      return { ...record, endpointId: normalizeAlexaEndpointId(endpointId) } as AlexaDiscoveryEndpoint;
    })
    .filter(Boolean) as AlexaDiscoveryEndpoint[];

  if (normalizedEndpoints.length === 0) {
    return;
  }

  const gateway = getGatewayEndpoint();
  const token = await getAlexaEventAccessTokenForUser(userId);

  console.log('[alexaEvents] AddOrUpdateReport POST', {
    endpoint: gateway,
    endpointCount: normalizedEndpoints.length,
  });

  const payload = {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'AddOrUpdateReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      payload: {
        endpoints: normalizedEndpoints,
      },
    },
  };

  const res = await fetch(gateway, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('[alexaEvents] AddOrUpdateReport response', {
    status: res.status,
    ok: res.ok,
  });
  if (!res.ok) {
    logServerError('[alexaEvents] add_or_update_report_failed', new Error('AddOrUpdateReport failed'), {
      status: res.status,
    });
  }
}

export async function sendAlexaDeleteReport(userId: number, endpointIds: string[]) {
  const normalized = (endpointIds ?? [])
    .map((id) => (typeof id === 'string' ? normalizeAlexaEndpointId(id) : ''))
    .filter((id) => Boolean(id && id.trim()));

  if (normalized.length === 0) {
    return;
  }

  const gateway = getGatewayEndpoint();
  const token = await getAlexaEventAccessTokenForUser(userId);

  console.log('[alexaEvents] DeleteReport POST', {
    endpoint: gateway,
    endpointCount: normalized.length,
  });

  const payload = {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'DeleteReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      payload: {
        endpoints: normalized.map((endpointId) => ({ endpointId })),
      },
    },
  };

  const res = await fetch(gateway, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('[alexaEvents] DeleteReport response', {
    status: res.status,
    ok: res.ok,
  });
  if (!res.ok) {
    logServerError('[alexaEvents] delete_report_failed', new Error('DeleteReport failed'), {
      status: res.status,
    });
  }
}

export async function sendAlexaAddOrUpdateReportForHaConnection(args: {
  haConnectionId: number;
  restrictEntityIds?: string[] | null;
}) {
  const { haConnectionId, restrictEntityIds } = args;

  const users = await prisma.user.findMany({
    where: {
      role: Role.TENANT,
      home: { haConnectionId },
      alexaEventToken: { isNot: null },
      alexaRefreshTokens: { some: { revoked: false } },
    },
    select: { id: true },
  });

  if (users.length === 0) return;

  for (const { id: userId } of users) {
    try {
      const { endpoints } = await getAlexaDiscoveryEndpointsForUser({
        userId,
        restrictEntityIds: restrictEntityIds ?? null,
      });
      if (endpoints.length === 0) continue;
      await sendAlexaAddOrUpdateReport(userId, endpoints);
    } catch (err) {
      logServerError('[alexaEvents] add_or_update_report_fanout_failed', err, { haConnectionId, userId });
    }
  }
}

export async function sendAlexaChangeReportForHaConnection(
  haConnectionId: number,
  endpointId: string,
  properties: AlexaProperty[],
  causeType: AlexaChangeReportCause
) {
  try {
    const users = await prisma.user.findMany({
      where: {
        home: { haConnectionId },
        alexaEventToken: { isNot: null },
      },
      select: { id: true },
    });

    if (users.length === 0) {
      console.warn('[alexaEvents] No Alexa Event Gateway users for haConnection', {
        haConnectionId,
        endpointId,
      });
      return;
    }

    for (const { id: userId } of users) {
      try {
        await sendAlexaChangeReport(userId, endpointId, properties, causeType);
      } catch (err) {
        console.warn('[alexaEvents] ChangeReport failed for user on HA connection', {
          haConnectionId,
          userId,
          endpointId,
          err,
        });
      }
    }
  } catch (err) {
    console.warn('[alexaEvents] Failed to fan out ChangeReport for haConnection', {
      haConnectionId,
      endpointId,
      err,
    });
  }
}
