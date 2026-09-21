// Architecture: API boundary /installer/home-support/homes/[homeId]/devices; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { requireActiveHomeAccess } from '@/lib/supportRequests';
import { canAccessHomeSupport } from '@/lib/companyPortalAccess';

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || !canAccessHomeSupport(me.role)) {
    return NextResponse.json({ error: 'Installer access required.' }, { status: 401 });
  }

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) {
    return NextResponse.json({ error: 'Invalid home id.' }, { status: 400 });
  }

  const homeAccess = await requireActiveHomeAccess({
    prisma,
    homeId,
    installerUserId: me.id,
  });
  if (!homeAccess.active) {
    return NextResponse.json({ error: 'Access is not currently available.' }, { status: 403 });
  }

  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: {
      id: true,
      haConnectionId: true,
      users: {
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          accessRules: { select: { area: true } },
        },
      },
    },
  });

  if (!home || !home.haConnectionId) {
    return NextResponse.json({ error: 'Home not found.' }, { status: 404 });
  }

  const devices = await getDevicesForHaConnection(home.haConnectionId, {
    cacheTtlMs: 0,
  });

  const devicesByUser = home.users.map((user) => {
    if (user.role !== Role.TENANT) {
      return { userId: user.id, username: user.username, email: user.email ?? null, role: user.role, devices };
    }

    const allowedAreas = new Set(user.accessRules.map((r) => r.area).filter(Boolean));
    const filtered = devices.filter((d) => {
      if (!d.areaName) return false;
      return allowedAreas.has(d.areaName);
    });
    return {
      userId: user.id,
      username: user.username,
      email: user.email ?? null,
      role: user.role,
      devices: filtered,
    };
  });

  return NextResponse.json({ ok: true, devicesByUser });
}
