// Architecture: Shared platform helper src/lib/devicesVersion.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';

export async function bumpDevicesVersion(haConnectionId: number): Promise<void> {
  await prisma.haConnection.update({
    where: { id: haConnectionId },
    data: { devicesVersion: { increment: 1 } },
  });
}
