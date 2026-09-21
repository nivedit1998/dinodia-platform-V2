// Stage 1 V2 support-access contract. This is deliberately separate from the
// legacy HA support gateway: tickets, approvals, one-use codes and leases are
// durable Prisma records and every scope is checked against membership data.
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { SupportRequestKind, HomeMembershipRole, HomeMembershipStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { checkRateLimit } from '@/lib/rateLimit';
import { getActiveHomeMembership, hasEveryAreaGrant } from '@/lib/membershipAuthorization';

const CODE_TTL_MS = 10 * 60_000;
const SESSION_MAX_MS = 30 * 60_000;
const hash = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function responseSession(session: { id: string; supportRequestId: string; status: string; scope: string; areaIds: unknown; includesTenantDevices: boolean; approvedAt: Date | null; expiresAt: Date | null; redeemedAt: Date | null; endedAt: Date | null; hubRevokePending: boolean }) {
  return { id: session.id, ticketId: session.supportRequestId, status: session.status, scope: session.scope, areaIds: Array.isArray(session.areaIds) ? session.areaIds.map(String) : [], includesTenantDevices: session.includesTenantDevices, approvedAt: session.approvedAt, expiresAt: session.expiresAt, redeemedAt: session.redeemedAt, endedAt: session.endedAt, hubRevokePending: session.hubRevokePending };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = text(body.action);
  if (!['request', 'approve', 'issue-code', 'redeem', 'status', 'revoke', 'end', 'close'].includes(action)) return apiBadRequest('A supported support-access action is required.');
  const current = await getCurrentUserFromRequest(req);
  if (!current) return apiFailFromStatus(401, 'Authentication required.');
  const requestId = text(body.ticketId || body.requestId);

  if (action === 'request') {
    const operator = await requireCompanyHomeSupportViewer(req);
    if (operator instanceof NextResponse) return operator;
    const homeId = Number(body.homeId);
    const targetUserId = body.targetUserId == null ? null : Number(body.targetUserId);
    const scope = text(body.scope);
    const areaIds = [...new Set((Array.isArray(body.areaIds) ? body.areaIds : []).map(String).filter(Boolean))];
    if (!Number.isInteger(homeId) || homeId < 1 || !['TENANT_SCOPE', 'PROPERTY_SCOPE'].includes(scope)) return apiBadRequest('Home, support scope and areas are required.');
    if (scope === 'TENANT_SCOPE' && (!targetUserId || areaIds.length === 0)) return apiBadRequest('Tenant support requires the target tenant and exact areas.');
    if (!(await checkRateLimit(`support-v2-request:${operator.userId}:${homeId}`, { maxRequests: 10, windowMs: 15 * 60_000 }))) return apiFailFromStatus(429, 'Too many support requests.');
    const hub = await prisma.hubInstall.findUnique({ where: { homeId }, select: { id: true } });
    if (!hub) return apiFailFromStatus(404, 'No Dinodia OS hub is linked to this home.');
    const target = targetUserId ? await getActiveHomeMembership(targetUserId, homeId) : null;
    if (scope === 'TENANT_SCOPE' && (!target || target.role !== HomeMembershipRole.TENANT || !hasEveryAreaGrant(target, areaIds))) return apiFailFromStatus(403, 'The requested tenant scope is not currently authorised.');
    const { session } = await prisma.$transaction(async (tx) => {
      const createdTicket = await tx.supportRequest.create({ data: { kind: SupportRequestKind.HOME_ACCESS, homeId, targetUserId, installerUserId: operator.userId, reason: text(body.reason).slice(0, 1000), scope: 'VIEW_HOME_STATUS' } });
      const createdSession = await tx.supportAccessSession.create({ data: { supportRequestId: createdTicket.id, assignedEmployeeId: operator.userId, assignedEmployeePrincipalId: operator.employeePrincipalId, homeId, targetUserId, scope, areaIds, includesTenantDevices: scope === 'TENANT_SCOPE' } });
      await tx.auditEvent.create({ data: { homeId, actorUserId: operator.userId, type: 'SUPPORT_REQUEST_CREATED', metadata: { sessionId: createdSession.id, ticketId: createdTicket.id, supportScope: scope, targetUserId, areaCount: areaIds.length, outcome: 'pending_customer_approval' } } });
      return { session: createdSession };
    });
    return NextResponse.json(responseSession(session), { status: 201, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!requestId) return apiBadRequest('A support ticket is required.');
  const session = await prisma.supportAccessSession.findFirst({ where: { OR: [{ id: requestId }, { supportRequestId: requestId }] } });
  if (!session) return apiFailFromStatus(404, 'Support access request not found.');
  const isAssignedEmployee = current.id === session.assignedEmployeeId;
  const member = await getActiveHomeMembership(current.id, session.homeId);

  if (action === 'approve') {
    if (!member || member.status !== HomeMembershipStatus.ACTIVE || !([HomeMembershipRole.OWNER, HomeMembershipRole.PROPERTY_MANAGER, HomeMembershipRole.TENANT] as HomeMembershipRole[]).includes(member.role)) return apiFailFromStatus(403, 'Only an authorised home member can approve support access.');
    if (session.scope === 'TENANT_SCOPE' && (member.role !== HomeMembershipRole.TENANT || session.targetUserId !== current.id)) return apiFailFromStatus(403, 'This tenant approval is not for the signed-in tenant.');
    if (session.scope === 'PROPERTY_SCOPE' && member.role === HomeMembershipRole.TENANT) return apiFailFromStatus(403, 'A tenant cannot approve property-wide support access.');
    const approved = await prisma.supportAccessSession.updateMany({ where: { id: session.id, status: 'PENDING', endedAt: null }, data: { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: current.id, expiresAt: new Date(Date.now() + SESSION_MAX_MS) } });
    if (approved.count !== 1) return apiFailFromStatus(409, 'The support request is no longer awaiting approval.');
    const latest = await prisma.supportAccessSession.findUniqueOrThrow({ where: { id: session.id } });
    await prisma.auditEvent.create({ data: { homeId: session.homeId, actorUserId: current.id, type: 'SUPPORT_REQUEST_APPROVED', metadata: { sessionId: session.id, ticketId: session.supportRequestId, supportScope: session.scope, outcome: 'approved' } } });
    return NextResponse.json(responseSession(latest), { headers: { 'Cache-Control': 'no-store' } });
  }

  if (action === 'issue-code') {
    const operator = await requireCompanyHomeSupportViewer(req);
    if (operator instanceof NextResponse) return operator;
    if (!isAssignedEmployee || operator.userId !== session.assignedEmployeeId || operator.employeePrincipalId !== session.assignedEmployeePrincipalId) return apiFailFromStatus(403, 'Only the assigned support employee can issue the access code.');
    if (session.status !== 'APPROVED' || !session.approvedAt || !session.expiresAt || Date.now() >= session.expiresAt.getTime()) return apiFailFromStatus(409, 'The approval is not active.');
    const code = `DNO-SUPPORT-${crypto.randomBytes(18).toString('base64url')}`;
    const employeeProof = `DNO-EMPLOYEE-${crypto.randomBytes(24).toString('base64url')}`;
    const issuedAt = new Date();
    const issued = await prisma.supportAccessSession.updateMany({ where: { id: session.id, status: 'APPROVED', codeHash: null, codeRevealedAt: null, employeeProofHash: null, endedAt: null, expiresAt: { gt: issuedAt } }, data: { codeHash: hash(code), codeIssuedAt: issuedAt, codeRevealedAt: issuedAt, codeExpiresAt: new Date(issuedAt.getTime() + CODE_TTL_MS), employeeProofHash: hash(employeeProof), employeeProofExpiresAt: new Date(issuedAt.getTime() + CODE_TTL_MS), codeAttemptCount: 0 } });
    if (issued.count !== 1) return apiFailFromStatus(409, 'The one-use support code has already been issued.');
    await prisma.auditEvent.create({ data: { homeId: session.homeId, actorUserId: operator.userId, type: 'SUPPORT_V2_CODE_ISSUED', metadata: { sessionId: session.id, ticketId: session.supportRequestId, delivery: 'reveal_once', expiresAt: new Date(issuedAt.getTime() + CODE_TTL_MS).toISOString(), outcome: 'issued' } } });
    // Reveal once in the assigned employee's authenticated portal session.
    // The portal must clear this value on navigation/background; it is never
    // persisted or returned again. Redemption still requires this same
    // assigned employee principal and the correct hub-bound session.
    return NextResponse.json({ ok: true, ticketId: session.supportRequestId, delivery: 'reveal_once', code, employeeProof, expiresAt: new Date(issuedAt.getTime() + CODE_TTL_MS).toISOString() }, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }

  if (action === 'redeem') {
    // Redemption is deliberately hub-authenticated. A browser or ordinary
    // Company Portal request must never be able to turn a code into an active
    // OS session, even when it knows the code and employee proof.
    return apiFailFromStatus(403, 'Support redemption must be performed by the paired Dinodia OS hub.');
  }

  if (action === 'status') {
    if (!isAssignedEmployee && (!member || member.status !== HomeMembershipStatus.ACTIVE)) return apiFailFromStatus(403, 'Support request visibility is restricted to the assigned employee and home members.');
    return NextResponse.json(responseSession(session), { headers: { 'Cache-Control': 'no-store' } });
  }

  const canCustomerEnd = Boolean(member && member.status === HomeMembershipStatus.ACTIVE && (
    member.role === HomeMembershipRole.OWNER ||
    member.role === HomeMembershipRole.PROPERTY_MANAGER ||
    (member.role === HomeMembershipRole.TENANT && session.targetUserId === current.id)
  ));
  if (!isAssignedEmployee && !canCustomerEnd) return apiFailFromStatus(403, 'Only the assigned employee or the approving customer can end support access.');
  const endedAt = new Date();
  const updated = await prisma.supportAccessSession.updateMany({ where: { id: session.id, status: { in: ['PENDING', 'APPROVED', 'ACTIVE'] }, endedAt: null }, data: { status: action === 'revoke' ? 'REVOKED' : 'CLOSED', endedAt, codeHash: null, codeIssuedAt: null, codeExpiresAt: null, employeeProofHash: null, employeeProofExpiresAt: null, codeAttemptCount: 0, hubRevokePending: true, hubRevocationDesiredAt: endedAt } });
  if (updated.count !== 1) return apiFailFromStatus(409, 'Support access is already closed.');
  const latest = await prisma.supportAccessSession.findUniqueOrThrow({ where: { id: session.id } });
  await prisma.auditEvent.create({ data: { homeId: session.homeId, actorUserId: current.id, type: action === 'revoke' ? 'SUPPORT_REQUEST_REVOKED' : 'SUPPORT_V2_ACCESS_CLOSED', metadata: { sessionId: session.id, ticketId: session.supportRequestId, outcome: action === 'revoke' ? 'revoked' : 'closed', hubRevocationPending: true } } });
  return NextResponse.json(responseSession(latest), { headers: { 'Cache-Control': 'no-store' } });
}
