// Architecture: API boundary /installer/support/requests/[requestId]/status; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { computeSupportApproval } from '@/lib/supportRequests';
import { computeHomeSupportStatus } from '@/lib/supportHomeAccess';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';

type Status =
  | 'PENDING'
  | 'APPROVED'
  | 'CONSUMED'
  | 'EXPIRED'
  | 'NOT_FOUND'
  | 'ACTIVE'
  | 'FAILED'
  | 'REVOKED';

function mapHomeSupportStatus(status: ReturnType<typeof computeHomeSupportStatus>): Status {
  switch (status) {
    case 'PENDING':
      return 'PENDING';
    case 'APPROVED':
      return 'APPROVED';
    case 'ACTIVE':
      return 'ACTIVE';
    case 'FAILED':
      return 'FAILED';
    case 'REVOKED':
      return 'REVOKED';
    case 'CONSUMED':
      return 'CONSUMED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'NOT_FOUND';
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ requestId: string }> }
) {
  const operator = await requireCompanyHomeSupportViewer(req);
  if (operator instanceof NextResponse) return operator;

  const { requestId } = await context.params;
  if (!requestId) {
    return apiFailFromStatus(400, 'Missing request id.');
  }

  const supportRequest = await prisma.supportRequest.findUnique({
    where: { id: requestId },
    include: {
      approvalTokens: true,
    },
  });

  if (!supportRequest || supportRequest.installerUserId !== operator.userId) {
    return apiFailFromStatus(404, 'Not found.');
  }

  if (supportRequest.kind === 'HOME_ACCESS') {
    const status = mapHomeSupportStatus(
      computeHomeSupportStatus(supportRequest, supportRequest.approvalTokens)
    );
    return NextResponse.json({
      ok: true,
      status,
      approvedAt: supportRequest.approvedAt,
      expiresAt: supportRequest.approvalTokens[0]?.expiresAt ?? null,
      validUntil: supportRequest.approvalValidUntil,
    });
  }

  if (!supportRequest.authChallengeId) {
    return NextResponse.json({
      ok: true,
      status: 'NOT_FOUND' as Status,
      approvedAt: null,
      expiresAt: null,
      validUntil: null,
    });
  }

  const challenge = await prisma.authChallenge.findUnique({
    where: { id: supportRequest.authChallengeId },
    select: { approvedAt: true, consumedAt: true, expiresAt: true },
  });

  const approval = computeSupportApproval(challenge);

  return NextResponse.json({
    ok: true,
    status: approval.status as Status,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
    validUntil: approval.validUntil,
  });
}
