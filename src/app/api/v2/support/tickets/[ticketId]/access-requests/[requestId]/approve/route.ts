import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { consumeStepUp } from '@/lib/sensitiveOperationStepUp';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ ticketId: string; requestId: string }> }) {
  try {
    const customer = await requireCustomer(request);
    const { ticketId, requestId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const approve = body.approve !== false;
    const row = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, targetMembershipId: true, requestedScope: true, status: true } });
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, homeId: true, selectedMembershipId: true, status: true } });
    if (!row || !ticket || row.ticketId !== ticketId || row.homeId !== customer.homeId || ticket.homeId !== customer.homeId || ticket.status !== 'OPEN' || row.status !== 'REQUESTED') throw new Stage1AuthError(403, 'support_approval_denied', 'This support request is not available');
    const isTargetTenant = row.targetMembershipId === customer.membershipId && customer.role === 'TENANT';
    const canApproveProperty = customer.role === 'OWNER' || customer.role === 'PROPERTY_MANAGER';
    if ((row.requestedScope === 'TENANT_SCOPE' && !isTargetTenant) || (row.requestedScope === 'PROPERTY_SCOPE' && !canApproveProperty)) throw new Stage1AuthError(403, 'support_scope_approval_denied', 'This customer cannot approve the requested support scope');
    if (approve && row.requestedScope === 'PROPERTY_SCOPE') {
      if (String(body.confirmation ?? '') !== 'I approve this support access for my property') throw new Stage1AuthError(400, 'support_confirmation_required', 'Type the exact support confirmation before approving property diagnostics');
      await consumeStepUp({ proof: String(body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? ''), customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind: 'support_access_approve', targetIds: [ticketId, requestId], value: 'I approve this support access for my property', policyRevision: customer.policyRevision });
    }
    const decisionAt = new Date();
    const oneUseCode = approve ? `DNO-S-${randomSecret(18)}` : null;
    const codeExpiresAt = approve ? new Date(decisionAt.getTime() + 10 * 60 * 1000) : null;
    await prisma.$transaction(async (tx) => {
      const updated = await tx.supportAccessRequest.updateMany({
        where: { id: row.id, status: 'REQUESTED' },
        data: approve
          ? { status: 'APPROVED', approvedByMembershipId: customer.membershipId, approvedAt: decisionAt, codeHash: sha256(oneUseCode!), codeIssuedAt: decisionAt, codeExpiresAt, sessionHardStopAt: new Date(decisionAt.getTime() + 30 * 60 * 1000) }
          : { status: 'DENIED', approvedByMembershipId: customer.membershipId, deniedAt: decisionAt, denialReason: 'customer_denied' },
      });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'support_decision_already_made', 'This support request has already been decided');
      await tx.auditEvent.create({ data: { homeId: row.homeId, actorType: 'CUSTOMER', actorId: customer.id, category: 'SECURITY', action: approve ? 'support_access_approved' : 'support_access_denied', targetType: 'SupportAccessRequest', targetId: row.id, metadata: { ticketId, scope: row.requestedScope, membershipId: customer.membershipId, outcome: approve ? 'approved' : 'denied' }, purgeAt: new Date(decisionAt.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    });
    // Reveal the one-use code only to the approving customer. The employee
    // Portal receives no code; it only starts the authenticated hub handoff.
    // Platform stores the hash and the hub later supplies the code over its
    // machine-authenticated local support surface.
    return NextResponse.json({ ok: true, requestId: row.id, status: approve ? 'APPROVED' : 'DENIED', ...(oneUseCode ? { oneUseCode, codeExpiresAt } : {}) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
