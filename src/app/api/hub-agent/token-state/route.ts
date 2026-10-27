import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { authErrorResponse } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { resolveNativeInstallationSyncMode } from '@/lib/nativeInstallationSyncMode';
import { recordUniversalAnalyticsCompatibility, universalAnalyticsEnabled } from '@/lib/universalAnalyticsCompatibility';

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
    if (universalAnalyticsEnabled()) await prisma.$transaction(tx => recordUniversalAnalyticsCompatibility(tx,{
      homeId:hub.installation.homeId,hubInstallationId:hub.installation.id,identity:hub.identity,
      declaration:hub.body.analyticsContract,requestNonce:request.headers.get('x-dinodia-hub-nonce') || '',now,
    }),{isolationLevel:'Serializable',maxWait:5000,timeout:12000});
    const operatorVersion = Number(hub.body.operatorCredentialVersion ?? 0);
    const delivery = await prisma.$transaction(async (tx) => {
      const pending = await tx.hubCredentialVersion.findMany({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: { in: ['PENDING', 'DELIVERED'] }, revokedAt: null }, orderBy: { version: 'asc' }, select: { id: true, version: true, encryptedDeliveryEnvelope: true, state: true } });
      const candidate = pending.find((row) => row.version > operatorVersion && row.encryptedDeliveryEnvelope && typeof row.encryptedDeliveryEnvelope === 'object');
      if (!candidate) return null;
      const changed = await tx.hubCredentialVersion.updateMany({
        where: { id: candidate.id, hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: candidate.state, revokedAt: null },
        data: candidate.state === 'PENDING'
          ? { state: 'DELIVERED', deliveredAt: now, deliveryAttempts: { increment: 1 } }
          : { deliveryAttempts: { increment: 1 } },
      });
      if (changed.count !== 1) return null;
      if (candidate.state === 'PENDING') {
        await tx.auditEvent.create({ data: {
          homeId: hub.installation.homeId,
          actorType: 'HUB',
          actorId: hub.installation.id,
          category: 'SECURITY',
          action: 'operator_credential_delivered',
          targetType: 'HubCredentialVersion',
          targetId: candidate.id,
          metadata: { version: candidate.version, outcome: 'delivered' },
          purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        } });
      }
      return { version: candidate.version, envelope: candidate.encryptedDeliveryEnvelope };
    });
    // This bounded credential/bootstrap bridge is not the signed liveness
    // authority. Only the dedicated heartbeat route advances lastSeenAt, and
    // OS sends that heartbeat after current sync policy has been applied.
    const latest = await prisma.hubCredentialVersion.aggregate({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential' }, _max: { version: true } });
    const operatorCredentialStates = await prisma.hubCredentialVersion.findMany({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: { in: ['ACTIVE', 'GRACE'] } }, orderBy: { version: 'asc' }, select: { version: true, state: true, graceUntil: true, revokedAt: true } });
    const offlineRows = await prisma.offlineMembershipAuthorisation.findMany({ where: { hubInstallationId: hub.installation.id }, select: { id: true, trustedDeviceId: true, membershipId: true, homeId: true, hubInstallationId: true, publicKey: true, areaIds: true, scopes: true, policyRevision: true, issuedAt: true, revokedAt: true, revokeReason: true } });
    const homeAreas = await prisma.area.findMany({ where: { homeId: hub.installation.homeId, status: 'ACTIVE' }, orderBy: [{ id: 'asc' }], select: { id: true, osAreaId: true } });
    const [syncInstallation, syncHome, openAssignedInstallationWorkCount, activeMembershipCount] = await Promise.all([
      prisma.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: { id: true, state: true, lifecycleStatus: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, syncStreamId: true, syncAcceptedSequence: true, cloudConfigurationRevision: true, acknowledgedCloudRevision: true } }),
      prisma.home.findUnique({ where: { id: hub.installation.homeId }, select: { id: true, lifecycle: true, installationStatus: true, activeHubInstallationId: true } }),
      prisma.companyOperationalWorkItem.count({ where: {
        homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, kind: 'INITIAL_HUB_INSTALLATION',
        state: { in: ['IN_PROGRESS', 'REOPENED'] }, assignedEmployee: { status: 'ACTIVE' },
      } }),
      prisma.homeMembership.count({ where: { homeId: hub.installation.homeId, status: 'ACTIVE' } }),
    ]);
    const installationSyncMode = syncInstallation && syncHome
      ? resolveNativeInstallationSyncMode({
        hubId: syncInstallation.id, hubState: syncInstallation.state, hubLifecycleStatus: syncInstallation.lifecycleStatus,
        cloudUrlVerifiedAt: syncInstallation.cloudUrlVerifiedAt, remoteVerificationAt: syncInstallation.remoteVerificationAt,
        homeId: syncHome.id, homeLifecycle: syncHome.lifecycle, installationStatus: syncHome.installationStatus,
        activeHubInstallationId: syncHome.activeHubInstallationId, openAssignedInstallationWorkCount, activeMembershipCount, now,
      })
      : 'UNAVAILABLE';
    const areaBindings = homeAreas.map((area) => ({ areaId: area.id, hubAreaId: area.osAreaId }));
    const offlineMemberships = await prisma.homeMembership.findMany({ where: { id: { in: offlineRows.map((row) => row.membershipId) } }, select: { id: true, customerAccountId: true } });
    const offlineAccountByMembership = new Map(offlineMemberships.map((membership) => [membership.id, membership.customerAccountId]));
    const offlineAuthorisations = offlineRows.map((row) => {
      const payload = { version: 1, id: row.id, customerAccountId: offlineAccountByMembership.get(row.membershipId) ?? '', trustedDeviceId: row.trustedDeviceId, membershipId: row.membershipId, homeId: row.homeId, hubInstallId: row.hubInstallationId, publicKey: row.publicKey, areaIds: row.areaIds, scope: row.scopes, householdRole: 'TENANT', policyRevision: row.policyRevision, issuedAt: row.issuedAt.getTime(), revokedAt: row.revokedAt?.getTime() ?? null, revokeReason: row.revokeReason ?? null };
      return { payload, signature: signEnvelope(payload) };
    });
    return NextResponse.json({ ok: true, hubInstallId: hub.installation.id, homeId: hub.installation.homeId, latestVersion: latest._max.version ?? 0, operatorCredentialDelivery: delivery, operatorCredentialStates, offlineAuthorisations, areaBindings, policyRevision: hub.installation.accessPolicyRevision, installationSyncMode, syncStreamId: syncInstallation?.syncStreamId ?? null, syncAcceptedSequence: Number(syncInstallation?.syncAcceptedSequence ?? 0), cloudConfigurationRevision: Number(syncInstallation?.cloudConfigurationRevision ?? 0), acknowledgedCloudRevision: Number(syncInstallation?.acknowledgedCloudRevision ?? 0) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
