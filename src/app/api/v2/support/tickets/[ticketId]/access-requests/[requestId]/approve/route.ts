import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomer, Stage1AuthError } from '@/lib/stage1Auth';
import { consumeStepUp } from '@/lib/sensitiveOperationStepUp';
import { validateSupportAccessDecisionReceipt, validateSupportAccessDecisionRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ ticketId: string; requestId: string }> }) {
  try {
    const customer = await requireCustomer(request);
    const { ticketId, requestId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !validateSupportAccessDecisionRequest(body)) throw new Stage1AuthError(400, 'support_decision_invalid', 'Choose approve or deny explicitly with only the fields allowed for that decision');
    const approve = body.approve;
    const row = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, targetMembershipId: true, requestedScope: true, status: true } });
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, homeId: true, selectedMembershipId: true, status: true } });
    if (!row || !ticket || row.ticketId !== ticketId || row.homeId !== customer.homeId || ticket.homeId !== customer.homeId || ticket.status !== 'OPEN' || row.status !== 'REQUESTED') throw new Stage1AuthError(403, 'support_approval_denied', 'This support request is not available');
    const isTargetTenant = row.targetMembershipId === customer.membershipId && customer.role === 'TENANT';
    const canApproveProperty = customer.role === 'OWNER' || customer.role === 'PROPERTY_MANAGER';
    if ((row.requestedScope === 'TENANT_SCOPE' && !isTargetTenant) || (row.requestedScope === 'PROPERTY_SCOPE' && !canApproveProperty)) throw new Stage1AuthError(403, 'support_scope_approval_denied', 'This customer cannot approve the requested support scope');
    if (approve) {
      const confirmation = row.requestedScope === 'PROPERTY_SCOPE'
        ? 'I approve this support access for my property'
        : 'I approve this support access for me';
      if (String(body.confirmation ?? '') !== confirmation) throw new Stage1AuthError(400, 'support_confirmation_required', 'A fresh confirmation is required before approving support access');
      await consumeStepUp({ proof: String(body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? ''), customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind: 'support_access_approve', targetIds: [ticketId, requestId], value: confirmation, policyRevision: customer.policyRevision });
    }
    const decisionAt = new Date();
    await prisma.$transaction(async (tx) => {
      const updated = await tx.supportAccessRequest.updateMany({
        where: { id: row.id, status: 'REQUESTED' },
        data: approve
          ? { status: 'APPROVED', approvedByMembershipId: customer.membershipId, approvedAt: decisionAt, sessionHardStopAt: new Date(decisionAt.getTime() + 30 * 60 * 1000) }
          : { status: 'DENIED', approvedByMembershipId: customer.membershipId, deniedAt: decisionAt, denialReason: 'customer_denied' },
      });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'support_decision_already_made', 'This support request has already been decided');
      await tx.auditEvent.create({ data: { homeId: row.homeId, actorType: 'CUSTOMER', actorId: customer.id, category: 'SECURITY', action: approve ? 'support_access_approved' : 'support_access_denied', targetType: 'SupportAccessRequest', targetId: row.id, metadata: { ticketId, scope: row.requestedScope, membershipId: customer.membershipId, outcome: approve ? 'approved' : 'denied' }, purgeAt: new Date(decisionAt.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    });
    // Customer approval changes authority state only. The assigned employee
    // receives the one-time plaintext later from the employee-only issue route.
    const receipt = { ok: true, requestId: row.id, status: approve ? 'APPROVED' : 'DENIED' };
    if (!validateSupportAccessDecisionReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The support decision response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
