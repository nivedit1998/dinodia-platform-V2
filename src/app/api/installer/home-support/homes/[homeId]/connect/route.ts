// Architecture: API boundary /installer/home-support/homes/[homeId]/connect; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { buildSupportGateUrl, computeHomeSupportStatus, getLatestHomeSupportRequest } from '@/lib/supportHomeAccess';

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
  if (!homeId) {
    return apiFailFromStatus(400, 'Invalid home id.');
  }

  const request = await getLatestHomeSupportRequest(prisma, homeId, operator.userId);
  if (!request) {
    return apiFailFromStatus(404, 'No support request found for this home.');
  }

  const status = computeHomeSupportStatus(request, request.approvalTokens);
  if (status !== 'APPROVED') {
    return apiFailFromStatus(403, 'Support request is not approved or has expired.');
  }

  if (!request.supportGatewayHostname) {
    return apiFailFromStatus(400, 'Cloud hostname is missing for this home.');
  }

  await prisma.supportRequest.update({
    where: { id: request.id },
    data: {
      connectButtonClickedAt: new Date(),
    },
  });

  return NextResponse.json({
    ok: true,
    redirectTo: buildSupportGateUrl({
      homeId,
      requestId: request.id,
      hostname: request.supportGatewayHostname,
    }),
  });
}
