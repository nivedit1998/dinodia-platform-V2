// Architecture: API boundary /installer/home-support/homes/[homeId]/rooms/[roomId]/rekey; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, RoomStatus } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportQrOperator } from '@/lib/companyPortalGuards';
import { encryptRoomQrSecret, generateRoomQrSecret, hashRoomQrSecret } from '@/lib/roomQr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ homeId: string; roomId: string }> }
) {
  const operator = await requireCompanyHomeSupportQrOperator(req);
  if (operator instanceof NextResponse) return operator;

  const { homeId: rawHomeId, roomId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

  const hub = await prisma.home.findUnique({
    where: { id: homeId },
    select: { hubInstall: { select: { id: true } } },
  });
  const hubInstallId = hub?.hubInstall?.id;
  if (!hubInstallId) return apiFailFromStatus(404, 'Home not found.');

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

  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.ROOM_QR_REKEYED,
      homeId,
      actorUserId: operator.userId,
      metadata: { roomId: room.id, roomDisplayName: room.displayName, newKeyVersion: updated.qrKeyVersion },
    },
  });

  return NextResponse.json({ ok: true, qrKeyVersion: updated.qrKeyVersion });
}
