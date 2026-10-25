import type { Prisma } from '@prisma/client';

/** Existing prepared writers must keep delivering during feature-OFF recovery.
 * The flag controls enrollment/maintenance/reads, not acknowledgement of durable
 * authorized evidence. Feature-OFF bridge remains safe before additive tables. */
export async function calendarSchemaPresent(tx: Prisma.TransactionClient) {
  if (process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED === 'true') return true;
  if (!tx.nativeAnalyticsRetention) return false;
  const rows = await tx.$queryRaw<Array<{ available: boolean }>>`
    SELECT to_regclass('public."NativeAnalyticsRetention"') IS NOT NULL AS available`;
  return rows[0]?.available === true;
}
