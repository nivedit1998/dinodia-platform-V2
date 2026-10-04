import type { Prisma } from '@prisma/client';
import { canonicalSyncJson, hashSyncConfiguration } from './hubSyncEnvelope';

const MAX_CONFIGURATION_BYTES = 1024 * 1024;

export async function buildHubCloudConfiguration(db: Prisma.TransactionClient, input: { homeId: string; hubInstallationId: string }) {
  const [home, areas, memberships, devices, automations] = await Promise.all([
    db.home.findUnique({ where: { id: input.homeId }, select: { id: true, managementRevision: true } }),
    db.area.findMany({ where: { homeId: input.homeId, status: 'ACTIVE' }, orderBy: { id: 'asc' }, select: { id: true, osAreaId: true, originalName: true, overrideName: true, revision: true } }),
    db.homeMembership.findMany({
      where: { homeId: input.homeId, status: 'ACTIVE' }, orderBy: { id: 'asc' }, take: 100,
      select: { id: true, role: true, accessRevision: true, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, orderBy: { areaId: 'asc' }, select: { areaId: true, policyRevision: true } } },
    }),
    db.nativeDevice.findMany({ where: { homeId: input.homeId, hubInstallationId: input.hubInstallationId }, orderBy: { id: 'asc' }, take: 2000,
      select: { osDeviceId: true, managementClass: true, ownerMembershipId: true, analyticsCategory: true, lifecycle: true, customerLabel: true, overrideName: true, descriptorRevision: true, descriptorDigest: true, assignments: { where: { validUntil: null, area: { status: 'ACTIVE' } }, orderBy: { areaId: 'asc' }, take: 8, select: { areaId: true, area: { select: { osAreaId: true } } } } } }),
    db.nativeAutomation.findMany({ where: { homeId: input.homeId, status: { not: 'RETIRED' } }, orderBy: { id: 'asc' }, take: 100,
      select: { id: true, name: true, status: true, revision: true, definitionChecksum: true, timezone: true, triggers: { orderBy: { id: 'asc' }, select: { id: true, kind: true, configuration: true, revision: true } }, actions: { orderBy: { id: 'asc' }, select: { id: true, device: { select: { osDeviceId: true } }, area: { select: { osAreaId: true } }, controlId: true, descriptorRevision: true, actionValue: true, needsAttention: true } } } }),
  ]);
  if (!home) throw new Error('Hub home is no longer available');
  const unsigned = {
    revision: home.managementRevision,
    policyRevision: (await db.hubInstallation.findUnique({ where: { id: input.hubInstallationId }, select: { accessPolicyRevision: true } }))?.accessPolicyRevision ?? 0,
    areas: areas.map((area) => ({ id: area.id, osAreaId: area.osAreaId, originalName: area.originalName, overrideName: area.overrideName, revision: area.revision })),
    memberships: memberships.map((member) => ({ id: member.id, role: member.role, accessRevision: member.accessRevision, areaIds: member.tenantAreaGrants.map((grant) => grant.areaId), grantRevisions: member.tenantAreaGrants.map((grant) => ({ areaId: grant.areaId, revision: grant.policyRevision })) })),
    devicePolicies: devices.map((device) => ({
      osDeviceId: device.osDeviceId, managementClass: device.managementClass, ownerMembershipId: device.ownerMembershipId,
      lifecycle: device.lifecycle, customerLabel: device.customerLabel, overrideName: device.overrideName,
      analyticsCategory: device.analyticsCategory,
      descriptorRevision: device.descriptorRevision, descriptorDigest: device.descriptorDigest,
      osAreaIds: device.assignments.map((assignment) => assignment.area.osAreaId),
    })),
    automations: automations.map((automation) => ({
      id: automation.id, name: automation.name, status: automation.status, revision: automation.revision, definitionChecksum: automation.definitionChecksum, timezone: automation.timezone,
      triggers: automation.triggers.map((trigger) => ({ id: trigger.id, kind: trigger.kind, configuration: trigger.configuration, revision: trigger.revision })),
      actions: automation.actions.map((action) => ({ id: action.id, osDeviceId: action.device.osDeviceId, osAreaId: action.area.osAreaId, controlId: action.controlId, descriptorRevision: action.descriptorRevision, actionValue: action.actionValue, needsAttention: action.needsAttention })),
    })),
    releasePolicy: { mode: 'MANUAL', automaticInstallEnabled: false, desiredRelease: null },
  };
  const encoded = canonicalSyncJson(unsigned);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CONFIGURATION_BYTES) throw new Error('Hub configuration exceeds the bounded sync response');
  return { ...unsigned, checksum: hashSyncConfiguration(unsigned) };
}

export function finalizeHubCloudConfiguration(candidate: Record<string, unknown>, revision: number) {
  const { checksum, ...rest } = candidate;
  if (typeof checksum !== 'string' || checksum !== hashSyncConfiguration(rest)) throw new Error('Hub configuration candidate checksum is invalid');
  const unsigned = { ...rest, revision };
  return { ...unsigned, checksum: hashSyncConfiguration(unsigned) };
}
