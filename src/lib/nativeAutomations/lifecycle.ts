import { automationSources } from './triggerReferences';
import type { Prisma } from '@prisma/client';
import { automationDefinitionChecksum } from './validation';

/**
 * Withdraw complete automation definitions without retaining executable action
 * bodies. The parent is a bounded tombstone so a replacement full-home bundle
 * can be acknowledged and the UI can truthfully show removal pending.
 */
export async function retireNativeAutomations(db: Prisma.TransactionClient, input: {
  homeId: string; automationIds?: readonly string[]; createdByMembershipId?: string;
  losingAreaIds?: readonly string[]; now?: Date; actorId: string | null; reason: string;
}) {
  const now = input.now ?? new Date();
  const rows = await db.nativeAutomation.findMany({ where: {
    homeId: input.homeId, status: { not: 'RETIRED' },
    ...(input.automationIds ? { id: { in: [...input.automationIds] } } : {}),
    ...(input.createdByMembershipId ? { createdByMembershipId: input.createdByMembershipId } : {}),

  }, take: 100, select: { id: true, revision: true, propertyImpact: true, actions:{select:{areaId:true}},triggers:{select:{configuration:true}} } });
  const affected = input.losingAreaIds?.length ? rows.filter(row=>(row.actions ?? []).some(action=>input.losingAreaIds!.includes(action.areaId)) || (row.triggers ?? []).some(trigger=>automationSources(trigger.configuration).some(source=>input.losingAreaIds!.includes(source.areaId)))) : rows;
  for (const row of affected) {
    const revision = row.revision + 1;
    const updated = await db.nativeAutomation.updateMany({ where: { id: row.id, homeId: input.homeId, revision: row.revision, status: { not: 'RETIRED' } }, data: {
      status: 'RETIRED', name: 'Removed automation', revision,
      definitionChecksum: automationDefinitionChecksum({ id: row.id, revision, status: 'RETIRED' }),
      retiredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    } });
    if (updated.count !== 1) throw new Error('Automation changed during authority withdrawal');
    await db.nativeAutomationTrigger.deleteMany({ where: { automationId: row.id } });
    await db.nativeAutomationAction.deleteMany({ where: { automationId: row.id, homeId: input.homeId } });
    await db.auditEvent.create({ data: { homeId: input.homeId, actorType: input.actorId ? 'CUSTOMER' : 'SYSTEM', actorId: input.actorId,
      category: 'ACCESS', action: 'native_automation_authority_withdrawn', targetType: 'NativeAutomation', targetId: row.id,
      metadata: { outcome: 'retired', revision, reason: input.reason, propertyImpact: row.propertyImpact }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  }
  return { retiredCount: affected.length, propertyImpactCount: affected.filter((row) => row.propertyImpact).length };
}
