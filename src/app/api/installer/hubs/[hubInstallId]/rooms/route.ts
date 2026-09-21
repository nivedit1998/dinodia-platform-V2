// Architecture: API boundary /installer/hubs/[hubInstallId]/rooms; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { requireTrustedPrivilegedDevice } from '@/lib/deviceAuth';
import { canAccessProvision } from '@/lib/companyPortalAccess';
import {
  DinodiaOsAreaError,
  getDinodiaOsHubContext,
  hubRuntimeSummary,
} from '@/lib/dinodiaOsAreaProvisioning';
import { createQrRoom } from '@/lib/qrRoomService';
import { buildRoomQrPayload, decryptRoomQrSecret } from '@/lib/roomQr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ hubInstallId: string }> }) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || !canAccessProvision(me.role)) {
    return apiFailFromStatus(401, 'Installer access required.');
  }
  const deviceError = await requireTrustedPrivilegedDevice(req, me.id).catch((err) => err);
  if (deviceError instanceof Error) {
    return apiFailFromStatus(403, deviceError.message);
  }

  const { hubInstallId } = await context.params;

  const hub = await getDinodiaOsHubContext(hubInstallId);
  if (!hub) return apiFailFromStatus(404, 'Hub not found.');

  const rooms = await prisma.room.findMany({
    where: { hubInstallId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      displayName: true,
      haAreaName: true,
      haAreaNameOriginal: true,
      qrKeyVersion: true,
      qrSecretCiphertext: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const shaped = rooms.map((room) => {
    const secret = decryptRoomQrSecret(room.qrSecretCiphertext);
    return {
      id: room.id,
      displayName: room.displayName,
      haAreaName: room.haAreaName,
      haAreaNameOriginal: room.haAreaNameOriginal,
      qrKeyVersion: room.qrKeyVersion,
      status: room.status,
      qrPayload: buildRoomQrPayload({ roomId: room.id, token: secret }),
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  });

  return NextResponse.json({ ok: true, rooms: shaped, hubRuntime: hubRuntimeSummary(hub) });
}

export async function POST(req: NextRequest, context: { params: Promise<{ hubInstallId: string }> }) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || !canAccessProvision(me.role)) {
    return apiFailFromStatus(401, 'Installer access required.');
  }
  const deviceError = await requireTrustedPrivilegedDevice(req, me.id).catch((err) => err);
  if (deviceError instanceof Error) {
    return apiFailFromStatus(403, deviceError.message);
  }

  const { hubInstallId } = await context.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }
  const obj = body as Record<string, unknown>;
  const displayName = typeof obj.displayName === 'string' ? obj.displayName.trim() : '';
  const haAreaName = typeof obj.haAreaName === 'string' ? obj.haAreaName.trim() : '';
  try {
    const created = await createQrRoom({ hubInstallId, displayName, haAreaName });
    return NextResponse.json({ ok: true, roomId: created.roomId, existing: created.existing, area: created.area });
  } catch (error) {
    if (error instanceof DinodiaOsAreaError) return apiFailFromStatus(error.status, error.message);
    const prismaError = error as { code?: string };
    if (prismaError?.code === 'P2002') return apiFailFromStatus(409, 'A room already exists for that Home Assistant area name.');
    return apiFailFromStatus(500, 'Unable to create room right now.');
  }
}
