// Architecture: API boundary /installer/hubs/[hubInstallId]/rooms/[roomId]/rekey; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, RoomStatus } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { requireTrustedPrivilegedDevice } from '@/lib/deviceAuth';
import { encryptRoomQrSecret, generateRoomQrSecret, hashRoomQrSecret } from '@/lib/roomQr';
import { canAccessProvision } from '@/lib/companyPortalAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ hubInstallId: string; roomId: string }> }
) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || !canAccessProvision(me.role)) {
    return apiFailFromStatus(401, 'Installer access required.');
  }
  const deviceError = await requireTrustedPrivilegedDevice(req, me.id).catch((err) => err);
  if (deviceError instanceof Error) {
    return apiFailFromStatus(403, deviceError.message);
  }

  const { hubInstallId, roomId } = await context.params;

  const room = await prisma.room.findFirst({
    where: { id: roomId, hubInstallId },
    select: { id: true, qrKeyVersion: true, displayName: true },
  });
  if (!room) return apiFailFromStatus(404, 'Room not found.');

  const secret = generateRoomQrSecret();
  const updated = await prisma.room.update({
    where: { id: room.id },
    data: {
      qrKeyVersion: room.qrKeyVersion + 1,
      qrSecretHash: hashRoomQrSecret(secret),
      qrSecretCiphertext: encryptRoomQrSecret(secret),
      status: RoomStatus.REKEYED,
    },
    select: { qrKeyVersion: true },
  });

  const hub = await prisma.hubInstall.findUnique({ where: { id: hubInstallId }, select: { homeId: true } });
  if (hub?.homeId) {
    await prisma.auditEvent.create({
      data: {
        type: AuditEventType.ROOM_QR_REKEYED,
        homeId: hub.homeId,
        actorUserId: me.id,
        metadata: { roomId: room.id, roomDisplayName: room.displayName, newKeyVersion: updated.qrKeyVersion },
      },
    });
  }

  return NextResponse.json({ ok: true, qrKeyVersion: updated.qrKeyVersion });
}
