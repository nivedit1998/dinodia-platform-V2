// Architecture: API boundary /installer/home-support/homes/[homeId]/rooms; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportQrOperator } from '@/lib/companyPortalGuards';
import {
  DinodiaOsAreaError,
} from '@/lib/dinodiaOsAreaProvisioning';
import { createQrRoom } from '@/lib/qrRoomService';
import { buildRoomQrPayload, decryptRoomQrSecret } from '@/lib/roomQr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

async function resolveInstaller(req: NextRequest): Promise<{ userId: number } | NextResponse> {
  const operator = await requireCompanyHomeSupportQrOperator(req);
  if (operator instanceof NextResponse) return operator;
  return { userId: operator.userId };
}

async function resolveHomeHubInstallId(homeId: number): Promise<string | null> {
  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: { hubInstall: { select: { id: true } } },
  });
  return home?.hubInstall?.id ?? null;
}

export async function GET(req: NextRequest, context: { params: Promise<{ homeId: string }> }) {
  const resolved = await resolveInstaller(req);
  if (resolved instanceof NextResponse) return resolved;

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

  const hubInstallId = await resolveHomeHubInstallId(homeId);
  if (!hubInstallId) return apiFailFromStatus(404, 'Home not found.');

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

  return NextResponse.json({ ok: true, rooms: shaped });
}

export async function POST(req: NextRequest, context: { params: Promise<{ homeId: string }> }) {
  const resolved = await resolveInstaller(req);
  if (resolved instanceof NextResponse) return resolved;

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

  const hubInstallId = await resolveHomeHubInstallId(homeId);
  if (!hubInstallId) return apiFailFromStatus(404, 'Home not found.');

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }
  const obj = body as Record<string, unknown>;
  const displayName = typeof obj.displayName === 'string' ? obj.displayName.trim() : '';
  const haAreaName = typeof obj.haAreaName === 'string' ? obj.haAreaName.trim() : '';
  try {
    const created = await createQrRoom({
      actorUserId: resolved.userId,
      homeId,
      hubInstallId,
      displayName,
      haAreaName,
    });
    return NextResponse.json({ ok: true, roomId: created.roomId, existing: created.existing, area: created.area });
  } catch (error) {
    if (error instanceof DinodiaOsAreaError) return apiFailFromStatus(error.status, error.message);
    const prismaError = error as { code?: string };
    if (prismaError?.code === 'P2002') return apiFailFromStatus(409, 'A room already exists for that Home Assistant area name.');
    return apiFailFromStatus(500, 'Unable to create room right now.');
  }
}
