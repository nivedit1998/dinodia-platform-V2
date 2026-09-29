import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomer, Stage1AuthError } from '@/lib/stage1Auth';
import { validateOfflineAuthorisationReceipt, validateOfflineAuthorisationRequest, validateOfflineRevocationReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomer(request);
    if (customer.role !== 'TENANT') throw new Stage1AuthError(403, 'offline_scope_denied', 'Only tenants receive local device command authority');
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !validateOfflineAuthorisationRequest(body)) throw new Stage1AuthError(400, 'offline_device_invalid', 'A valid enrolled trusted-device identity and public key are required');
    const publicKey = String(body.publicKey ?? '').trim();
    if (!publicKey || String(body.trustedDeviceId ?? '') !== customer.trustedDeviceId) throw new Stage1AuthError(403, 'offline_device_denied', 'The trusted device does not match the current app session');
    let suppliedThumbprint: string;
    try { suppliedThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex'); } catch { throw new Stage1AuthError(400, 'offline_device_key_invalid', 'The trusted-device public key is invalid'); }
    const registeredThumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(customer.trustedDevicePublicKey).export({ type: 'spki', format: 'der' })).digest('hex');
    if (suppliedThumbprint !== registeredThumbprint) throw new Stage1AuthError(403, 'offline_device_key_denied', 'The supplied key is not the enrolled trusted-device key');
    const grants = await prisma.tenantAreaGrant.findMany({ where: { membershipId: customer.membershipId, revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } });
    const thumbprint = suppliedThumbprint;
    const row = await prisma.offlineMembershipAuthorisation.upsert({ where: { trustedDeviceId_membershipId_hubInstallationId: { trustedDeviceId: customer.trustedDeviceId, membershipId: customer.membershipId, hubInstallationId: customer.hubInstallationId } }, create: { trustedDeviceId: customer.trustedDeviceId, membershipId: customer.membershipId, homeId: customer.homeId, hubInstallationId: customer.hubInstallationId, publicKey, publicKeyThumbprint: thumbprint, areaIds: grants.map((grant) => grant.areaId), scopes: ['tenant:device-command'], policyRevision: customer.policyRevision }, update: { publicKey, publicKeyThumbprint: thumbprint, areaIds: grants.map((grant) => grant.areaId), scopes: ['tenant:device-command'], policyRevision: customer.policyRevision, revokedAt: null, revokeReason: null } });
    const receipt = { ok: true, authorisation: { id: row.id, homeId: row.homeId, membershipId: row.membershipId, trustedDeviceId: row.trustedDeviceId, areaIds: row.areaIds, scopes: row.scopes, policyRevision: row.policyRevision } };
    if (!validateOfflineAuthorisationReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The offline-authorisation response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const revoked = await prisma.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: customer.trustedDeviceId, membershipId: customer.membershipId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'customer_removed_local_authority' } });
    const receipt = { ok: true, revoked: revoked.count };
    if (!validateOfflineRevocationReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The offline-revocation response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
