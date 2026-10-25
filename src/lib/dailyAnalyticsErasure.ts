import type { Prisma } from '@prisma/client';

/** Works both before the additive migration and during compatible recovery. */
export async function purgeDailyAnalytics(tx: Prisma.TransactionClient, input: {
  homeId: string; areaId?: string; deviceIds?: string[]; wholeHome?: boolean;
}) {
  const [schema] = await tx.$queryRaw<Array<{ available: boolean }>>`
    SELECT to_regclass('public."NativeAnalyticsDay"') IS NOT NULL AS available`;
  if (!schema?.available) return;
  if (!input.wholeHome && !input.areaId && !input.deviceIds?.length) throw new Error('Daily erasure requires an exact target');
  await tx.nativeAnalyticsDay.deleteMany({ where: { homeId: input.homeId,
    ...(!input.wholeHome ? { OR: [
      ...(input.areaId ? [{ areaId: input.areaId }] : []),
      ...(input.deviceIds?.length ? [{ deviceId: { in: input.deviceIds } }] : []),
    ] } : {}),
  } });
  if (input.wholeHome) await tx.nativeAnalyticsRetention.deleteMany({ where: { homeId: input.homeId } });
}
