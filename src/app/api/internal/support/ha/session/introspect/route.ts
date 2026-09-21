// Architecture: API boundary /internal/support/ha/session/introspect; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiForbidden } from '@/lib/apiError';
import { isValidHaSupportInternalRequest } from '@/lib/haSupportInternalAuth';
import { prisma } from '@/lib/prisma';
import { introspectGatewaySupportSession } from '@/lib/supportHomeAccess';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isValidHaSupportInternalRequest(req)) {
    return apiForbidden('Worker access required.');
  }

  const body = await req.json().catch(() => null);
  const sessionToken = typeof body?.sessionToken === 'string' ? body.sessionToken : '';
  const hostname = typeof body?.hostname === 'string' ? body.hostname : '';
  const userAgent = typeof body?.userAgent === 'string' ? body.userAgent : null;
  const checkMode = body?.checkMode === 'service' ? 'service' : 'browser';

  if (!sessionToken || !/^ha[a-z0-9-]*\.dinodiasmartliving\.com$/i.test(hostname)) {
    return apiBadRequest('Invalid introspection request.');
  }

  const result = await introspectGatewaySupportSession({
    client: prisma,
    rawGatewaySessionToken: sessionToken,
    hostname,
    userAgent,
    checkMode,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 410 });
}
