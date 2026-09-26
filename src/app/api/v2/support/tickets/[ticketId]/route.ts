import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { consumeStepUp } from '@/lib/sensitiveOperationStepUp';
import { createPropertySupportNotifications } from '@/lib/supportNotifications';
import { serializableTransaction } from '@/lib/serializableTransaction';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ ticketId: string }> }) {
  try {
    const customer = await requireCustomer(request);
    const { ticketId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (String(body.action ?? '').toLowerCase() !== 'close') throw new Stage1AuthError(400, 'support_action_invalid', 'Only close is supported on this endpoint');
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, customerAccountId: true, homeId: true, status: true } });
    if (!ticket || ticket.customerAccountId !== customer.id || ticket.homeId !== customer.homeId) throw new Stage1AuthError(403, 'support_ticket_denied', 'This ticket is not part of the selected home');
    await consumeStepUp({ proof: String(body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? ''), customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId, operationKind: 'support_ticket_close', targetIds: [ticketId], value: null, policyRevision: customer.policyRevision });
    const now = new Date();
    await serializableTransaction(async (tx) => {
      const activeSessions = await tx.supportSession.findMany({ where: { ticketId, status: 'ACTIVE' }, select: { id: true, accessRequestId: true, homeId: true } });
      await tx.supportAccessRequest.updateMany({ where: { ticketId, status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED'] } }, data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
      await tx.supportSession.updateMany({ where: { ticketId, status: 'ACTIVE' }, data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
      await tx.supportTicket.update({ where: { id: ticketId }, data: { status: 'CLOSED', closedAt: now } });
      for (const session of activeSessions) {
        await createPropertySupportNotifications(tx, { homeId: session.homeId, ticketId, accessRequestId: session.accessRequestId, sessionId: session.id, eventType: 'REVOKED' });
      }
      await tx.auditEvent.create({ data: { homeId: ticket.homeId, actorType: 'CUSTOMER', actorId: customer.id, category: 'SECURITY', action: 'support_ticket_closed', targetType: 'SupportTicket', targetId: ticketId, metadata: { outcome: 'closed', cloudAuthorityRevoked: true, hubAcknowledgementPending: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    });
    return NextResponse.json({ ok: true, ticketId, status: 'CLOSED', message: 'Support access revoked — waiting for hub confirmation' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
