// Architecture: Shared platform helper src/lib/deviceRegistry.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { DeviceStatus, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export class DeviceBlockedError extends Error {
  status: DeviceStatus;

  constructor(status: DeviceStatus, message?: string) {
    super(message ?? `Device is ${status.toLowerCase()}`);
    this.status = status;
  }
}

export async function getDeviceRecord(
  deviceId: string | null | undefined,
  client: PrismaClientOrTx = prisma
) {
  if (!deviceId) return null;
  return client.deviceRegistry.findUnique({ where: { deviceId } });
}

export async function ensureActiveDevice(
  deviceId: string | null | undefined,
  client: PrismaClientOrTx = prisma
) {
  if (!deviceId) {
    throw new DeviceBlockedError(DeviceStatus.BLOCKED, 'Missing device id');
  }
  const record = await getDeviceRecord(deviceId, client);
  if (!record) {
    throw new DeviceBlockedError(DeviceStatus.BLOCKED, 'Device is blocked');
  }
  if (record.status !== DeviceStatus.ACTIVE) {
    throw new DeviceBlockedError(record.status, `Device is ${record.status.toLowerCase()}`);
  }
  return record;
}

export async function getOrCreateDevice(deviceId: string) {
  return prisma.deviceRegistry.upsert({
    where: { deviceId },
    update: { lastSeenAt: new Date() },
    create: {
      deviceId,
      status: DeviceStatus.ACTIVE,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    },
  });
}

export async function registerOrValidateDevice(deviceId: string) {
  if (!deviceId) {
    throw new DeviceBlockedError(DeviceStatus.BLOCKED, 'Missing device id');
  }
  const existing = await getDeviceRecord(deviceId);
  if (!existing) {
    return prisma.deviceRegistry.create({
      data: {
        deviceId,
        status: DeviceStatus.ACTIVE,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
  }
  if (existing.status !== DeviceStatus.ACTIVE) {
    throw new DeviceBlockedError(existing.status, `Device is ${existing.status.toLowerCase()}`);
  }
  await prisma.deviceRegistry.update({
    where: { deviceId },
    data: { lastSeenAt: new Date() },
  });
  return existing;
}

export async function markDeviceStatus(
  deviceId: string,
  status: DeviceStatus,
  label?: string | null
) {
  await prisma.deviceRegistry.upsert({
    where: { deviceId },
    update: {
      status,
      label: label ?? undefined,
      lastSeenAt: new Date(),
    },
    create: {
      deviceId,
      status,
      label: label ?? undefined,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    },
  });
}
