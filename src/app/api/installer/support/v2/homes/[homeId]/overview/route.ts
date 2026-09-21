// Stage 1 native support overview. This endpoint is for the Company Portal
// operator only; it exposes durable scope choices and session status, never
// tenant-device inventory, support codes or hub credentials.
import { NextRequest, NextResponse } from 'next/server';
import { HomeMembershipRole, HomeMembershipStatus } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportViewer } from '@/lib/companyPortalGuards';

function parseHomeId(value: string | undefined) {
  const homeId = Number(value);
  return Number.isInteger(homeId) && homeId > 0 ? homeId : null;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  const operator = await requireCompanyHomeSupportViewer(req);
  if (operator instanceof NextResponse) return operator;

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

  const [home, memberships, sessions] = await Promise.all([
    prisma.home.findUnique({ where: { id: homeId }, select: { id: true, hubInstall: { select: { id: true, serial: true } } } }),
    prisma.homeMembership.findMany({
      where: { homeId, status: HomeMembershipStatus.ACTIVE, removedAt: null },
      orderBy: [{ role: 'asc' }, { userId: 'asc' }],
      select: {
        id: true,
        userId: true,
        role: true,
        areaGrants: { where: { revokedAt: null }, select: { areaId: true } },
        user: { select: { username: true, email: true } },
      },
    }),
    prisma.supportAccessSession.findMany({
      where: { homeId, assignedEmployeeId: operator.userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        supportRequestId: true,
        targetUserId: true,
        scope: true,
        areaIds: true,
        includesTenantDevices: true,
        status: true,
        approvedAt: true,
        expiresAt: true,
        redeemedAt: true,
        endedAt: true,
        hubRevokePending: true,
        createdAt: true,
      },
    }),
  ]);

  if (!home?.hubInstall) return apiFailFromStatus(404, 'Dinodia OS home or hub not found.');

  const rooms = await prisma.room.findMany({
    where: { hubInstallId: home.hubInstall.id },
    select: { id: true, displayName: true, haAreaName: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  const areaLabels = new Map(rooms.map((room) => [String(room.id), room.displayName || room.haAreaName || String(room.id)]));
  const tenantMemberships = memberships.filter((membership) => membership.role === HomeMembershipRole.TENANT);

  return NextResponse.json({
    ok: true,
    homeId,
    hubSerial: home.hubInstall.serial,
    areas: Array.from(new Set(memberships.flatMap((membership) => membership.areaGrants.map((grant) => String(grant.areaId))))).map((id) => ({ id, label: areaLabels.get(id) ?? id })),
    tenants: tenantMemberships.map((membership) => ({
      userId: membership.userId,
      username: membership.user.username,
      email: membership.user.email,
      areaIds: membership.areaGrants.map((grant) => String(grant.areaId)),
    })),
    sessions: sessions.map((session) => ({
      id: session.id,
      ticketId: session.supportRequestId,
      targetUserId: session.targetUserId,
      scope: session.scope,
      areaIds: Array.isArray(session.areaIds) ? session.areaIds.map(String) : [],
      includesTenantDevices: session.includesTenantDevices,
      status: session.status,
      approvedAt: session.approvedAt,
      expiresAt: session.expiresAt,
      redeemedAt: session.redeemedAt,
      endedAt: session.endedAt,
      hubRevokePending: session.hubRevokePending,
      createdAt: session.createdAt,
    })),
  }, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
