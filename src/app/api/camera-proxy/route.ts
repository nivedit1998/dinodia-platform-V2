// Architecture: API boundary /camera-proxy; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { EntityAccessError, assertTenantEntityAccess, parseEntityId } from '@/lib/entityAccess';
import { buildHaServiceBypassHeaders } from '@/lib/haServiceBypass';

export async function GET(req: NextRequest) {
  const user = await getCurrentUserFromRequest(req);
  if (!user) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  let entityId: string;
  try {
    const parsed = parseEntityId(req.nextUrl.searchParams.get('entityId'));
    if (parsed.domain !== 'camera') {
      return apiFailFromStatus(400, 'entityId must be a camera.* entity');
    }
    entityId = parsed.entityId;
  } catch (err) {
    const status = err instanceof EntityAccessError ? err.status : 400;
    const message = err instanceof Error ? err.message : 'Invalid entityId';
    return apiFailFromStatus(status, message);
  }

  let haConnection;
  let fullUser;
  try {
    ({ haConnection, user: fullUser } = await getUserWithHaConnection(user.id));
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  try {
    await assertTenantEntityAccess({
      user,
      accessRules: fullUser?.accessRules ?? [],
      haConnectionId: haConnection.id,
      entityId,
      options: { cacheTtlMs: 10_000 },
    });
  } catch (err) {
    if (err instanceof EntityAccessError) {
      return apiFailFromStatus(err.status, err.message);
    }
    throw err;
  }

  const effectiveHa = resolveHaCloudFirst(haConnection);

  const url = `${effectiveHa.baseUrl}/api/camera_proxy/${encodeURIComponent(entityId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${effectiveHa.longLivedToken}`,
      ...buildHaServiceBypassHeaders({
        method: 'GET',
        url,
      }),
    },
  });

  if (!res.ok || !res.body) {
    return apiFailFromStatus(502, 'Dinodia Hub unavailable. Please refresh and try again.');
  }

  const headers = new Headers();
  headers.set('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');
  headers.set('Cache-Control', 'no-store');
  return new NextResponse(res.body, { status: res.status, headers });
}
