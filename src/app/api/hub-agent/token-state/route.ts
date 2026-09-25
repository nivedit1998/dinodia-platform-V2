import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { authErrorResponse } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

function signEnvelope(payload: Record<string, unknown>): string {
  const pem = String(process.env.DINODIA_APP_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
  if (!pem) throw new Error('Offline authorisation signing is not configured');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${crypto.sign(null, Buffer.from(encoded, 'utf8'), crypto.createPrivateKey(pem)).toString('base64url')}`;
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const now = new Date();
    const operatorVersion = Number(hub.body.operatorCredentialVersion ?? 0);
    const pending = await prisma.hubCredentialVersion.findMany({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: { in: ['PENDING', 'DELIVERED'] } }, orderBy: { version: 'asc' }, select: { id: true, version: true, encryptedDeliveryEnvelope: true, state: true } });
    const delivery = pending.find((row) => row.version > operatorVersion && row.encryptedDeliveryEnvelope && typeof row.encryptedDeliveryEnvelope === 'object');
    if (delivery) await prisma.hubCredentialVersion.update({ where: { id: delivery.id }, data: { state: 'DELIVERED', deliveredAt: now, deliveryAttempts: { increment: 1 } } });
    await prisma.hubInstallation.update({ where: { id: hub.installation.id }, data: { lastSeenAt: now, onlineStateEvaluatedAt: now } });
    const latest = await prisma.hubCredentialVersion.aggregate({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential' }, _max: { version: true } });
    const operatorCredentialStates = await prisma.hubCredentialVersion.findMany({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: { in: ['ACTIVE', 'GRACE'] } }, orderBy: { version: 'asc' }, select: { version: true, state: true, graceUntil: true, revokedAt: true } });
    const offlineRows = await prisma.offlineMembershipAuthorisation.findMany({ where: { hubInstallationId: hub.installation.id }, select: { id: true, trustedDeviceId: true, membershipId: true, homeId: true, hubInstallationId: true, publicKey: true, areaIds: true, scopes: true, policyRevision: true, issuedAt: true, revokedAt: true, revokeReason: true } });
    const offlineAuthorisations = offlineRows.map((row) => {
      const payload = { version: 1, id: row.id, trustedDeviceId: row.trustedDeviceId, membershipId: row.membershipId, homeId: row.homeId, hubInstallId: row.hubInstallationId, publicKey: row.publicKey, areaIds: row.areaIds, scope: row.scopes, householdRole: 'TENANT', policyRevision: row.policyRevision, issuedAt: row.issuedAt.getTime(), revokedAt: row.revokedAt?.getTime() ?? null, revokeReason: row.revokeReason ?? null };
      return { payload, signature: signEnvelope(payload) };
    });
    return NextResponse.json({ ok: true, latestVersion: latest._max.version ?? 0, operatorCredentialDelivery: delivery ? { version: delivery.version, envelope: delivery.encryptedDeliveryEnvelope } : null, operatorCredentialStates, offlineAuthorisations, policyRevision: hub.installation.accessPolicyRevision }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
