import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { sha256 } from '@/lib/stage1Crypto';
import { createHubBoundOperatorGrant, encryptOperatorGrant, supportRedeemDigest } from '@/lib/stage1Operator';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ ticketId: string; requestId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER', 'SENIOR_CUSTOMER_SUPPORT']);
    const { ticketId, requestId } = await context.params;
    const row = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, hubInstallationId: true, status: true, requestedByEmployeeId: true, requestedScope: true, canonicalAreaIds: true, touchesPropertyInfrastructure: true, sessionHardStopAt: true } });
    if (!row || row.ticketId !== ticketId || row.requestedByEmployeeId !== employee.id || row.status !== 'APPROVED') throw new Stage1AuthError(403, 'support_issue_denied', 'The support request is not approved for this employee');
    const issuedAt = new Date();
    const approved = await prisma.supportAccessRequest.findUnique({ where: { id: row.id }, select: { codeHash: true, codeExpiresAt: true, sessionHardStopAt: true } });
    if (!approved?.codeHash || !approved.codeExpiresAt || approved.codeExpiresAt <= issuedAt || !approved.sessionHardStopAt || approved.sessionHardStopAt <= issuedAt) throw new Stage1AuthError(409, 'support_code_unavailable', 'The customer-approved one-use code is unavailable or expired');
    const expiresAt = approved.codeExpiresAt;
    const hub = await prisma.hubInstallation.findUnique({ where: { id: row.hubInstallationId }, select: { serialNumberSnapshot: true, cloudUrl: true, manufacturingIdentity: { select: { encryptionPublicKey: true, identityGeneration: true } } } });
    if (!hub) throw new Stage1AuthError(409, 'hub_not_available', 'The support hub is not available');
    if (!hub.cloudUrl) throw new Stage1AuthError(409, 'hub_cloud_url_unavailable', 'The hub secure support endpoint is not available yet');
    const employeeGrant = createHubBoundOperatorGrant({ employeeId: employee.id, hubId: hub.serialNumberSnapshot, workflowId: row.ticketId, requestId: row.id, homeId: row.homeId, identityGeneration: hub.manufacturingIdentity.identityGeneration, requestBodyDigest: supportRedeemDigest({ serial: hub.serialNumberSnapshot, ticketId: row.ticketId, requestId: row.id, codeHash: approved.codeHash, identityGeneration: hub.manufacturingIdentity.identityGeneration }), scope: ['support:redeem'], areaIds: Array.isArray(row.canonicalAreaIds) ? row.canonicalAreaIds.map(String) : [], recentAuthAt: Date.now(), expiresAt: expiresAt.getTime(), credentialVersion: 0 });
    const employeeProofEnvelope = JSON.stringify(encryptOperatorGrant(employeeGrant, hub.manufacturingIdentity.encryptionPublicKey, 1, 'support-session'));
    const employeeHandoffEnvelope = employeeProofEnvelope;
    await prisma.$transaction(async (tx) => {
      const updated = await tx.supportAccessRequest.updateMany({ where: { id: row.id, requestedByEmployeeId: employee.id, status: 'APPROVED', codeHash: approved.codeHash, codeConsumedAt: null }, data: { status: 'ISSUED', employeeHandoffHash: sha256(employeeGrant), employeeHandoffEnvelope: employeeHandoffEnvelope, employeeHandoffIssuedAt: issuedAt, employeeHandoffExpiresAt: expiresAt } });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'support_code_already_issued', 'A support code has already been issued or the request is no longer approved');
      await tx.auditEvent.create({ data: { homeId: row.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'support_access_issued', targetType: 'SupportAccessRequest', targetId: row.id, metadata: { ticketId: row.ticketId, scope: row.requestedScope, touchesPropertyInfrastructure: row.touchesPropertyInfrastructure, outcome: 'issued' }, purgeAt: new Date(issuedAt.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    });
    // The customer-approved code may be delivered to the support workflow,
    // but the employee proof is hub-confidential.  Store the encrypted
    // envelope for the authenticated hub to fetch over its machine channel;
    // never put it in a browser/API response.
    return NextResponse.json({ ok: true, requestId: row.id, status: 'ISSUED', supportUrl: `${hub.cloudUrl.replace(/\/$/, '')}/support-access`, codeExpiresAt: expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
