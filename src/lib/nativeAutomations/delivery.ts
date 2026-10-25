import type { Prisma } from '@prisma/client';
import { buildHubCloudConfiguration, finalizeHubCloudConfiguration } from '../hubCloudConfiguration';

/**
 * Publish the exact desired full-home bundle revision in the same transaction
 * as an automation/policy mutation. The next Stage 5 hub poll returns this
 * revision; no automation-specific scheduler or delta channel is introduced.
 */
export async function refreshNativeAutomationCloudRevision(db: Prisma.TransactionClient, input: {
  homeId: string; hubInstallationId: string;
}) {
  const hub = await db.hubInstallation.findFirst({ where: { id: input.hubInstallationId, homeId: input.homeId, lifecycleStatus: 'ACTIVE' },
    select: { id: true, cloudConfigurationRevision: true, cloudConfigurationChecksum: true } });
  if (!hub) throw new Error('Current Home hub is unavailable for automation configuration publication');
  const candidate = await buildHubCloudConfiguration(db, input);
  const sameRevision = finalizeHubCloudConfiguration(candidate as unknown as Record<string, unknown>, hub.cloudConfigurationRevision);
  if (sameRevision.checksum === hub.cloudConfigurationChecksum) return { revision: hub.cloudConfigurationRevision, changed: false };
  const revision = hub.cloudConfigurationRevision + 1;
  const next = finalizeHubCloudConfiguration(candidate as unknown as Record<string, unknown>, revision);
  const saved = await db.hubInstallation.updateMany({ where: { id: hub.id, homeId: input.homeId,
    lifecycleStatus: 'ACTIVE', cloudConfigurationRevision: hub.cloudConfigurationRevision,
    cloudConfigurationChecksum: hub.cloudConfigurationChecksum }, data: { cloudConfigurationRevision: revision, cloudConfigurationChecksum: next.checksum } });
  if (saved.count !== 1) throw new Error('Hub configuration changed while publishing automation revision');
  return { revision, changed: true };
}
