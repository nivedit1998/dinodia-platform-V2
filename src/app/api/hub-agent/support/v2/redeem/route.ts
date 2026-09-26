import { NextResponse } from 'next/server';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { supportProofOfPossessionDigest } from '@/lib/stage1Operator';
import { createPropertySupportNotifications } from '@/lib/supportNotifications';
import { serializableTransaction } from '@/lib/serializableTransaction';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const ticketId = String(hub.body.ticketId ?? '').trim();
    const requestId = String(hub.body.requestId ?? '').trim();
    const identityGeneration = Number(hub.body.identityGeneration);
    const code = String(hub.body.code ?? '').trim();
    const proofOfPossession = String(hub.body.employeeProofOfPossession ?? '').trim();
    if (!ticketId || !/^[0-9a-f-]{36}$/i.test(requestId) || !Number.isInteger(identityGeneration) || identityGeneration < 1 || !code || !/^[0-9a-f]{64}$/i.test(proofOfPossession)) throw new Stage1AuthError(401, 'support_credentials_required', 'A support ticket, request, one-use support code and hub employee proof are required');
    const now = new Date();
    const result = await serializableTransaction(async (tx) => {
      const row = await tx.supportAccessRequest.findFirst({ where: { id: requestId, ticketId, hubInstallationId: hub.installation.id, status: 'ISSUED', codeHash: sha256(code), employeeHandoffEnvelope: { not: null } }, select: { id: true, ticketId: true, requestedByEmployeeId: true, homeId: true, hubInstallationId: true, requestedScope: true, targetMembershipId: true, targetUserId: true, canonicalAreaIds: true, codeExpiresAt: true, employeeHandoffExpiresAt: true, employeeHandoffConsumedAt: true, sessionHardStopAt: true, codeConsumedAt: true, employeeHandoffHash: true } });
      if (!row || row.codeConsumedAt || row.employeeHandoffConsumedAt || !row.codeExpiresAt || row.codeExpiresAt <= now || !row.employeeHandoffExpiresAt || row.employeeHandoffExpiresAt <= now || !row.sessionHardStopAt || row.sessionHardStopAt <= now) throw new Stage1AuthError(401, 'support_code_invalid', 'The support code and Company Portal handoff are invalid or expired');
      const ticket = await tx.supportTicket.findUnique({ where: { id: row.ticketId }, select: { status: true, assignedEmployeeId: true } });
      if (!ticket || ticket.status !== 'OPEN' || ticket.assignedEmployeeId !== row.requestedByEmployeeId) throw new Stage1AuthError(403, 'support_ticket_closed', 'The support ticket is not open for the assigned employee');
      const expectedProof = supportProofOfPossessionDigest({ employeeProofHash: String(row.employeeHandoffHash ?? ''), serial: hub.installation.serialNumberSnapshot, ticketId: row.ticketId, requestId: row.id, codeHash: sha256(code), identityGeneration });
      if (!row.employeeHandoffHash || expectedProof.toLowerCase() !== proofOfPossession.toLowerCase()) throw new Stage1AuthError(401, 'support_proof_invalid', 'The Company Portal proof is invalid, expired or not bound to this request');
      let targetUserId = row.targetUserId;
      let areaIds = Array.isArray(row.canonicalAreaIds) ? row.canonicalAreaIds.map(String) : [];
      if (row.requestedScope === 'TENANT_SCOPE') {
        if (!row.targetMembershipId) throw new Stage1AuthError(403, 'support_target_missing', 'The tenant support target is missing');
        const membership = await tx.homeMembership.findUnique({ where: { id: row.targetMembershipId }, select: { id: true, homeId: true, role: true, status: true, customerAccountId: true } });
        if (!membership || membership.homeId !== row.homeId || membership.role !== 'TENANT' || membership.status !== 'ACTIVE') throw new Stage1AuthError(403, 'support_target_invalid', 'The tenant support target is no longer active');
        targetUserId = membership.customerAccountId;
        if (!areaIds.length) {
          const grants = await tx.tenantAreaGrant.findMany({ where: { membershipId: membership.id, revokedAt: null }, select: { areaId: true } });
          areaIds = grants.map((grant) => grant.areaId);
        }
      } else {
        targetUserId = null;
        areaIds = [];
      }
      const consumed = await tx.supportAccessRequest.updateMany({ where: { id: row.id, status: 'ISSUED', codeConsumedAt: null, employeeHandoffConsumedAt: null }, data: { status: 'REDEEMED', codeConsumedAt: now, employeeHandoffConsumedAt: now } });
      if (consumed.count !== 1) throw new Stage1AuthError(401, 'support_code_replayed', 'The support code has already been consumed');
      const lease = randomSecret(32);
      const session = await tx.supportSession.create({ data: { accessRequestId: row.id, ticketId: row.ticketId, employeeId: row.requestedByEmployeeId, homeId: row.homeId, hubInstallationId: row.hubInstallationId, scope: row.requestedScope, areaIds, targetMembershipId: row.targetMembershipId, targetUserId, leaseHash: sha256(lease), approvedAt: now, expiresAt: row.sessionHardStopAt }, select: { id: true, expiresAt: true } });
      await createPropertySupportNotifications(tx, { homeId: row.homeId, ticketId: row.ticketId, accessRequestId: row.id, sessionId: session.id, eventType: 'STARTED' });
      await tx.auditEvent.create({ data: { homeId: row.homeId, actorType: 'EMPLOYEE', actorId: row.requestedByEmployeeId, category: 'SECURITY', action: 'support_access_redeemed', targetType: 'SupportSession', targetId: session.id, metadata: { ticketId: row.ticketId, scope: row.requestedScope, targetMembershipId: row.targetMembershipId, outcome: 'redeemed' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { sessionId: session.id, lease, expiresAt: session.expiresAt, scope: row.requestedScope, areaIds, targetMembershipId: row.targetMembershipId, targetUserId, includesTenantDevices: row.requestedScope === 'TENANT_SCOPE' };
    });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
