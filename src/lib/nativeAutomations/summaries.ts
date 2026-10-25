import { prisma } from '@/lib/prisma';
import { NativeAutomationError } from './validation';

async function selectedHub(homeId: string) {
  const home = await prisma.home.findUnique({ where: { id: homeId }, select: { managementRevision: true, timezone: true, activeHubInstallationId: true } });
  const hub = home?.activeHubInstallationId ? await prisma.hubInstallation.findFirst({ where: { id: home.activeHubInstallationId, homeId, lifecycleStatus: 'ACTIVE' }, select: {
    id: true, cloudConfigurationRevision: true, acknowledgedCloudRevision: true, lastSuccessfulSyncAt: true,
  } }) : null;
  const cloudRevision = hub?.cloudConfigurationRevision ?? 0;
  const appliedRevision = hub?.acknowledgedCloudRevision ?? 0;
  const executionEnabled = process.env.DINODIA_NATIVE_AUTOMATIONS_ENABLED === 'true';
  return { home, hub, cloudRevision, appliedRevision, executionEnabled, applied: Boolean(hub && appliedRevision >= cloudRevision) };
}

function triggerSummary(trigger: { id: string; kind: string; configuration: unknown; revision: number } | undefined) {
  if (!trigger || trigger.kind !== 'SCHEDULE' || !trigger.configuration || typeof trigger.configuration !== 'object' || Array.isArray(trigger.configuration)) return null;
  const value = trigger.configuration as Record<string, unknown>;
  const minuteOfDay = Number(value.minuteOfDay);
  const weekdays = Array.isArray(value.weekdays) ? value.weekdays.filter((day): day is number => Number.isSafeInteger(day) && Number(day) >= 1 && Number(day) <= 7) : [];
  if (!Number.isSafeInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439 || weekdays.length < 1 || weekdays.length > 7) return null;
  return { id: trigger.id, kind: trigger.kind, minuteOfDay, weekdays, revision: trigger.revision };
}

function tenantOutcome(execution: { status: string; startedAt: Date; completedAt: Date | null; safeOutcome: unknown } | undefined) {
  if (!execution) return null;
  const raw = execution.safeOutcome && typeof execution.safeOutcome === 'object' && !Array.isArray(execution.safeOutcome)
    ? execution.safeOutcome as Record<string, unknown> : null;
  const rawCounts = raw?.actionStatuses && typeof raw.actionStatuses === 'object' && !Array.isArray(raw.actionStatuses)
    ? raw.actionStatuses as Record<string, unknown> : null;
  const actionCount = raw?.actionCount;
  const statuses = rawCounts && ['applied', 'failed', 'uncertain', 'skipped'].every((key) => Number.isSafeInteger(rawCounts[key]))
    ? { applied: Number(rawCounts.applied), failed: Number(rawCounts.failed), uncertain: Number(rawCounts.uncertain), skipped: Number(rawCounts.skipped) }
    : null;
  const countsValid = Number.isSafeInteger(actionCount) && Number(actionCount) >= 0 && Number(actionCount) <= 32
    && statuses !== null && Object.values(statuses).every((count) => count >= 0 && count <= Number(actionCount))
    && Object.values(statuses).reduce((sum, count) => sum + count, 0) <= Number(actionCount);
  return {
    status: execution.status === 'INTERRUPTED' ? 'uncertain' : execution.status.toLowerCase(),
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt?.toISOString() ?? null,
    ...(countsValid ? { actionCount: Number(actionCount), actionStatuses: statuses } : {}),
  };
}

export async function listTenantAutomationSummaries(input: { homeId: string; membershipId: string }) {
  const membership = await prisma.homeMembership.findFirst({ where: { id: input.membershipId, homeId: input.homeId, role: 'TENANT', status: 'ACTIVE' }, select: {
    id: true, accessRevision: true, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } },
  } });
  if (!membership) throw new NativeAutomationError(404, 'AUTOMATION_SCOPE_DENIED', 'This Home is not available to the selected account');
  const [delivery, rows] = await Promise.all([
    selectedHub(input.homeId),
    prisma.nativeAutomation.findMany({ where: { homeId: input.homeId, createdByMembershipId: membership.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100, select: {
      id: true, name: true, status: true, revision: true, definitionChecksum: true, timezone: true, retiredAt: true, createdAt: true, updatedAt: true,
      triggers: { orderBy: { id: 'asc' }, take: 1, select: { id: true, kind: true, configuration: true, revision: true } },
      actions: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: 32, select: { id: true, deviceId: true, areaId: true, controlId: true, sortOrder: true, descriptorRevision: true, actionValue: true, needsAttention: true, device: { select: { managementClass: true, ownerMembershipId: true, originalName: true, overrideName: true, customerLabel: true } }, area: { select: { originalName: true, overrideName: true } } } },
      executions: { where: { purgeAt: { gt: new Date() } }, orderBy: { startedAt: 'desc' }, take: 1, select: { status: true, startedAt: true, completedAt: true, safeOutcome: true } },
    } }),
  ]);
  const visibleRows = rows.filter((row) => row.status !== 'RETIRED' || !delivery.applied);
  return {
    ok: true,
    homeId: input.homeId,
    membershipId: membership.id,
    membershipRevision: membership.accessRevision,
    managementRevision: delivery.home?.managementRevision ?? 0,
    propertyTimeZone: delivery.home?.timezone ?? null,
    delivery: { state: !delivery.executionEnabled ? 'activation_disabled' : delivery.applied ? 'applied' : 'pending_delivery', cloudRevision: delivery.cloudRevision, appliedRevision: delivery.appliedRevision, lastSuccessfulSyncAt: delivery.hub?.lastSuccessfulSyncAt?.toISOString() ?? null },
    automations: visibleRows.map((row) => ({
      id: row.id, name: row.name, status: row.status === 'RETIRED' ? 'removal_pending'
        : row.status === 'NEEDS_ATTENTION' || row.actions.some((action) => action.needsAttention) ? 'needs_attention'
          : row.status === 'PAUSED' ? (delivery.applied ? 'disabled' : 'disabled_waiting_for_hub')
            : !delivery.executionEnabled ? 'waiting_for_activation' : delivery.applied ? 'active' : 'waiting_for_hub',
      revision: row.revision, definitionChecksum: row.definitionChecksum, timeZone: row.timezone,
      trigger: triggerSummary(row.triggers[0]),
      actions: row.status === 'RETIRED' ? [] : row.actions.flatMap((action) => membership.tenantAreaGrants.some((grant) => grant.areaId === action.areaId) ? [{
        id: action.id, deviceId: action.deviceId, areaId: action.areaId, controlId: action.controlId, sortOrder: action.sortOrder, descriptorRevision: action.descriptorRevision,
        targetValue: action.actionValue, needsAttention: action.needsAttention,
        deviceName: action.device.overrideName ?? action.device.customerLabel ?? action.device.originalName,
        areaName: action.area.overrideName ?? action.area.originalName,
      }] : []),
      lastOutcome: tenantOutcome(row.executions[0]),
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function listPropertyAutomationSummaries(input: { homeId: string; membershipId: string; accountId: string; role: string }) {
  if (!['OWNER', 'PROPERTY_MANAGER'].includes(input.role)) throw new NativeAutomationError(404, 'AUTOMATION_SCOPE_DENIED', 'Property automations are not available for this Home');
  const actor = await prisma.homeMembership.findFirst({ where: { id: input.membershipId, customerAccountId: input.accountId, homeId: input.homeId, role: input.role as 'OWNER' | 'PROPERTY_MANAGER', status: 'ACTIVE' }, select: { id: true, accessRevision: true } });
  if (!actor) throw new NativeAutomationError(404, 'AUTOMATION_SCOPE_DENIED', 'Property automations are not available for this Home');
  const [delivery, rows] = await Promise.all([
    selectedHub(input.homeId),
    prisma.nativeAutomation.findMany({ where: { homeId: input.homeId, OR: [{ propertyImpact: true }, { actions: { some: { device: { managementClass: 'PROPERTY_DEVICE' } } } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100, select: {
      id: true, name: true, status: true, revision: true, timezone: true, createdAt: true, updatedAt: true, propertyImpact: true,
      createdBy: { select: { role: true, customerAccount: { select: { displayName: true } } } },
      triggers: { orderBy: { id: 'asc' }, take: 1, select: { id: true, kind: true, configuration: true, revision: true } },
      actions: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: 32, select: {
        id: true, deviceId: true, areaId: true, controlId: true, sortOrder: true, descriptorRevision: true, needsAttention: true,
        device: { select: { managementClass: true, originalName: true, overrideName: true, customerLabel: true, capabilitySummary: true } },
        area: { select: { originalName: true, overrideName: true } },
      } },
      executions: { orderBy: { startedAt: 'desc' }, take: 1, select: { status: true, startedAt: true, completedAt: true } },
    } }),
  ]);
  const rowsWithPropertyImpact = rows.filter((row) => row.propertyImpact || row.actions.some((action) => action.device.managementClass === 'PROPERTY_DEVICE'))
    .filter((row) => row.status !== 'RETIRED' || !delivery.applied);
  return {
    ok: true, homeId: input.homeId, membershipId: actor.id, managementRevision: delivery.home?.managementRevision ?? 0,
    delivery: { state: !delivery.executionEnabled ? 'activation_disabled' : delivery.applied ? 'applied' : 'pending_delivery', cloudRevision: delivery.cloudRevision, appliedRevision: delivery.appliedRevision, lastSuccessfulSyncAt: delivery.hub?.lastSuccessfulSyncAt?.toISOString() ?? null },
    automations: rowsWithPropertyImpact.map((row) => ({
      id: row.id,
      tenantName: row.createdBy?.customerAccount.displayName ?? 'Tenant',
      // Tenant-authored names for mixed rules can reveal a private routine.
      // Keep property oversight useful without carrying that title across the
      // property/private boundary.
      name: row.status === 'RETIRED' ? 'Removal pending'
        : row.actions.some((action) => action.device.managementClass === 'TENANT_DEVICE') ? 'Tenant automation' : row.name,
      status: row.status === 'RETIRED' ? 'removal_pending'
        : row.status === 'NEEDS_ATTENTION' || row.actions.some((action) => action.needsAttention) ? 'needs_attention'
          : row.status === 'PAUSED' ? (delivery.applied ? 'disabled' : 'disabled_waiting_for_hub')
            : !delivery.executionEnabled ? 'waiting_for_activation' : delivery.applied ? 'active' : 'waiting_for_hub',
      revision: row.revision, timeZone: row.timezone, trigger: triggerSummary(row.triggers[0]),
      // Deliberately project permanent-device actions only. Mixed rules expose
      // no private label, control, value, count, fragment or private-only rule.
      actions: row.status === 'RETIRED' ? [] : row.actions.filter((action) => action.device.managementClass === 'PROPERTY_DEVICE').map((action, visibleIndex) => ({
        id: action.id, deviceId: action.deviceId, areaId: action.areaId, controlId: action.controlId, sortOrder: visibleIndex,
        deviceName: action.device.overrideName ?? action.device.customerLabel ?? action.device.originalName,
        areaName: action.area.overrideName ?? action.area.originalName,
        needsAttention: action.needsAttention,
      })),
      lastOutcome: row.executions[0] ? { status: row.executions[0].status.toLowerCase(), startedAt: row.executions[0].startedAt.toISOString(), completedAt: row.executions[0].completedAt?.toISOString() ?? null } : null,
      canDisable: ['ACTIVE', 'NEEDS_ATTENTION'].includes(row.status), canDelete: row.status !== 'RETIRED',
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    })),
  };
}
