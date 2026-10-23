import type { Prisma } from '@prisma/client';
import { Stage1AuthError, type EmployeePrincipal } from './stage1Auth';
import { changeAnalyticsInterval } from './analyticsIntervals';
import { buildHubCloudConfiguration, finalizeHubCloudConfiguration } from './hubCloudConfiguration';
import { sha256 } from './stage1Crypto';

const namespace = 'analytics-installation-activation:v1';
export async function setAnalyticsActivation(tx: Prisma.TransactionClient, actor: EmployeePrincipal, input: {
  homeId: string; hubInstallationId: string; operationId: string; expectedCloudRevision: number;
  expectedWriterEnabled: boolean; expectedCollectionEnabled: boolean; writerEnabled: boolean; collectionEnabled: boolean;
}, now = new Date()) {
  if (!['CXO', 'SENIOR_OPERATIONS_MANAGER'].includes(actor.role) || actor.expiresAt <= now.getTime()
    || now.getTime() - actor.recentAuthenticatedAt >= 300000) throw new Stage1AuthError(403, 'analytics_activation_authority_required');
  await tx.$queryRaw`SELECT id FROM "Home" WHERE id = ${input.homeId}::uuid FOR UPDATE`;
  const hub = await tx.hubInstallation.findFirst({ where: { id: input.hubInstallationId, homeId: input.homeId,
    home: { is: { activeHubInstallationId: input.hubInstallationId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } } },
    include: { manufacturingIdentity: true } });
  if (!hub) throw new Stage1AuthError(404, 'analytics_installation_unavailable');
  const keyHash = sha256(input.operationId), requestHash = sha256(JSON.stringify(input));
  const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } } });
  if (prior) {
    if (prior.actorId !== actor.id || prior.homeId !== input.homeId || prior.hubInstallationId !== hub.id || prior.requestHash !== requestHash)
      throw new Stage1AuthError(409, 'analytics_activation_idempotency_conflict');
    return prior.responseBody;
  }
  if (hub.cloudConfigurationRevision !== input.expectedCloudRevision || hub.analyticsWriterEnabled !== input.expectedWriterEnabled
    || hub.analyticsCollectionEnabled !== input.expectedCollectionEnabled) throw new Stage1AuthError(409, 'analytics_activation_revision_conflict');
  const capability = hub.capabilitySummary as Record<string, unknown> | null;
  if ((input.writerEnabled || input.collectionEnabled) && (capability?.nativeUniversalAnalyticsV2 !== true || !hub.manufacturingIdentity))
    throw new Stage1AuthError(409, 'analytics_compatible_hub_required');
  // Disabling remains possible with a lost capability or identity. Enabling
  // seeds/renews canonical epochs under the same Home lock and audit boundary.
  if (input.writerEnabled || input.collectionEnabled) {
    const devices = await tx.nativeDevice.findMany({ where: { homeId: input.homeId, hubInstallationId: hub.id,
      managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] } }, orderBy: { id: 'asc' }, take: 2001 });
    if (devices.length > 2000) throw new Stage1AuthError(413, 'analytics_installation_limit');
    for (const device of devices) {
      const interval = await tx.nativeAnalyticsInterval.findFirst({ where: { deviceId: device.id, validUntil: null } });
      await changeAnalyticsInterval(tx, { homeId: input.homeId, hubInstallationId: hub.id, deviceId: device.id,
        category: device.analyticsCategory, selectedControlId: interval?.selectedControlId ?? null,
        generation: hub.manufacturingIdentity!.identityGeneration, at: now,
        // A resumed writer needs a distinct key: merging separated same-hour
        // spans under one absolute bucket would falsely bridge the pause.
        forceNew: input.writerEnabled && !hub.analyticsWriterEnabled });
    }
  }
  await tx.hubInstallation.update({ where: { id: hub.id }, data: {
    analyticsWriterEnabled: input.writerEnabled, analyticsCollectionEnabled: input.collectionEnabled } });
  await tx.home.update({ where: { id: input.homeId }, data: { managementRevision: { increment: 1 } } });
  const candidate = await buildHubCloudConfiguration(tx, { homeId: input.homeId, hubInstallationId: hub.id });
  const configuration = finalizeHubCloudConfiguration(candidate, hub.cloudConfigurationRevision + 1);
  await tx.hubInstallation.update({ where: { id: hub.id }, data: { cloudConfigurationRevision: configuration.revision,
    cloudConfigurationChecksum: configuration.checksum } });
  const result = { writerEnabled: input.writerEnabled, collectionEnabled: input.collectionEnabled,
    cloudRevision: configuration.revision, checksum: configuration.checksum, acknowledged: false };
  const purgeAt = new Date(now.getTime() + 365 * 86400000);
  await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'EMPLOYEE', actorId: actor.id,
    category: 'MANAGEMENT', action: 'analytics_installation_activation_changed', targetType: 'HubInstallation', targetId: hub.id,
    metadata: { ...result, operationId: input.operationId, previousWriterEnabled: hub.analyticsWriterEnabled,
      previousCollectionEnabled: hub.analyticsCollectionEnabled }, occurredAt: now, purgeAt } });
  await tx.idempotencyRecord.create({ data: { namespace, keyHash, requestHash, actorId: actor.id, homeId: input.homeId,
    hubInstallationId: hub.id, responseStatus: 200, responseBody: result, expiresAt: new Date(now.getTime() + 86400000) } });
  return result;
}
