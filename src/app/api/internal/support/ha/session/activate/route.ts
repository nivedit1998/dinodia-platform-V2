// Architecture: API boundary /internal/support/ha/session/activate; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiForbidden } from '@/lib/apiError';
import { isValidHaSupportInternalRequest } from '@/lib/haSupportInternalAuth';
import { prisma } from '@/lib/prisma';
import { activateGatewaySupportSession } from '@/lib/supportHomeAccess';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isValidHaSupportInternalRequest(req)) {
    return apiForbidden('Worker access required.');
  }

  const body = await req.json().catch(() => null);
  const sessionToken = typeof body?.sessionToken === 'string' ? body.sessionToken : '';
  const hostname = typeof body?.hostname === 'string' ? body.hostname : '';
  const actorUsername = typeof body?.actorUsername === 'string' ? body.actorUsername : null;

  if (!sessionToken || !/^ha[a-z0-9-]*\.dinodiasmartliving\.com$/i.test(hostname)) {
    return apiBadRequest('Invalid session activation request.');
  }

  const result = await activateGatewaySupportSession({
    client: prisma,
    rawGatewaySessionToken: sessionToken,
    hostname,
    actorUsername,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 410 });
}
