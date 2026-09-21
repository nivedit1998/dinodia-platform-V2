// Architecture: Shared platform helper src/lib/tenantDeviceCleanup.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { TenantDeviceCleanupReason, TenantDeviceCleanupStatus } from '@prisma/client';
import type { HaConnectionLike } from '@/lib/homeAssistant';
import { cleanupTenantOwnedHaTargets } from '@/lib/haCleanup';
import { prisma } from '@/lib/prisma';

function toHaConnectionLike(haConnection: {
  baseUrl: string;
  cloudUrl: string | null;
  longLivedToken: string | null;
}): HaConnectionLike {
  if (!haConnection.longLivedToken) {
    throw new Error('Home Assistant token is missing for tenant device cleanup.');
  }
  return {
    baseUrl: haConnection.cloudUrl?.trim() || haConnection.baseUrl,
    longLivedToken: haConnection.longLivedToken,
  };
}

export async function markTenantDevicesPendingCleanup(args: {
  tenantUserId: number;
  haConnectionId: number;
  parentHaAreaNames?: string[];
  reason: TenantDeviceCleanupReason;
  lastError?: string;
}): Promise<void> {
  await prisma.tenantDeviceDisplayOverride.updateMany({
    where: {
      tenantUserId: args.tenantUserId,
      haConnectionId: args.haConnectionId,
      cleanupStatus: TenantDeviceCleanupStatus.ACTIVE,
      ...(args.parentHaAreaNames?.length ? { parentHaAreaName: { in: args.parentHaAreaNames } } : {}),
    },
    data: {
      cleanupStatus: TenantDeviceCleanupStatus.PENDING_DEVICE_CLEANUP,
      cleanupReason: args.reason,
      cleanupLastError: args.lastError ?? null,
    },
  });
}

export async function cleanupPendingTenantDevices(args: {
  haConnectionId?: number;
  tenantUserId?: number;
  limit?: number;
} = {}): Promise<{ attempted: number; cleaned: number; failed: number }> {
  const rows = await prisma.tenantDeviceDisplayOverride.findMany({
    where: {
      cleanupStatus: TenantDeviceCleanupStatus.PENDING_DEVICE_CLEANUP,
      ...(args.haConnectionId ? { haConnectionId: args.haConnectionId } : {}),
      ...(args.tenantUserId ? { tenantUserId: args.tenantUserId } : {}),
    },
    include: {
      haConnection: {
        select: { baseUrl: true, cloudUrl: true, longLivedToken: true },
      },
    },
    take: args.limit ?? 50,
    orderBy: { updatedAt: 'asc' },
  });

  let cleaned = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await cleanupTenantOwnedHaTargets(toHaConnectionLike(row.haConnection), {
        deviceIds: row.haDeviceId ? [row.haDeviceId] : [],
        entityIds: row.entityId ? [row.entityId] : [],
      });
      if (result.failed === 0) {
        await prisma.tenantDeviceDisplayOverride.update({
          where: { id: row.id },
          data: {
            cleanupStatus: TenantDeviceCleanupStatus.CLEANED_UP,
            cleanupLastAttemptAt: new Date(),
            cleanupLastError: null,
            cleanupAttemptCount: { increment: 1 },
          },
        });
        cleaned += 1;
      } else {
        await prisma.tenantDeviceDisplayOverride.update({
          where: { id: row.id },
          data: {
            cleanupLastAttemptAt: new Date(),
            cleanupLastError: result.errors.join('; '),
            cleanupAttemptCount: { increment: 1 },
          },
        });
        failed += 1;
      }
    } catch (err) {
      await prisma.tenantDeviceDisplayOverride.update({
        where: { id: row.id },
        data: {
          cleanupLastAttemptAt: new Date(),
          cleanupLastError: err instanceof Error ? err.message : String(err),
          cleanupAttemptCount: { increment: 1 },
        },
      });
      failed += 1;
    }
  }
  return { attempted: rows.length, cleaned, failed };
}

export async function cleanupTenantDevicesForRemovedAreas(args: {
  tenantUserId: number;
  haConnectionId: number;
  removedAreaNames: string[];
}): Promise<{ ok: boolean; pending: number; cleaned: number }> {
  if (args.removedAreaNames.length === 0) return { ok: true, pending: 0, cleaned: 0 };
  await markTenantDevicesPendingCleanup({
    tenantUserId: args.tenantUserId,
    haConnectionId: args.haConnectionId,
    parentHaAreaNames: args.removedAreaNames,
    reason: TenantDeviceCleanupReason.AREA_ACCESS_REMOVED,
  });
  const result = await cleanupPendingTenantDevices({
    tenantUserId: args.tenantUserId,
    haConnectionId: args.haConnectionId,
  });
  return { ok: result.failed === 0, pending: result.failed, cleaned: result.cleaned };
}
