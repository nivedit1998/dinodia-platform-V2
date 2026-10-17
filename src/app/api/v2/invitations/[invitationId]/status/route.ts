import { NextResponse } from 'next/server';
import { validateCustomerInvitationStatusReceipt } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { prisma } from '@/lib/prisma';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  const startedAt = Date.now();
  let phase = 'session_authentication';
  try {
    const customer = await requireCustomerAccountSession(request);
    phase = 'request_validation';
    const { invitationId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This invitation is no longer available');
    }

    phase = 'recipient_scoped_lookup';
    const invitation = await prisma.membershipInvitation.findUnique({
      where: { id: invitationId },
      select: {
        id: true, homeId: true, targetAccountId: true, targetEmailNormalized: true,
        role: true, state: true, expiresAt: true,
      },
    });
    // A deliberately indistinguishable 404 prevents this endpoint becoming an
    // invitation-existence oracle for another account or recipient email.
    if (!invitation || (invitation.targetAccountId
      ? invitation.targetAccountId !== customer.id
      : invitation.targetEmailNormalized !== customer.email.trim().toLowerCase())) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This invitation is no longer available');
    }

    phase = 'outcome_projection';
    const state = invitation.state === 'PENDING' && invitation.expiresAt <= new Date()
      ? 'EXPIRED'
      : invitation.state;
    const membership = state === 'ACCEPTED'
      ? await prisma.homeMembership.findUnique({
        where: { customerAccountId_homeId: { customerAccountId: customer.id, homeId: invitation.homeId } },
        select: { id: true, status: true },
      })
      : null;
    const receipt = {
      schemaVersion: 'dinodia.v1' as const,
      ok: true as const,
      invitationId: invitation.id,
      state,
      homeId: invitation.homeId,
      role: invitation.role,
      homeMembershipId: membership?.status === 'ACTIVE' ? membership.id : null,
    };
    phase = 'receipt_contract_validation';
    if (!validateCustomerInvitationStatusReceipt(receipt, invitationId)) {
      throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The invitation status failed contract validation');
    }
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return nativeV1ErrorResponse(error, { operation: 'customer_invitation_status', phase, startedAt });
  }
}
