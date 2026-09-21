// Architecture: Shared QR-room domain service. Provision and Home Support routes call this
// module so Dinodia OS area confirmation, legacy Home Assistant behavior, duplicate handling,
// QR creation, persistence, and audit ordering cannot drift between entry points.
import { AuditEventType, Prisma, RoomStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { prepareQrRoomCreation } from '@/lib/dinodiaOsAreaProvisioning';
import {
  encryptRoomQrSecret,
  generateRoomQrSecret,
  hashRoomQrSecret,
} from '@/lib/roomQr';

export type CreateQrRoomInput = {
  actorUserId?: number;
  homeId?: number | null;
  hubInstallId: string;
  displayName: string;
  haAreaName: string;
};

export async function createQrRoom(input: CreateQrRoomInput) {
  const prepared = await prepareQrRoomCreation(input.hubInstallId, input.displayName, input.haAreaName);
  const existing = await prisma.room.findFirst({
    where: { hubInstallId: input.hubInstallId, haAreaName: prepared.areaName },
    select: { id: true },
  });
  if (existing) {
    return { roomId: existing.id, existing: true, dinodiaOs: prepared.dinodiaOs, area: prepared.area };
  }

  const secret = generateRoomQrSecret();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: {
          hubInstallId: input.hubInstallId,
          displayName: prepared.displayName,
          haAreaName: prepared.areaName,
          haAreaNameOriginal: input.haAreaName.trim(),
          qrKeyVersion: 1,
          qrSecretHash: hashRoomQrSecret(secret),
          qrSecretCiphertext: encryptRoomQrSecret(secret),
          status: RoomStatus.ACTIVE,
        },
        select: { id: true },
      });
      if (input.actorUserId && input.homeId) {
        await tx.auditEvent.create({
          data: {
            type: AuditEventType.ROOM_QR_REKEYED,
            homeId: input.homeId,
            actorUserId: input.actorUserId,
            metadata: {
              action: 'ROOM_CREATED',
              roomId: room.id,
              displayName: prepared.displayName,
              haAreaName: prepared.areaName,
              dinodiaOs: prepared.dinodiaOs,
            },
          },
        });
      }
      return room;
    });
    return { roomId: result.id, existing: false, dinodiaOs: prepared.dinodiaOs, area: prepared.area };
  } catch (error) {
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    if (prismaError?.code === 'P2002') {
      const raced = await prisma.room.findFirst({
        where: { hubInstallId: input.hubInstallId, haAreaName: prepared.areaName },
        select: { id: true },
      });
      if (raced) return { roomId: raced.id, existing: true, dinodiaOs: prepared.dinodiaOs, area: prepared.area };
    }
    throw error;
  }
}
