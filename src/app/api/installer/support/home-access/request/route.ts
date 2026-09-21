// Architecture: API boundary /installer/support/home-access/request; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, SupportAccessScope } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import {
  buildHomeLabel,
  buildSupportApproveUrl,
  computeHomeSupportStatus,
  getLatestHomeSupportRequest,
  issueHomeSupportApprovalTokens,
  resolveRemoteSupportApprovers,
} from '@/lib/supportHomeAccess';
import { buildSupportHomeApprovalEmail } from '@/lib/supportHomeAccessEmails';
import { sendEmail } from '@/lib/email';

const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 500;

function parseSupportReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < MIN_REASON_LENGTH || value.length > MAX_REASON_LENGTH) return null;
  return value;
}

function parseHomeScope(raw: unknown): SupportAccessScope | null {
  return raw === 'CONNECT_HA_BACKEND' ? SupportAccessScope.CONNECT_HA_BACKEND : null;
}

export async function POST(req: NextRequest) {
  const operator = await requireCompanyHomeSupportViewer(req);
  if (operator instanceof NextResponse) return operator;

  const body = await req.json().catch(() => null);
  const homeId = Number(body?.homeId ?? 0);
  const reason = parseSupportReason(body?.reason);
  const scope = parseHomeScope(body?.scope);
  if (!Number.isInteger(homeId) || homeId <= 0) {
    return apiBadRequest('Invalid home id.');
  }
  if (!reason) {
    return apiBadRequest('Support reason must be 8-500 characters.');
  }
  if (!scope) {
    return apiBadRequest('Invalid support scope for home access.');
  }

  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: {
      id: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      postcode: true,
      haConnection: {
        select: {
          cloudUrl: true,
        },
      },
    },
  });

  if (!home || !home.haConnection?.cloudUrl) {
    return apiFailFromStatus(404, 'Home not found.');
  }

  const approvers = await resolveRemoteSupportApprovers(prisma, homeId);
  if (approvers.length === 0) {
    return apiBadRequest('No remote support available as no homeowner/property manager email address exists.');
  }

  const latest = await getLatestHomeSupportRequest(prisma, homeId, operator.userId);
  const latestStatus = latest ? computeHomeSupportStatus(latest, latest.approvalTokens) : 'NOT_FOUND';
  if (
    latest &&
    (latestStatus === 'PENDING' || latestStatus === 'APPROVED' || latestStatus === 'ACTIVE') &&
    !latest.revokedAt &&
    !latest.haSessionFailureAt
  ) {
    return NextResponse.json({
      ok: true,
      requestId: latest.id,
      expiresAt: latest.createdAt,
      approvedAt: latest.approvedAt,
      validUntil: latest.approvalValidUntil,
      status: latestStatus,
    });
  }

  const supportRequest = await prisma.supportRequest.create({
    data: {
      kind: 'HOME_ACCESS',
      homeId,
      installerUserId: operator.userId,
      reason,
      scope,
      supportGatewayHostname: new URL(home.haConnection.cloudUrl).host,
    },
  });

  const issuedTokens = await issueHomeSupportApprovalTokens({
    client: prisma,
    supportRequestId: supportRequest.id,
    approvers,
  });

  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.SUPPORT_REQUEST_CREATED,
      homeId,
      actorUserId: operator.userId,
      metadata: {
        supportRequestId: supportRequest.id,
        kind: 'HOME_ACCESS',
        approverCount: approvers.length,
        scope,
        reason,
      },
    },
  });

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    'http://localhost:3000';
  const homeLabel = buildHomeLabel({
    homeId,
    addressLine1: home.addressLine1,
    addressLine2: home.addressLine2,
    city: home.city,
    postcode: home.postcode,
  });

  for (const token of issuedTokens) {
    const email = buildSupportHomeApprovalEmail({
      verifyUrl: buildSupportApproveUrl(token.rawToken),
      appUrl,
      installerUsername: operator.username,
      homeLabel,
      recipientName: token.recipientName,
      reason,
    });
    await sendEmail({
      to: token.recipientEmail,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  }

  return NextResponse.json({
    ok: true,
    requestId: supportRequest.id,
    expiresAt: issuedTokens[0]?.expiresAt ?? null,
    validUntil: null,
    approvedAt: null,
    status: 'PENDING',
  });
}
