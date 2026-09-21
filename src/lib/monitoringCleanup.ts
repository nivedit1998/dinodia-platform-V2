// Architecture: Shared platform helper src/lib/monitoringCleanup.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';

export async function cleanupMonitoringReadings() {
  await prisma.monitoringReading.deleteMany({
    where: {
      OR: [
        { unit: null },
        { unit: { notIn: ['kWh', '%'] } },
        { unit: '%', entityId: { not: { contains: 'battery' } } },
        { unit: 'kWh', OR: [{ numericValue: null }, { numericValue: { lte: 0 } }] },
      ],
    },
  });

  await prisma.monitoringReading.updateMany({
    where: {
      unit: '%',
      entityId: { contains: 'battery' },
      numericValue: null,
    },
    data: { numericValue: 0 },
  });
}
