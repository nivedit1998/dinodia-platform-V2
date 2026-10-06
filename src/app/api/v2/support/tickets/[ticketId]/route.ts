import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { validateSupportTicketCloseReceipt, validateSupportTicketCloseRequest } from '@/lib/contracts/dinodiaV1';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { sha256 } from '@/lib/stage1Crypto';
import { createPropertySupportNotifications } from '@/lib/supportNotifications';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';

export const dynamic = 'force-dynamic';

type HubEnforcement = 'PENDING' | 'ACKNOWLEDGED' | 'EXPIRED' | 'NOT_REQUIRED';

async function supportEnforcement(ticketId: string, now = new Date(), db = prisma): Promise<HubEnforcement> {
  const rows = await db.supportSession.findMany({ where: { ticketId }, select: { status: true, expiresAt: true, hubAcknowledgedAt: true } });
  if (rows.some((row) => row.status === 'PENDING_HUB_REVOKE')) return 'PENDING';
  if (rows.some((row) => row.status === 'ACTIVE' && row.expiresAt > now)) return 'PENDING';
  if (rows.some((row) => row.hubAcknowledgedAt !== null)) return 'ACKNOWLEDGED';
  if (rows.some((row) => row.status === 'EXPIRED' || row.status === 'ACTIVE' && row.expiresAt <= now)) return 'EXPIRED';
  return 'NOT_REQUIRED';
}

export async function GET(request: Request, context: { params: Promise<{ ticketId: string }> }) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const { ticketId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ticketId)) {
      throw new Stage1AuthError(404, 'support_ticket_not_found', 'This support ticket is not available');
    }
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, customerAccountId: customer.id, homeId: customer.homeId, selectedMembershipId: customer.membershipId },
      select: {
        id: true, publicReference: true, customerAccountId: true, homeId: true, selectedMembershipId: true,
        nativeCategory: true, status: true, revision: true, description: true, createdAt: true,
        updatedAt: true, closedAt: true,
        timeline: { where: { customerVisible: true }, orderBy: { createdAt: 'asc' }, take: 100,
          select: { id: true, eventCode: true, safeSummary: true, createdAt: true } },
      },
    });
    if (!ticket || !ticket.nativeCategory) throw new Stage1AuthError(404, 'support_ticket_not_found', 'This support ticket is not available');
    return NextResponse.json({ ok: true, ticket: {
      ticketId: ticket.id, publicReference: ticket.publicReference, customerAccountId: ticket.customerAccountId,
      homeId: ticket.homeId, homeMembershipId: ticket.selectedMembershipId, category: ticket.nativeCategory,
      status: ticket.status, revision: ticket.revision, description: ticket.description,
      createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt.toISOString(),
      closedAt: ticket.closedAt?.toISOString() ?? null,
      hubEnforcement: await supportEnforcement(ticket.id),
      customerVisibleUpdates: ticket.timeline.map((row) => ({ id: row.id, code: row.eventCode, summary: row.safeSummary, createdAt: row.createdAt.toISOString() })),
    } }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ ticketId: string }> }) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const { ticketId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !validateSupportTicketCloseRequest(body)) throw new Stage1AuthError(400, 'support_action_invalid', 'Only the exact close action is supported on this endpoint');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ticketId)) throw new Stage1AuthError(404, 'support_ticket_not_found', 'This support request is not available to the selected account and Home');
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, customerAccountId: true, homeId: true, selectedMembershipId: true, status: true } });
    if (!ticket || ticket.customerAccountId !== customer.id || ticket.homeId !== customer.homeId || ticket.selectedMembershipId !== customer.membershipId) throw new Stage1AuthError(404, 'support_ticket_not_found', 'This support request is not available to the selected account and Home');
    const proof = String(body.proof ?? request.headers.get('x-dinodia-step-up-proof') ?? '');
    const nonceHash = sha256(proof);
    const digest = operationDigest({ customerAccountId: customer.id, customerSessionId: customer.sessionId,
      trustedDeviceId: customer.trustedDeviceId, homeId: customer.homeId, membershipId: customer.membershipId,
      hubInstallationId: customer.hubInstallationId, operationKind: 'support_ticket_close', targetIds: [ticketId], value: null });
    const enforcement = await serializableTransaction(async (tx) => {
      // A hub redemption locks the ticket and request before creating a
      // SupportSession whose target-user FK references this customer. Taking
      // the account lock first here can deadlock: close waits for the ticket
      // while redemption waits for the customer's FK key-share lock. Both
      // paths use ticket → request → customer authority as their lock order.
      await tx.$queryRaw`SELECT "id" FROM "SupportTicket" WHERE "id" = ${ticketId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SupportAccessRequest" WHERE "ticketId" = ${ticketId}::uuid ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${customer.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${customer.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${customer.trustedDeviceId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${customer.membershipId}::uuid FOR UPDATE`;
      const now = new Date();
      const [account, session, device, membership, home, lockedTicket] = await Promise.all([
        tx.customerAccount.findUnique({ where: { id: customer.id }, select: { id: true, status: true, securityVersion: true } }),
        tx.customerSession.findUnique({ where: { id: customer.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: customer.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
        tx.homeMembership.findUnique({ where: { id: customer.membershipId }, select: { id: true, customerAccountId: true, homeId: true, role: true, status: true, accessRevision: true } }),
        tx.home.findUnique({ where: { id: customer.homeId }, select: { activeHubInstallationId: true, activeHubInstallation: { select: { id: true, accessPolicyRevision: true } } } }),
        tx.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, customerAccountId: true, homeId: true, selectedMembershipId: true, status: true } }),
      ]);
      const policy = currentCustomerPolicy();
      const policyAcceptance = policy ? await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
        customerAccountId: customer.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
      } }, select: { id: true } }) : null;
      const credentialCurrent = session && (customer.credentialKind === 'account_access'
        ? customer.tokenHash === session.accessTokenHash && Boolean(session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
        : customer.credentialKind === 'account_refresh'
          ? customer.tokenHash === session.refreshTokenHash && session.expiresAt > now
          : customer.tokenExpiresAt !== undefined
            ? customer.tokenExpiresAt > now.getTime()
            : customer.tokenHash === session.accessTokenHash
              ? Boolean(session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
              : customer.tokenHash === session.refreshTokenHash);
      if (!account || account.status !== 'ACTIVE' || account.securityVersion !== session?.securityVersion
        || !session || session.customerAccountId !== customer.id || session.trustedDeviceId !== customer.trustedDeviceId
        || !credentialCurrent || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !device || device.customerAccountId !== customer.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion
        || !membership || membership.customerAccountId !== customer.id || membership.homeId !== customer.homeId || membership.status !== 'ACTIVE'
        || membership.role !== customer.role || !home || home.activeHubInstallationId !== customer.hubInstallationId
        || home.activeHubInstallation?.id !== customer.hubInstallationId
        || Math.max(membership.accessRevision, home.activeHubInstallation.accessPolicyRevision) !== customer.policyRevision
        || !policyAcceptance || !lockedTicket || lockedTicket.customerAccountId !== customer.id || lockedTicket.homeId !== customer.homeId
        || lockedTicket.selectedMembershipId !== customer.membershipId || lockedTicket.status !== 'OPEN') {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The account, Home access or support request changed. Refresh before closing it.');
      }
      const proofUse = await tx.stepUpAuthorization.updateMany({ where: {
        nonceHash, customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId,
        homeId: customer.homeId, membershipId: customer.membershipId, operationKind: 'support_ticket_close',
        targetDigest: targetDigest([ticketId]), normalizedValueDigest: digest, policyRevision: customer.policyRevision,
        consumedAt: null, revokedAt: null, expiresAt: { gt: now },
      }, data: { consumedAt: now } });
      if (proofUse.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'A fresh confirmation for closing this exact support request is required');

      const liveSessions = await tx.supportSession.findMany({ where: { ticketId, status: 'ACTIVE', expiresAt: { gt: now } }, select: { id: true, accessRequestId: true, homeId: true } });
      await tx.supportSession.updateMany({ where: { ticketId, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED', desiredRevokedAt: now, endedAt: now } });
      await tx.supportSession.updateMany({ where: { ticketId, status: 'ACTIVE', expiresAt: { gt: now } }, data: { status: 'PENDING_HUB_REVOKE', desiredRevokedAt: now, endedAt: now } });
      await tx.supportAccessRequest.updateMany({ where: { ticketId, status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED'] } }, data: { status: 'REVOKED', desiredRevokedAt: now, revision: { increment: 1 } } });
      await tx.supportTicket.update({ where: { id: ticketId }, data: { status: 'CLOSED', closedAt: now, revision: { increment: 1 } } });
      for (const active of liveSessions) await createPropertySupportNotifications(tx, { homeId: active.homeId, ticketId, accessRequestId: active.accessRequestId, sessionId: active.id, eventType: 'REVOKED' });
      const remaining = await tx.supportSession.findMany({ where: { ticketId }, select: { status: true, expiresAt: true, hubAcknowledgedAt: true } });
      const state: HubEnforcement = remaining.some((row) => row.status === 'PENDING_HUB_REVOKE' || row.status === 'ACTIVE' && row.expiresAt > now)
        ? 'PENDING'
        : remaining.some((row) => row.hubAcknowledgedAt !== null) ? 'ACKNOWLEDGED'
          : remaining.some((row) => row.status === 'EXPIRED' || row.status === 'ACTIVE' && row.expiresAt <= now) ? 'EXPIRED' : 'NOT_REQUIRED';
      await tx.auditEvent.create({ data: { homeId: customer.homeId, actorType: 'CUSTOMER', actorId: customer.id, category: 'SECURITY', action: 'support_ticket_closed', targetType: 'SupportTicket', targetId: ticketId, metadata: { outcome: 'closed', cloudAuthorityRevoked: true, hubEnforcement: state }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return state;
    });
    const message = enforcement === 'PENDING' ? 'Support access revoked — waiting for hub confirmation'
      : enforcement === 'ACKNOWLEDGED' ? 'Support access revoked and confirmed by the hub'
        : enforcement === 'EXPIRED' ? 'Support access revoked; its hub authorization had already expired'
          : 'Support request closed; no hub access required enforcement';
    const receipt = { ok: true, ticketId, status: 'CLOSED', message, hubEnforcement: enforcement };
    if (!validateSupportTicketCloseReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The support-close response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
