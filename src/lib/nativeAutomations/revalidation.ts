import { automationSources } from './triggerReferences';
import type { Prisma } from '@prisma/client';
import { automationDefinitionChecksum } from './validation';

/**
 * Fail closed when a canonical device identity/descriptor can no longer be
 * assumed to match an executable automation. The tenant keeps the rule and
 * its exact target for an explicit repair; it is never silently retargeted.
 */
export async function suspendAutomationsForDeviceChange(tx: Prisma.TransactionClient, input: {
  homeId: string; deviceId: string; now: Date; reason: 'descriptor_changed' | 'area_changed' | 'device_removed' | 'control_removed'; controlIds?: readonly string[];
}) {
  const rows = await tx.nativeAutomation.findMany({ where: {
    homeId: input.homeId, status: 'ACTIVE',

  }, take:100, select: { id: true, name: true, revision: true, timezone: true,
    triggers: { orderBy: { id: 'asc' }, take: 1, select: { configuration: true } },
    actions: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: {
      id: true, deviceId: true, areaId: true, controlId: true, sortOrder: true, descriptorRevision: true, actionValue: true,
    } },
  } });
  const affected = rows.filter(row=>(row.actions ?? []).some(action=>action.deviceId===input.deviceId && (!input.controlIds?.length || input.controlIds.includes(action.controlId))) || (row.triggers ?? []).some(trigger=>automationSources(trigger.configuration).some(source=>source.deviceId===input.deviceId && (!input.controlIds?.length || input.controlIds.includes(source.controlId)))));
  for (const row of affected) {
    const revision = row.revision + 1;
    const checksum = automationDefinitionChecksum({ id: row.id, revision, name: row.name, status: 'NEEDS_ATTENTION',
      timezone: row.timezone, trigger: row.triggers[0]?.configuration ?? null,
      actions: row.actions.map(({ id, deviceId, areaId, controlId, sortOrder, descriptorRevision, actionValue }) =>
        ({ id, deviceId, areaId, controlId, sortOrder, descriptorRevision, actionValue })) });
    const changed = await tx.nativeAutomation.updateMany({ where: { id: row.id, homeId: input.homeId, status: 'ACTIVE', revision: row.revision },
      data: { status: 'NEEDS_ATTENTION', revision, enabledAt: null, definitionChecksum: checksum } });
    if (changed.count !== 1) throw new Error('Automation changed during descriptor/identity revalidation');
    await tx.nativeAutomationAction.updateMany({ where: { automationId: row.id, homeId: input.homeId }, data: { needsAttention: true } });
    await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'SYSTEM', actorId: null, category: 'ACCESS',
      action: 'native_automation_needs_attention', targetType: 'NativeAutomation', targetId: row.id,
      metadata: { outcome: 'suspended', revision, reason: input.reason }, purgeAt: new Date(input.now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  }
  if (affected.length) await tx.home.updateMany({ where: { id: input.homeId }, data: { managementRevision: { increment: 1 } } });
  return affected.length;
}
