import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { consumeStepUp } from '@/lib/sensitiveOperationStepUp';
import { createPropertySupportNotifications } from '@/lib/supportNotifications';

export const dynamic = 'force-dynamic';

const CONFIRMATION = 'I revoke this support access for my property';

/**
 * Revoke a property support request using a fresh step-up from the exact
 * customer membership that approved it. This prevents a different household
 * principal from silently ending a sensitive support session and makes the
 * customer-facing revocation auditable and idempotent.
 */
export async function POST(request: Request, context: { params: Promise<{ ticketId: string; requestId: string }> }) {
  try {
    const customer = await requireCustomer(request);
    const { ticketId, requestId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (String(body.confirmation ?? '') !== CONFIRMATION) throw new Stage1AuthError(400, 'support_confirmation_required', 'Type the exact support confirmation before revoking property support');
    const row = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, requestedScope: true, approvedByMembershipId: true, status: true } });
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, homeId: true, status: true } });
    if (!row || !ticket || row.ticketId !== ticketId || row.homeId !== customer.homeId || ticket.homeId !== customer.homeId || ticket.status !== 'OPEN' || row.requestedScope !== 'PROPERTY_SCOPE' || !['APPROVED', 'ISSUED', 'REDEEMED'].includes(row.status)) throw new Stage1AuthError(403, 'support_revoke_denied', 'This property support request is not active for the selected home');
    if (!row.approvedByMembershipId || row.approvedByMembershipId !== customer.membershipId || !['OWNER', 'PROPERTY_MANAGER'].includes(customer.role)) throw new Stage1AuthError(403, 'support_revoke_approver_denied', 'Only the customer membership that approved this property access may revoke it');
    await consumeStepUp({ proof: String(body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? ''), customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind: 'support_access_revoke', targetIds: [ticketId, requestId], value: CONFIRMATION, policyRevision: customer.policyRevision });
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const sessions = await tx.supportSession.findMany({ where: { accessRequestId: requestId, ticketId, status: 'ACTIVE' }, select: { id: true, homeId: true } });
      const updated = await tx.supportAccessRequest.updateMany({ where: { id: requestId, ticketId, status: { in: ['APPROVED', 'ISSUED', 'REDEEMED'] } }, data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'support_revoke_race', 'The support request was already closed or revoked');
      await tx.supportSession.updateMany({ where: { accessRequestId: requestId, ticketId, status: 'ACTIVE' }, data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
      for (const session of sessions) await createPropertySupportNotifications(tx, { homeId: session.homeId, ticketId, accessRequestId: requestId, sessionId: session.id, eventType: 'REVOKED' });
      await tx.auditEvent.create({ data: { homeId: row.homeId, actorType: 'CUSTOMER', actorId: customer.id, category: 'SECURITY', action: 'support_access_revoked', targetType: 'SupportAccessRequest', targetId: requestId, metadata: { ticketId, scope: 'PROPERTY_SCOPE', outcome: 'revoked', hubAcknowledgementPending: sessions.length > 0 }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    });
    return NextResponse.json({ ok: true, requestId, status: 'REVOKED', message: 'Property support access revoked — waiting for hub confirmation' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
