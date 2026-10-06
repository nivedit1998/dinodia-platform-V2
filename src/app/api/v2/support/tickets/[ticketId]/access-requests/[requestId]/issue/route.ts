import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireEmployeeRecentAuth, Stage1AuthError } from '@/lib/stage1Auth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { createHubBoundOperatorGrant, encryptOperatorGrant, supportRedeemDigest } from '@/lib/stage1Operator';
import { validateSupportAccessIssueReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ ticketId: string; requestId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER', 'SENIOR_CUSTOMER_SUPPORT']);
    const { ticketId, requestId } = await context.params;
    const row = await prisma.supportAccessRequest.findUnique({ where: { id: requestId }, select: { id: true, ticketId: true, homeId: true, hubInstallationId: true, status: true, requestedByEmployeeId: true, requestedScope: true, canonicalAreaIds: true, touchesPropertyInfrastructure: true, approvedAt: true, sessionHardStopAt: true, codeHash: true, codeConsumedAt: true } });
    if (!row || row.ticketId !== ticketId || row.requestedByEmployeeId !== employee.id || row.status !== 'APPROVED') throw new Stage1AuthError(403, 'support_issue_denied', 'The support request is not approved for this employee');
    const issuedAt = new Date();
    if (!row.approvedAt || !row.sessionHardStopAt || row.sessionHardStopAt <= issuedAt || row.codeHash || row.codeConsumedAt) throw new Stage1AuthError(409, 'support_code_unavailable', 'The approved support request is unavailable or expired');
    const oneUseCode = `DNO-S-${randomSecret(18)}`;
    const codeHash = sha256(oneUseCode);
    const expiresAt = new Date(Math.min(issuedAt.getTime() + 10 * 60 * 1000, row.sessionHardStopAt.getTime()));
    const hub = await prisma.hubInstallation.findUnique({ where: { id: row.hubInstallationId }, select: { serialNumberSnapshot: true, cloudUrl: true, manufacturingIdentity: { select: { encryptionPublicKey: true, identityGeneration: true } } } });
    if (!hub) throw new Stage1AuthError(409, 'hub_not_available', 'The support hub is not available');
    if (!hub.cloudUrl) throw new Stage1AuthError(409, 'hub_cloud_url_unavailable', 'The hub secure support endpoint is not available yet');
    const employeeGrant = createHubBoundOperatorGrant({ employeeId: employee.id, hubId: hub.serialNumberSnapshot, workflowId: row.ticketId, requestId: row.id, homeId: row.homeId, identityGeneration: hub.manufacturingIdentity.identityGeneration, requestBodyDigest: supportRedeemDigest({ serial: hub.serialNumberSnapshot, ticketId: row.ticketId, requestId: row.id, codeHash, identityGeneration: hub.manufacturingIdentity.identityGeneration }), scope: ['support:redeem'], areaIds: Array.isArray(row.canonicalAreaIds) ? row.canonicalAreaIds.map(String) : [], recentAuthAt: Date.now(), expiresAt: expiresAt.getTime(), credentialVersion: 0 });
    const proofKeyPair = crypto.generateKeyPairSync('ed25519');
    const employeeProofPublicKey = proofKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const employeeProofPrivateKey = proofKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const encryptedProofPayload = JSON.stringify({ version: 2, employeeGrant, employeeProofPrivateKey });
    const employeeProofEnvelope = JSON.stringify(encryptOperatorGrant(encryptedProofPayload, hub.manufacturingIdentity.encryptionPublicKey, 1, 'support-session'));
    const employeeHandoffEnvelope = employeeProofEnvelope;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "SupportAccessRequest" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
      const now = new Date();
      const current = await tx.supportAccessRequest.findUnique({ where: { id: row.id }, select: { status: true, ticketId: true, requestedByEmployeeId: true, approvedAt: true, sessionHardStopAt: true, codeHash: true, codeConsumedAt: true } });
      const currentTicket = await tx.supportTicket.findUnique({ where: { id: row.ticketId }, select: { status: true, homeId: true } });
      if (!current || current.status !== 'APPROVED' || current.ticketId !== ticketId || current.requestedByEmployeeId !== employee.id
        || !current.approvedAt || !current.sessionHardStopAt || current.sessionHardStopAt <= now || current.codeHash || current.codeConsumedAt
        || !currentTicket || currentTicket.status !== 'OPEN' || currentTicket.homeId !== row.homeId || expiresAt <= now) {
        throw new Stage1AuthError(409, 'support_code_unavailable', 'The approved support request is no longer current');
      }
      const updated = await tx.supportAccessRequest.updateMany({ where: { id: row.id, requestedByEmployeeId: employee.id, status: 'APPROVED', codeHash: null, codeConsumedAt: null, sessionHardStopAt: { gt: now } }, data: { status: 'ISSUED', codeHash, codeIssuedAt: now, codeExpiresAt: expiresAt, employeeHandoffHash: sha256(employeeGrant), employeeProofPublicKey, employeeHandoffEnvelope: employeeHandoffEnvelope, employeeHandoffIssuedAt: now, employeeHandoffExpiresAt: expiresAt } });
      if (updated.count !== 1) throw new Stage1AuthError(409, 'support_code_already_issued', 'A support code has already been issued or the request is no longer approved');
      await tx.auditEvent.create({ data: { homeId: row.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'support_access_issued', targetType: 'SupportAccessRequest', targetId: row.id, metadata: { ticketId: row.ticketId, scope: row.requestedScope, touchesPropertyInfrastructure: row.touchesPropertyInfrastructure, outcome: 'issued' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    });
    // This is the only plaintext disclosure: the assigned, recently
    // authenticated employee's Company Portal response. The database retains
    // only codeHash; neither the customer approval nor URL contains the code.
    const receipt = { ok: true, requestId: row.id, status: 'ISSUED', oneUseCode,
      supportUrl: `${hub.cloudUrl.replace(/\/$/, '')}/support-access`, codeExpiresAt: expiresAt.toISOString() };
    if (!validateSupportAccessIssueReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The employee support-issue response failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
