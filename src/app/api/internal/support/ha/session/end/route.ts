// Architecture: API boundary /internal/support/ha/session/end; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiForbidden } from '@/lib/apiError';
import { isValidHaSupportInternalRequest } from '@/lib/haSupportInternalAuth';
import { prisma } from '@/lib/prisma';
import { markGatewaySupportSessionEnded } from '@/lib/supportHomeAccess';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isValidHaSupportInternalRequest(req)) {
    return apiForbidden('Worker access required.');
  }

  const body = await req.json().catch(() => null);
  const sessionToken = typeof body?.sessionToken === 'string' ? body.sessionToken : null;
  const supportRequestId = typeof body?.supportRequestId === 'string' ? body.supportRequestId : null;
  const reason = body?.reason;
  const failureCode = typeof body?.failureCode === 'string' ? body.failureCode : null;

  if (!sessionToken && !supportRequestId) {
    return apiBadRequest('Session token or support request id is required.');
  }
  if (reason !== 'EXPIRED' && reason !== 'FAILED' && reason !== 'ENDED' && reason !== 'REVOKED') {
    return apiBadRequest('Invalid session end reason.');
  }

  const result = await markGatewaySupportSessionEnded({
    client: prisma,
    rawGatewaySessionToken: sessionToken,
    supportRequestId,
    reason,
    failureCode,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
