// Architecture: Shared platform helper src/lib/deviceTrust.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { DeviceStatus, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import { getDeviceRecord } from './deviceRegistry';

export async function isDeviceTrusted(userId: number, deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  const device = await prisma.trustedDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
    select: { revokedAt: true },
  });
  return !!device && device.revokedAt === null;
}

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export type TrustedDeviceSessionState = {
  sessionVersion: number;
};

export async function trustDevice(
  userId: number,
  deviceId: string,
  label?: string | null,
  client: PrismaClientOrTx = prisma
): Promise<TrustedDeviceSessionState | null> {
  if (!deviceId) return null;

  // Ensure the device is registered (ACTIVE) so admin cookie auth passes device checks.
  const registry = await getDeviceRecord(deviceId, client);
  if (!registry) {
    await client.deviceRegistry.create({
      data: {
        deviceId,
        status: DeviceStatus.ACTIVE,
        label: label ?? undefined,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
  } else {
    // Do not override blocked/stolen; just touch lastSeenAt and label if provided.
    await client.deviceRegistry.update({
      where: { deviceId },
      data: {
        lastSeenAt: new Date(),
        label: label ?? undefined,
      },
    });
  }

  const trusted = await client.trustedDevice.upsert({
    where: { userId_deviceId: { userId, deviceId } },
    update: {
      lastSeenAt: new Date(),
      label: label ?? undefined,
      revokedAt: null,
      sessionVersion: { increment: 1 },
    },
    create: {
      userId,
      deviceId,
      label: label ?? undefined,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      sessionVersion: 0,
    },
  });

  return { sessionVersion: Number(trusted.sessionVersion ?? 0) };
}

export async function touchTrustedDevice(userId: number, deviceId: string) {
  if (!deviceId) return;
  await prisma.trustedDevice.updateMany({
    where: { userId, deviceId },
    data: { lastSeenAt: new Date() },
  });
}

export async function bumpTrustedDeviceSession(
  userId: number,
  deviceId: string,
  client: PrismaClientOrTx = prisma
) {
  if (!deviceId) return;
  await client.trustedDevice.updateMany({
    where: { userId, deviceId },
    data: { sessionVersion: { increment: 1 } },
  });
}
