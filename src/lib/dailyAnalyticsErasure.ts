import type { Prisma } from '@prisma/client';

/** Works both before the additive migration and during compatible recovery. */
export async function purgeDailyAnalytics(tx: Prisma.TransactionClient, input: {
  homeId: string; areaId?: string; deviceIds?: string[]; wholeHome?: boolean;
}) {
  if (!input.wholeHome && !input.areaId && !input.deviceIds?.length) throw new Error('Daily erasure requires an exact target');
  const [stateSchema] = await tx.$queryRaw<Array<{ available: boolean }>>`
    SELECT to_regclass('public."NativeAnalyticsStateDay"') IS NOT NULL AS available`;
  if (stateSchema?.available) await tx.$executeRaw`
    DELETE FROM "NativeAnalyticsStateDay" WHERE "homeId"=${input.homeId}::uuid
      AND (${input.wholeHome === true} OR "areaId"=${input.areaId || null}::uuid
        OR "deviceId" IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(input.deviceIds || [])}::jsonb)))`;
  const [schema] = await tx.$queryRaw<Array<{ available: boolean }>>`
    SELECT to_regclass('public."NativeAnalyticsDay"') IS NOT NULL AS available`;
  if (!schema?.available) return;
  await tx.nativeAnalyticsDay.deleteMany({ where: { homeId: input.homeId,
    ...(!input.wholeHome ? { OR: [
      ...(input.areaId ? [{ areaId: input.areaId }] : []),
      ...(input.deviceIds?.length ? [{ deviceId: { in: input.deviceIds } }] : []),
    ] } : {}),
  } });
  if (input.wholeHome) await tx.nativeAnalyticsRetention.deleteMany({ where: { homeId: input.homeId } });
}
