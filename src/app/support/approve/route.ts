// Architecture: App Router surface src/app/support/approve/route.ts; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  approveHomeSupportByRawToken,
  computeHomeSupportStatus,
  renderSupportApprovalPage,
  revokeHomeSupportRequest,
} from '@/lib/supportHomeAccess';
import { hashToken } from '@/lib/authChallenges';
import { buildSupportApprovalSuccessCopy } from '@/lib/supportHomeAccessEmails';

export const runtime = 'nodejs';

async function lookupApprovalToken(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  return prisma.supportRequestApprovalToken.findUnique({
    where: { tokenHash },
    include: {
      supportRequest: {
        include: {
          approvalTokens: true,
        },
      },
    },
  });
}

function html(message: string, title = 'Dinodia Smart Living', status = 200) {
  return new NextResponse(renderSupportApprovalPage({ title, message }), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return html('Missing support approval token.', 'Invalid link', 400);
  }

  const row = await lookupApprovalToken(token);
  if (!row) {
    return html('This support approval link is not valid.', 'Invalid link', 404);
  }

  const request = row.supportRequest;
  const status = computeHomeSupportStatus(request, request.approvalTokens);

  if (request.revokedAt || request.haSessionRevokedAt) {
    return html('This support request has already been revoked.', 'Access revoked', 410);
  }

  if (request.approvedAt) {
    const approvedBy = request.approvalRecipientName ?? request.approvalRecipientEmail ?? 'another approver';
    const approvedAt = request.approvedAt.toLocaleString('en-GB');
    return new NextResponse(
      renderSupportApprovalPage({
        title: 'Already approved',
        message: `Access already approved by ${approvedBy} at ${approvedAt}.`,
        showRevoke: status === 'ACTIVE',
        token,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }
    );
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return html('This support approval link has expired. Dinodia support must request access again.', 'Link expired', 410);
  }

  return new NextResponse(
    renderSupportApprovalPage({
      title: 'Approve Home Assistant support',
      message:
        'Dinodia support is requesting temporary remote access to the Home Assistant backend for this home. Approving will generate a one-time HASecurityCode that expires in 10 minutes.',
      showApprove: true,
      token,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = req.nextUrl.searchParams.get('token') || form?.get('token')?.toString() || null;
  const action = form?.get('action')?.toString() || 'approve';

  if (!token) {
    return html('Missing support approval token.', 'Invalid link', 400);
  }

  if (action === 'revoke') {
    const row = await lookupApprovalToken(token);
    if (!row) {
      return html('This support approval link is not valid.', 'Invalid link', 404);
    }
    const revoked = await revokeHomeSupportRequest({
      client: prisma,
      supportRequestId: row.supportRequestId,
      actorUserId: row.recipientUserId ?? null,
      actorUsername: row.recipientName ?? null,
      reason: 'Approver requested emergency revoke',
    });
    if (!revoked.ok) {
      return html('Unable to revoke this support request.', 'Revoke failed', 400);
    }
    return html('Remote access has been revoked immediately.', 'Access revoked', 200);
  }

  const result = await approveHomeSupportByRawToken(prisma, token);
  if (!result.ok) {
    const message =
      result.reason === 'REVOKED'
        ? 'This support request has already been revoked.'
        : result.reason === 'EXPIRED'
          ? 'This support approval link has expired. Dinodia support must request access again.'
          : 'This support approval link is not valid.';
    return html(message, result.reason === 'NOT_FOUND' ? 'Invalid link' : 'Link expired', result.reason === 'NOT_FOUND' ? 404 : 410);
  }

  if (result.status === 'ALREADY_APPROVED') {
    const approvedBy = result.approvalRecipientName ?? 'another approver';
    return new NextResponse(
      renderSupportApprovalPage({
        title: 'Already approved',
        message: `Access already approved by ${approvedBy} at ${result.approvedAt.toLocaleString('en-GB')}.`,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }
    );
  }

  return new NextResponse(
    renderSupportApprovalPage({
      title: 'Approval successful',
      message: buildSupportApprovalSuccessCopy(result.code),
      code: result.code,
      token,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}
