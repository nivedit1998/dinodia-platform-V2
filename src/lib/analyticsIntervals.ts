import type { Prisma } from '@prisma/client';
import { CATEGORY_ROLES, isAnalyticsCategory, isStateAnalyticsCategory, type AnalyticsCategory } from './analyticsCategories';

type Interval = { id: string; revision: number; analyticsCategory: string; selectedControlId: string | null;
  sourceGeneration: number; validFrom: Date; validUntil: Date | null; analyticsPolicyVersion?: number };
type Input = { intervals: Interval[]; start: Date; end: Date; category: string; controlId: string; generation: number;
  intervalId?: string; bindingRevision?: number; newWriterFrom?: Date | null; analyticsPolicyVersion?: number };

export function allowedAnalyticsControls(category: string, controls: Array<Record<string, unknown>>, selection: string | null): string[] {
  const roles = isAnalyticsCategory(category) ? CATEGORY_ROLES[category] : [];
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const control of controls) {
    if (control.observable !== true || !roles.includes(String(control.semanticRole)) || !['LIGHT','SOCKET','TV','BLIND'].includes(category) && control.writable === true) continue;
    const key = String(control.surfaceId || control.controlId);
    groups.set(key, [...(groups.get(key) || []), control]);
  }
  const candidates = [...groups.values()].flatMap(group => {
    const power = group.filter(control => control.semanticRole === 'power');
    const chosen = ['LIGHT','SOCKET','TV'].includes(category) && power.length ? power : group;
    if (chosen.length !== 1 || chosen[0].semanticRole === 'brightness' && chosen[0].brightnessMeaning !== 'actual_output') return [];
    return [String(chosen[0].controlId)];
  });
  return selection ? candidates.filter(id => id === selection) : candidates.length === 1 ? candidates : [];
}

// A legacy aggregate has no ordering within its coverage span. It must never
// be proportionally divided at an immediate policy change (owner decision D11).
export function classifyUsageAuthority(input: Input): { status: 'accepted' | 'unallocated' | 'denied'; reason: string | null } {
  const matches = input.intervals.filter(row => row.analyticsCategory === input.category
    && row.sourceGeneration === input.generation && (!row.selectedControlId || row.selectedControlId === input.controlId)
    && row.validFrom <= input.start && (!row.validUntil || row.validUntil >= input.end));
  if (input.intervalId) {
    const declared = input.intervals.find(row => row.id === input.intervalId && row.revision === input.bindingRevision
      && row.sourceGeneration === input.generation && row.analyticsCategory === input.category
      && (!row.selectedControlId || row.selectedControlId === input.controlId));
    if (!declared) return { status: 'denied', reason: 'analytics_interval_authority_invalid' };
    if ((declared.analyticsPolicyVersion ?? 2) !== (input.analyticsPolicyVersion ?? 2))
      return { status: 'denied', reason: 'analytics_policy_version_mismatch' };
    return matches.some(row => row.id === declared.id) ? { status: 'accepted', reason: null }
      : { status: 'unallocated', reason: 'interval_boundary_unallocated' };
  }
  if (input.newWriterFrom && input.end > input.newWriterFrom) return { status: 'unallocated', reason: 'legacy_after_writer_cutover' };
  if (input.intervals.length === 0) return { status: 'accepted', reason: null }; // unchanged strict legacy admission applies in caller
  return matches.length === 1 ? { status: 'accepted', reason: null } : { status: 'unallocated', reason: 'legacy_boundary_unallocated' };
}

// Call only inside the existing assigned-staff/commissioning transaction.
// Device lock makes source/category revisions monotonic under simultaneous edits.
export async function changeAnalyticsInterval(tx: Prisma.TransactionClient, input: {
  homeId: string; hubInstallationId: string; deviceId: string; category: AnalyticsCategory;
  selectedControlId: string | null; generation: number; at: Date; forceNew?: boolean; analyticsPolicyVersion?: 2 | 3 | 4;
}) {
  await tx.$queryRaw`SELECT id FROM "NativeDevice" WHERE id = ${input.deviceId}::uuid FOR UPDATE`;
  const device = await tx.nativeDevice.findFirst({ where: { id: input.deviceId, homeId: input.homeId, hubInstallationId: input.hubInstallationId,
    managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] } }, select: { capabilitySummary: true } });
  if (!device) throw new Error('Analytics interval requires current permanent-device authority');
  const summary = device.capabilitySummary as Record<string, unknown> | null;
  const catalog = summary?.controlCatalog as Record<string, unknown> | undefined;
  const controls = Array.isArray(catalog?.controls) ? catalog.controls as Array<Record<string, unknown>> : [];
  const role = CATEGORY_ROLES[input.category];
  const authorizedControls = controls.filter(control => role.includes(String(control.semanticRole)) && control.observable === true).slice(0, 64);
  if (input.selectedControlId && !allowedAnalyticsControls(input.category, authorizedControls, input.selectedControlId).length) throw Object.assign(new Error('Selected analytics signal is not authorized by the current catalog'), { code: 'analytics_source_invalid' });
  const prior = await tx.nativeAnalyticsInterval.findFirst({ where: { deviceId: input.deviceId }, orderBy: { revision: 'desc' } });
  let analyticsPolicyVersion = isStateAnalyticsCategory(input.category) ? 4 : input.analyticsPolicyVersion ?? prior?.analyticsPolicyVersion;
  if (!isStateAnalyticsCategory(input.category) && analyticsPolicyVersion === 4) analyticsPolicyVersion = undefined;
  if (analyticsPolicyVersion === undefined) {
    const installation = await tx.hubInstallation.findUnique({ where: { id: input.hubInstallationId },
      select: { analyticsWriterEnabled: true, capabilitySummary: true } });
    const capabilities = installation?.capabilitySummary as Record<string, unknown> | null;
    // New devices on an enabled compatible installation must not silently
    // return to fixed-window accounting. Existing epochs retain their policy.
    analyticsPolicyVersion = installation?.analyticsWriterEnabled && capabilities?.nativeStateEvidenceV2 === true ? 3 : 2;
  }
  if (!input.forceNew && prior && prior.validUntil === null && prior.analyticsCategory === input.category && prior.selectedControlId === input.selectedControlId
    && prior.sourceGeneration === input.generation && prior.analyticsPolicyVersion === analyticsPolicyVersion) {
    if (Array.isArray(prior.authorizedControls) && !prior.authorizedControls.length && authorizedControls.length && !prior.newWriterFrom) {
      return tx.nativeAnalyticsInterval.update({ where: { id: prior.id }, data: { authorizedControls: authorizedControls as Prisma.InputJsonValue } });
    }
    return prior;
  }
  if (prior && input.at <= prior.validFrom) throw new Error('Analytics policy time must advance');
  await tx.nativeAnalyticsInterval.updateMany({ where: { deviceId: input.deviceId, validUntil: null }, data: { validUntil: input.at } });
  return tx.nativeAnalyticsInterval.create({ data: { homeId: input.homeId, hubInstallationId: input.hubInstallationId, deviceId: input.deviceId,
    analyticsCategory: input.category as never, selectedControlId: input.selectedControlId, sourceGeneration: input.generation, analyticsPolicyVersion,
    revision: (prior?.revision ?? 0) + 1, validFrom: input.at, authorizedControls: authorizedControls as Prisma.InputJsonValue } });
}
