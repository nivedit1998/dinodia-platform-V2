// Architecture: API boundary /kiosk/context; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireKioskDeviceSession, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { logApiHit } from '@/lib/requestLog';
import { safeLog } from '@/lib/safeLogger';
import { getTenantOwnedTargetsForHome, getTenantOwnedTargetsForUser } from '@/lib/tenantOwnership';

function normalizeAutomationId(raw: string) {
  return raw.trim().replace(/^automation\./i, '');
}

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  logApiHit(req, '/api/kiosk/context');

  let user;
  try {
    ({ user } = await requireKioskDeviceSession(req));
  } catch (err) {
    const trusted = toTrustedDeviceResponse(err);
    if (trusted) {
      safeLog('warn', '[api/kiosk/context] trusted device rejected', {
        event: 'kiosk_context_trusted_rejected',
        route: '/api/kiosk/context',
        status: trusted.status,
      });
      return trusted;
    }
    return NextResponse.json({ error: 'Unable to verify this device.' }, { status: 401 });
  }

  const fullUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      username: true,
      role: true,
      homeId: true,
      haConnection: {
        select: {
          id: true,
          cloudUrl: true,
          ownerId: true,
        },
      },
      accessRules: {
        select: { area: true },
      },
    },
  });

  if (!fullUser || !fullUser.haConnection) {
    return NextResponse.json(
      { error: 'Dinodia Hub connection is not configured for this account.' },
      { status: 400 }
    );
  }

  if (!fullUser.homeId) {
    return NextResponse.json(
      { error: 'This account is not linked to a home.' },
      { status: 400 }
    );
  }

  const [homeAutomationRows, allTenantTargets, ownTenantTargets] = await Promise.all([
    prisma.homeAutomation.findMany({
      where: { homeId: fullUser.homeId },
      select: { automationId: true },
    }),
    getTenantOwnedTargetsForHome(fullUser.homeId, fullUser.haConnection.id),
    fullUser.role === Role.TENANT
      ? getTenantOwnedTargetsForUser(fullUser.id, fullUser.haConnection.id)
      : Promise.resolve({ deviceIds: [], entityIds: [], skippedDeviceIds: 0, skippedEntityIds: 0 }),
  ]);

  const tenantVisibleAutomationIds = Array.from(
    new Set(
      homeAutomationRows
        .map((row) => normalizeAutomationId(row.automationId))
        .filter(Boolean)
    )
  );

  return NextResponse.json({
    user: {
      id: fullUser.id,
      username: fullUser.username,
      role: fullUser.role,
      homeId: fullUser.homeId,
    },
    haConnection: {
      id: fullUser.haConnection.id,
      ownerId: fullUser.haConnection.ownerId,
      cloudEnabled: Boolean(fullUser.haConnection.cloudUrl?.trim()),
    },
    accessRules: fullUser.accessRules ?? [],
    tenantVisibleAutomationIds,
    tenantOwnedEntityIds: fullUser.role === Role.TENANT ? ownTenantTargets.entityIds : [],
    tenantOwnedDeviceIds: fullUser.role === Role.TENANT ? ownTenantTargets.deviceIds : [],
    allTenantOwnedEntityIds: allTenantTargets.entityIds,
    allTenantOwnedDeviceIds: allTenantTargets.deviceIds,
  });
}
