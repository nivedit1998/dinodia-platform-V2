// Architecture: API boundary /support/ha-gate/status; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { resolveHomeSupportGateStatus } from '@/lib/supportHomeAccess';

function isValidHaHostname(raw: string | null) {
  if (!raw) return false;
  return /^ha[a-z0-9-]*\.dinodiasmartliving\.com$/i.test(raw.trim());
}

export async function GET(req: NextRequest) {
  const operator = await requireCompanyHomeSupportViewer(req);
  if (operator instanceof NextResponse) return operator;

  const requestId = req.nextUrl.searchParams.get('requestId');
  const homeId = req.nextUrl.searchParams.get('homeId');
  const host = req.nextUrl.searchParams.get('host');
  if (!requestId || !homeId || !isValidHaHostname(host)) {
    return apiFailFromStatus(400, 'Invalid support gate status request.');
  }

  const supportRequest = await prisma.supportRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      homeId: true,
      installerUserId: true,
      approvedAt: true,
      approvalValidUntil: true,
      revokedAt: true,
      haSessionRevokedAt: true,
      haSessionFailureAt: true,
      haSessionFailureCode: true,
      haSessionStartedAt: true,
      haSessionExpiresAt: true,
      haSessionEndedAt: true,
      haSecurityCodeHash: true,
      haSecurityCodeConsumedAt: true,
      haSecurityCodeExpiresAt: true,
      gatewaySessionHash: true,
      gatewaySessionBoundAt: true,
      gatewaySessionUserAgentHash: true,
    },
  });

  if (!supportRequest || supportRequest.homeId !== Number(homeId) || supportRequest.installerUserId !== operator.userId) {
    return apiFailFromStatus(404, 'Not found.');
  }

  return NextResponse.json({
    ok: true,
    status: resolveHomeSupportGateStatus(supportRequest, req.headers.get('user-agent')),
    failureCode: supportRequest.haSessionFailureCode ?? null,
  });
}
