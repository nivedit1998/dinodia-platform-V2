// Architecture: API boundary /installer/home-support/homes/[homeId]/connect/code; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { createHomeSupportLaunchTicket } from '@/lib/supportHomeAccess';

function parseHomeId(raw: string | undefined) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  const operator = await requireCompanyHomeSupportViewer(req);
  if (operator instanceof NextResponse) return operator;

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) return apiBadRequest('Invalid home id.');

  const body = await req.json().catch(() => null);
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  const host = typeof body?.host === 'string' ? body.host.trim() : '';

  if (!requestId || !/^\d{6}$/.test(code) || !/^ha[a-z0-9-]*\.dinodiasmartliving\.com$/i.test(host)) {
    return apiBadRequest('Invalid connect request.');
  }

  const result = await createHomeSupportLaunchTicket({
    client: prisma,
    supportRequestId: requestId,
    installerUserId: operator.userId,
    code,
    hostname: host,
    actorUserId: operator.userId,
    actorUsername: operator.username,
    userAgent: req.headers.get('user-agent'),
  });

  if (!result.ok) {
    if (result.reason === 'BOOTSTRAP_IN_PROGRESS') {
      return NextResponse.json({
        ok: true,
        redirectTo: `https://${host}/?__dinodia_bootstrap=1`,
        validUntil: null,
      });
    }
    return apiFailFromStatus(
      result.reason === 'ACTIVE_OTHER_DEVICE' ? 409 : 410,
      result.reason === 'ACTIVE_OTHER_DEVICE'
        ? 'This support session is already in use on another device or tab. Request access again if needed.'
        : 'Connection to the Dinodia hub failed. Approval must be requested again.'
    );
  }

  const redirectTo = new URL(`https://${host}/__dinodia/launch`);
  redirectTo.searchParams.set('ticket', result.launchTicket);

  return NextResponse.json({
    ok: true,
    redirectTo: redirectTo.toString(),
    validUntil: result.validUntil,
  });
}
