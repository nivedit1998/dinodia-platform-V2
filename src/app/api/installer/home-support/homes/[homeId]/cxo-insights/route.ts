// Architecture: API boundary /installer/home-support/homes/[homeId]/cxo-insights; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { HomeContactType, PolicyKind, Role } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyHomeSupportCxoViewer } from '@/lib/companyPortalGuards';
import { TERMS_VERSION } from '@/lib/policyVersions';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ONLINE_RECENTLY_THRESHOLD_MS = 15 * 60 * 1000;

type HeartbeatHealth = 'ONLINE_RECENTLY' | 'STALE' | 'NEVER_SEEN';

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function getHeartbeatHealth(lastSeenAt: Date | null): HeartbeatHealth {
  if (!lastSeenAt) return 'NEVER_SEEN';
  return Date.now() - lastSeenAt.getTime() <= ONLINE_RECENTLY_THRESHOLD_MS ? 'ONLINE_RECENTLY' : 'STALE';
}

type TermsAcceptance = {
  policyVersion: string;
  acceptedAt: Date;
};

function shapeTerms(policyAcceptances: TermsAcceptance[]) {
  const current = policyAcceptances.find((acceptance) => acceptance.policyVersion === TERMS_VERSION) ?? null;
  const latest = policyAcceptances[0] ?? null;

  return {
    currentTermsVersion: TERMS_VERSION,
    currentTermsAccepted: Boolean(current),
    currentTermsAcceptedAt: current?.acceptedAt ?? null,
    latestAcceptedTermsVersion: latest?.policyVersion ?? null,
    latestAcceptedTermsAt: latest?.acceptedAt ?? null,
  };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  const operator = await requireCompanyHomeSupportCxoViewer(req);
  if (operator instanceof NextResponse) return operator;

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: {
      id: true,
      hubInstall: {
        select: {
          id: true,
          serial: true,
          lastSeenAt: true,
        },
      },
      homeContacts: {
        where: { type: HomeContactType.PROPERTY_MANAGER },
        select: { email: true },
      },
      users: {
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          accessRules: { select: { area: true } },
          policyAcceptances: {
            where: { policyKind: PolicyKind.TERMS },
            orderBy: { acceptedAt: 'desc' },
            select: {
              policyVersion: true,
              acceptedAt: true,
            },
          },
        },
      },
    },
  });

  if (!home || !home.hubInstall) {
    return apiFailFromStatus(404, 'Home not found.');
  }

  const rooms = await prisma.room.findMany({
    where: { hubInstallId: home.hubInstall.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      displayName: true,
      haAreaName: true,
      haAreaNameOriginal: true,
      status: true,
    },
  });

  const roomAreaNames = new Set(rooms.map((room) => room.haAreaName));
  const homeowners = home.users
    .filter((user) => user.role === Role.ADMIN)
    .map((user) => ({
      username: user.username,
      email: user.email ?? null,
    }));

  const tenantUsers = home.users
    .filter((user) => user.role === Role.TENANT)
    .map((user) => {
      const areas = Array.from(
        new Set(
          user.accessRules
            .map((rule) => rule.area?.trim())
            .filter((area): area is string => Boolean(area))
        )
      );

      return {
        userId: user.id,
        username: user.username,
        email: user.email ?? null,
        areas,
        ...shapeTerms(user.policyAcceptances),
      };
    });

  const roomRoster = rooms.map((room) => ({
    roomId: room.id,
    displayName: room.displayName,
    haAreaName: room.haAreaName,
    haAreaNameOriginal: room.haAreaNameOriginal,
    status: room.status,
    users: tenantUsers
      .filter((user) => user.areas.includes(room.haAreaName))
      .map(({ areas: _areas, ...user }) => user),
  }));

  const unassignedUsers = tenantUsers
    .filter((user) => !user.areas.some((area) => roomAreaNames.has(area)))
    .map(({ areas: _areas, ...user }) => user);

  return NextResponse.json({
    ok: true,
    homeId: home.id,
    currentTermsVersion: TERMS_VERSION,
    heartbeat: {
      lastSeenAt: home.hubInstall.lastSeenAt,
      serial: home.hubInstall.serial,
      health: getHeartbeatHealth(home.hubInstall.lastSeenAt),
    },
    homeowners,
    propertyManager: {
      email: home.homeContacts[0]?.email?.trim() ?? null,
    },
    roomRoster,
    unassignedUsers,
  });
}
