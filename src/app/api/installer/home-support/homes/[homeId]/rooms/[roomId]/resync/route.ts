// Architecture: API boundary /installer/home-support/homes/[homeId]/rooms/[roomId]/resync; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportQrOperator } from '@/lib/companyPortalGuards';
import {
  DinodiaOsAreaError,
  getDinodiaOsHubContext,
  isDinodiaOsManagedAreaHub,
  resyncDinodiaOsArea,
} from '@/lib/dinodiaOsAreaProvisioning';

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

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }
  const obj = body as Record<string, unknown>;
  const newHaAreaName = typeof obj.haAreaName === 'string' ? obj.haAreaName.trim() : '';
  if (!newHaAreaName) {
    return apiFailFromStatus(400, 'Home Assistant area name is required.');
  }

  const hub = await prisma.home.findUnique({
    where: { id: homeId },
    select: { hubInstall: { select: { id: true } } },
  });
  const hubInstallId = hub?.hubInstall?.id;
  if (!hubInstallId) return apiFailFromStatus(404, 'Home not found.');

  const room = await prisma.room.findFirst({
    where: { id: roomId, hubInstallId },
    select: { id: true, haAreaName: true, displayName: true },
  });
  if (!room) return apiFailFromStatus(404, 'Room not found.');

  const oldArea = room.haAreaName;
  if (oldArea.trim() === newHaAreaName.trim()) {
    return NextResponse.json({ ok: true, updated: false });
  }

  const hubContext = await getDinodiaOsHubContext(hubInstallId);
  const isDinodiaOs = hubContext?.runtimeKind === 'dinodia_os';
  let storedNewAreaName = newHaAreaName;
  if (isDinodiaOs) {
    if (!isDinodiaOsManagedAreaHub(hubContext)) {
      return apiFailFromStatus(409, 'The Dinodia OS hub heartbeat is stale. Wait for the hub to reconnect and try again.');
    }
    try {
      const result = await resyncDinodiaOsArea(hubInstallId, oldArea, newHaAreaName);
      storedNewAreaName = result.areaName;
    } catch (error) {
      if (error instanceof DinodiaOsAreaError) return apiFailFromStatus(error.status, error.message);
      return apiFailFromStatus(502, 'Unable to resync the area in Dinodia OS.');
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.room.update({
      where: { id: room.id },
      data: { haAreaName: storedNewAreaName },
    });

    const tenantIds = await tx.user.findMany({
      where: { homeId, role: Role.TENANT },
      select: { id: true },
    });
    const ids = tenantIds.map((t) => t.id);
    if (ids.length > 0) {
      await tx.accessRule.updateMany({
        where: { userId: { in: ids }, area: oldArea },
        data: { area: storedNewAreaName },
      });
    }
  });

  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.ROOM_HA_AREA_RESYNCED,
      homeId,
      actorUserId: operator.userId,
      metadata: { roomId: room.id, roomDisplayName: room.displayName, oldHaAreaName: oldArea, newHaAreaName: storedNewAreaName, dinodiaOs: isDinodiaOs },
    },
  });

  return NextResponse.json({ ok: true, updated: true });
}
