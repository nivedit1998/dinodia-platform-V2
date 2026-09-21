// Architecture: API boundary /installer/home-support/homes/[homeId]/revoke; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { getLatestHomeSupportRequest, revokeHomeSupportRequest } from '@/lib/supportHomeAccess';

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
  const requestId = typeof body?.requestId === 'string' && body.requestId ? body.requestId : null;
  const reason =
    typeof body?.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : 'Emergency remote access revoke';

  const request =
    requestId != null
      ? await prisma.supportRequest.findUnique({ where: { id: requestId } })
      : await getLatestHomeSupportRequest(prisma, homeId, operator.userId);

  if (!request || request.kind !== 'HOME_ACCESS' || request.homeId !== homeId) {
    return apiFailFromStatus(404, 'No support request found for this home.');
  }

  const revoked = await revokeHomeSupportRequest({
    client: prisma,
    supportRequestId: request.id,
    actorUserId: operator.userId,
    actorUsername: operator.username,
    reason,
  });

  if (!revoked.ok) {
    return apiFailFromStatus(400, 'Unable to revoke this support request.');
  }

  return NextResponse.json({
    ok: true,
    requestId: request.id,
  });
}
