// Architecture: API boundary /installer/home-support/homes/[homeId]/rooms/[roomId]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportQrOperator } from '@/lib/companyPortalGuards';
import {
  DinodiaOsAreaError,
  getDinodiaOsHubContext,
  inspectDinodiaOsArea,
  isDinodiaOsManagedAreaHub,
  removeDinodiaOsArea,
} from '@/lib/dinodiaOsAreaProvisioning';
import { hashForLog } from '@/lib/safeLogger';
import { removeAreaFromHaAreasSnapshot } from '@/lib/haAreasSnapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export async function GET(
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
    select: { id: true, displayName: true, haAreaName: true },
  });
  if (!room) return apiFailFromStatus(404, 'Room not found.');

  const hubContext = await getDinodiaOsHubContext(hubInstallId);
  if (hubContext?.runtimeKind !== 'dinodia_os') {
    return NextResponse.json({ ok: true, dinodiaOs: false, area: null });
  }
  if (!isDinodiaOsManagedAreaHub(hubContext)) {
    return apiFailFromStatus(409, 'The Dinodia OS hub heartbeat is stale. Wait for the hub to reconnect and try again.');
  }
  try {
    const area = await inspectDinodiaOsArea(hubInstallId, room.haAreaName);
    return NextResponse.json({ ok: true, dinodiaOs: true, area });
  } catch (error) {
    if (error instanceof DinodiaOsAreaError) return apiFailFromStatus(error.status, error.message);
    return apiFailFromStatus(502, 'Unable to inspect the area in Dinodia OS.');
  }
}

export async function DELETE(
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
    select: { hubInstall: { select: { id: true, lastReportedHaAreas: true } } },
  });
  const hubInstallId = hub?.hubInstall?.id;
  if (!hubInstallId) return apiFailFromStatus(404, 'Home not found.');

  const room = await prisma.room.findFirst({
    where: { id: roomId, hubInstallId },
    select: { id: true, displayName: true, haAreaName: true },
  });
  if (!room) return apiFailFromStatus(404, 'Room not found.');

  const hubContext = await getDinodiaOsHubContext(hubInstallId);
  let areaRemoval: Awaited<ReturnType<typeof removeDinodiaOsArea>> | null = null;
  if (hubContext?.runtimeKind === 'dinodia_os') {
    if (!isDinodiaOsManagedAreaHub(hubContext)) {
      return apiFailFromStatus(409, 'The Dinodia OS hub heartbeat is stale. Wait for the hub to reconnect and try again.');
    }
    try {
      areaRemoval = await removeDinodiaOsArea(hubInstallId, room.haAreaName);
    } catch (error) {
      if (error instanceof DinodiaOsAreaError) return apiFailFromStatus(error.status, error.message);
      return apiFailFromStatus(502, 'Unable to remove the area from Dinodia OS. The room and QR code were kept.');
    }
  }

  const revoked = await prisma.$transaction(async (tx) => {
    const tenantIds = await tx.user.findMany({
      where: { homeId, role: Role.TENANT },
      select: { id: true },
    });
    const ids = tenantIds.map((t) => t.id);
    const accessRules = ids.length
      ? await tx.accessRule.deleteMany({ where: { userId: { in: ids }, area: room.haAreaName } })
      : { count: 0 };
    await tx.room.delete({ where: { id: room.id } });

    // Room deletion already changed the live Dinodia OS registry. Keep the
    // platform's cached snapshot in sync immediately instead of waiting for
    // the next heartbeat; an empty snapshot is valid and must be persisted.
    if (hubContext?.runtimeKind === 'dinodia_os' && areaRemoval) {
      const nextSnapshot = removeAreaFromHaAreasSnapshot(
        hub.hubInstall?.lastReportedHaAreas,
        room.haAreaName,
        areaRemoval.areaId,
        new Date()
      );
      if (nextSnapshot) {
        await tx.hubInstall.update({
          where: { id: hubInstallId },
          data: {
            lastReportedHaAreas: nextSnapshot,
            lastReportedHaAreasAt: new Date(nextSnapshot.capturedAt),
          },
        });
      }
    }
    return { accessRulesDeleted: accessRules.count };
  });

  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.ROOM_HA_AREA_RESYNCED,
      homeId,
      actorUserId: operator.userId,
      metadata: {
        action: 'ROOM_DELETED',
        roomId: room.id,
        roomDisplayName: room.displayName,
        haAreaName: room.haAreaName,
        accessRulesDeleted: revoked.accessRulesDeleted,
        dinodiaOsAreaRemoved: areaRemoval?.removed ?? false,
        dinodiaOsAreaAlreadyMissing: areaRemoval?.alreadyMissing ?? false,
        dinodiaOsAreaIdHash: hashForLog(areaRemoval?.areaId ?? ''),
        dinodiaOsDeviceAssignments: areaRemoval?.deviceCount ?? 0,
        dinodiaOsEntityAssignments: areaRemoval?.entityCount ?? 0,
      },
    },
  });

  return NextResponse.json({ ok: true, accessRulesDeleted: revoked.accessRulesDeleted });
}
