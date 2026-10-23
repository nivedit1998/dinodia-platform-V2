import type { Prisma } from '@prisma/client';
import { canonicalSyncJson, hashSyncConfiguration } from './hubSyncEnvelope';

const MAX_CONFIGURATION_BYTES = 1024 * 1024;

export async function buildHubCloudConfiguration(db: Prisma.TransactionClient, input: { homeId: string; hubInstallationId: string }) {
  // Stage 11 ships the executor and its complete configuration contract, but
  // customer execution stays opt-in until the Stage 13 activation decision.
  // Unset/anything other than the exact string "true" fails closed.
  const automationActivationEnabled = process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED === 'true';
  const [home, areas, memberships, devices, automationRows, hub] = await Promise.all([
    db.home.findUnique({ where: { id: input.homeId }, select: { id: true, managementRevision: true, timezone: true } }),
    db.area.findMany({ where: { homeId: input.homeId, status: 'ACTIVE' }, orderBy: { id: 'asc' }, select: { id: true, osAreaId: true, originalName: true, overrideName: true, revision: true } }),
    db.homeMembership.findMany({
      where: { homeId: input.homeId, status: 'ACTIVE' }, orderBy: { id: 'asc' }, take: 100,
      select: { id: true, role: true, accessRevision: true, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, orderBy: { areaId: 'asc' }, select: { areaId: true, policyRevision: true } } },
    }),
    db.nativeDevice.findMany({ where: { homeId: input.homeId, hubInstallationId: input.hubInstallationId }, orderBy: { id: 'asc' }, take: 2000,
      select: { id: true, osDeviceId: true, managementClass: true, ownerMembershipId: true, analyticsCategory: true, inventoryRevision: true, lifecycle: true, customerLabel: true, overrideName: true, descriptorRevision: true, descriptorDigest: true, assignments: { where: { validUntil: null, area: { status: 'ACTIVE' } }, orderBy: { areaId: 'asc' }, take: 8, select: { areaId: true, area: { select: { osAreaId: true } } } } } }),
    db.nativeAutomation.findMany({ where: { homeId: input.homeId }, orderBy: { id: 'asc' }, take: 100,
      select: { id: true, createdByMembershipId: true, name: true, status: true, revision: true, definitionChecksum: true, timezone: true, retiredAt: true, createdAt: true, updatedAt: true,
        triggers: { orderBy: { id: 'asc' }, take: 16, select: { id: true, kind: true, configuration: true, revision: true } },
        actions: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: 32, select: { id: true, deviceId: true, areaId: true,
          device: { select: { osDeviceId: true, managementClass: true, ownerMembershipId: true, lifecycle: true, descriptorRevision: true, originalName: true, overrideName: true, customerLabel: true } },
          area: { select: { id: true, osAreaId: true, originalName: true, overrideName: true } },
          controlId: true, sortOrder: true, descriptorRevision: true, actionValue: true, needsAttention: true,
        } },
        executions: { where: { purgeAt: { gt: new Date() } }, orderBy: { startedAt: 'desc' }, take: 1, select: { status: true, startedAt: true, completedAt: true, safeOutcome: true } },
      } }),
    db.hubInstallation.findUnique({ where: { id: input.hubInstallationId }, select: { accessPolicyRevision: true, capabilitySummary: true, analyticsWriterEnabled: true, analyticsCollectionEnabled: true, manufacturingIdentity: { select: { identityGeneration: true } } } }),
  ]);
  if (!home) throw new Error('Hub home is no longer available');
  const automations = automationActivationEnabled ? automationRows.filter((automation) => automation.status !== 'RETIRED') : [];
  const capabilitySummary = hub?.capabilitySummary && typeof hub.capabilitySummary === 'object' && !Array.isArray(hub.capabilitySummary)
    ? hub.capabilitySummary as Record<string, unknown> : {};
  const supportsTenantAutomationProjection = capabilitySummary.nativeTenantAutomationProjectionV1 === true;
  const analyticsIntervals = capabilitySummary.nativeUniversalAnalyticsV2 === true ? await db.nativeAnalyticsInterval.findMany({
    where: { homeId: input.homeId, hubInstallationId: input.hubInstallationId, validUntil: null,
      sourceGeneration: hub?.manufacturingIdentity?.identityGeneration ?? -1 }, take: 2000,
  }) : [];
  // Configuration construction is read-only. Activation/generation reconciliation
  // seeds intervals in the audited operator transaction, never on every sync.
  const tenantAutomationProjection = supportsTenantAutomationProjection ? {
    version: 1,
    executionEnabled: automationActivationEnabled,
    propertyTimeZone: home.timezone ?? null,
    automations: automationRows.map((automation) => {
      const latest = automation.executions[0];
      const safeOutcome = latest?.safeOutcome && typeof latest.safeOutcome === 'object' && !Array.isArray(latest.safeOutcome)
        ? latest.safeOutcome as Record<string, unknown> : null;
      const rawCounts = safeOutcome?.actionStatuses && typeof safeOutcome.actionStatuses === 'object' && !Array.isArray(safeOutcome.actionStatuses)
        ? safeOutcome.actionStatuses as Record<string, unknown> : null;
      const actionCount = safeOutcome?.actionCount;
      const actionStatuses = rawCounts && ['applied', 'failed', 'uncertain', 'skipped'].every((key) => Number.isSafeInteger(rawCounts[key]))
        ? { applied: Number(rawCounts.applied), failed: Number(rawCounts.failed), uncertain: Number(rawCounts.uncertain), skipped: Number(rawCounts.skipped) } : null;
      const validCounts = Number.isSafeInteger(actionCount) && Number(actionCount) >= 0 && Number(actionCount) <= 32
        && actionStatuses !== null && Object.values(actionStatuses).every((count) => count >= 0 && count <= Number(actionCount))
        && Object.values(actionStatuses).reduce((sum, count) => sum + count, 0) <= Number(actionCount);
      const trigger = automation.triggers.length === 1 && automation.triggers[0].kind === 'SCHEDULE'
        && automation.triggers[0].configuration && typeof automation.triggers[0].configuration === 'object' && !Array.isArray(automation.triggers[0].configuration)
        ? (() => {
          const configuration = automation.triggers[0].configuration as Record<string, unknown>;
          const minuteOfDay = Number(configuration.minuteOfDay);
          const weekdays = Array.isArray(configuration.weekdays) ? configuration.weekdays.filter((day): day is number => Number.isSafeInteger(day) && Number(day) >= 1 && Number(day) <= 7) : [];
          return Number.isSafeInteger(minuteOfDay) && minuteOfDay >= 0 && minuteOfDay <= 1439 && weekdays.length > 0 && weekdays.length <= 7
            ? { id: automation.triggers[0].id, kind: automation.triggers[0].kind, minuteOfDay, weekdays, revision: automation.triggers[0].revision } : null;
        })() : null;
      return {
        id: automation.id, creatorMembershipId: automation.createdByMembershipId, name: automation.name, status: automation.status,
        revision: automation.revision, definitionChecksum: automation.definitionChecksum, timeZone: automation.timezone,
        retiredAt: automation.retiredAt?.toISOString() ?? null, createdAt: automation.createdAt.toISOString(), updatedAt: automation.updatedAt.toISOString(), trigger,
        actions: automation.actions.map((action) => ({
          id: action.id, deviceId: action.deviceId, osDeviceId: action.device.osDeviceId,
          areaId: action.areaId, osAreaId: action.area.osAreaId, controlId: action.controlId, sortOrder: action.sortOrder,
          descriptorRevision: action.descriptorRevision, targetValue: action.actionValue, needsAttention: action.needsAttention,
          deviceManagementClass: action.device.managementClass, deviceOwnerMembershipId: action.device.ownerMembershipId,
          deviceLifecycle: action.device.lifecycle,
          deviceName: action.device.overrideName ?? action.device.customerLabel ?? action.device.originalName,
          areaName: action.area.overrideName ?? action.area.originalName,
        })),
        lastOutcome: latest ? {
          status: latest.status === 'INTERRUPTED' ? 'uncertain' : latest.status.toLowerCase(),
          startedAt: latest.startedAt.toISOString(), completedAt: latest.completedAt?.toISOString() ?? null,
          ...(validCounts ? { actionCount: Number(actionCount), actionStatuses } : {}),
        } : null,
      };
    }),
  } : undefined;
  const unsigned = {
    revision: home.managementRevision,
    policyRevision: hub?.accessPolicyRevision ?? 0,
    areas: areas.map((area) => ({ id: area.id, osAreaId: area.osAreaId, originalName: area.originalName, overrideName: area.overrideName, revision: area.revision })),
    memberships: memberships.map((member) => ({ id: member.id, role: member.role, accessRevision: member.accessRevision, areaIds: member.tenantAreaGrants.map((grant) => grant.areaId), grantRevisions: member.tenantAreaGrants.map((grant) => ({ areaId: grant.areaId, revision: grant.policyRevision })) })),
    devicePolicies: devices.map((device) => ({
      osDeviceId: device.osDeviceId, managementClass: device.managementClass, ownerMembershipId: device.ownerMembershipId,
      lifecycle: device.lifecycle, customerLabel: device.customerLabel, overrideName: device.overrideName,
      analyticsCategory: device.analyticsCategory,
      inventoryRevision: device.inventoryRevision,
      descriptorRevision: device.descriptorRevision, descriptorDigest: device.descriptorDigest,
      osAreaIds: device.assignments.map((assignment) => assignment.area.osAreaId),
      ...(() => { const interval = analyticsIntervals.find(row => row.deviceId === device.id); return interval ? { analyticsInterval: {
        id: interval.id, revision: interval.revision, validFrom: interval.validFrom.toISOString(), sourceGeneration: interval.sourceGeneration,
        selectedControlId: interval.selectedControlId, writerEnabled: hub?.analyticsWriterEnabled === true,
        genericCollectionEnabled: hub?.analyticsCollectionEnabled === true,
        authorizedControlIds: Array.isArray(interval.authorizedControls) ? interval.authorizedControls.map(control => String((control as Record<string, unknown>).controlId)) : [],
      } } : {}; })(),
    })),
    automations: automations.map((automation) => ({
      id: automation.id, name: automation.name, status: automation.status, revision: automation.revision, definitionChecksum: automation.definitionChecksum, timezone: automation.timezone,
      triggers: automation.triggers.map((trigger) => ({ id: trigger.id, kind: trigger.kind, configuration: trigger.configuration, revision: trigger.revision })),
      actions: automation.actions.map((action) => ({ id: action.id, osDeviceId: action.device.osDeviceId, osAreaId: action.area.osAreaId, controlId: action.controlId, descriptorRevision: action.descriptorRevision, actionValue: action.actionValue, needsAttention: action.needsAttention })),
    })),
    ...(tenantAutomationProjection ? { tenantAutomationProjection } : {}),
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
