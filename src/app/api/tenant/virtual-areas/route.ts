// Architecture: API boundary /tenant/virtual-areas; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { buildAreaAccessMatcher } from '@/lib/areaAccess';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }
  const { user, haConnection } = await getUserWithHaConnection(me.id);
  const areaAccess = await buildAreaAccessMatcher({
    haConnectionId: haConnection.id,
    accessAreas: user.accessRules.map((rule) => rule.area),
  });
  const areas = await prisma.tenantVirtualArea.findMany({
    where: { tenantUserId: user.id, haConnectionId: haConnection.id },
    orderBy: [{ parentHaAreaName: 'asc' }, { displayName: 'asc' }],
  });
  return NextResponse.json({
    ok: true,
    virtualAreas: areas.map((area) => ({
      ...area,
      parentDisplayAreaName:
        areaAccess.displayNameForArea(area.parentHaAreaName) ??
        area.parentAreaDisplaySnapshot ??
        area.parentHaAreaName,
    })),
  });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }
  const { user, haConnection } = await getUserWithHaConnection(me.id);
  const body = await req.json().catch(() => ({}));
  const requestedParentAreaName = normalizeDisplayText(body?.parentAreaName);
  const displayName = normalizeDisplayText(body?.displayName);
  if (!requestedParentAreaName || !displayName) {
    return apiFailFromStatus(400, 'Please choose a parent area and enter a sub-area name.');
  }
  const areaAccess = await buildAreaAccessMatcher({
    haConnectionId: haConnection.id,
    accessAreas: user.accessRules.map((rule) => rule.area),
  });
  const parentAreaName = areaAccess.resolveRequestedArea(requestedParentAreaName);
  if (!parentAreaName) {
    return apiFailFromStatus(403, 'You are not allowed to add sub-areas under that area.');
  }
  const allowedAreas = new Set(user.accessRules.map((rule) => rule.area));
  if (!allowedAreas.has(parentAreaName)) {
    return apiFailFromStatus(403, 'You are not allowed to add sub-areas under that area.');
  }
  const parentAreaDisplayName =
    areaAccess.displayNameForArea(parentAreaName) ?? requestedParentAreaName;
  const virtualArea = await prisma.tenantVirtualArea.upsert({
    where: {
      tenantUserId_haConnectionId_parentHaAreaName_displayKey: {
        tenantUserId: user.id,
        haConnectionId: haConnection.id,
        parentHaAreaName: parentAreaName,
        displayKey: normalizeLookupKey(displayName),
      },
    },
    update: { displayName, parentAreaDisplaySnapshot: parentAreaDisplayName },
    create: {
      tenantUserId: user.id,
      haConnectionId: haConnection.id,
      parentHaAreaName: parentAreaName,
      parentAreaDisplaySnapshot: parentAreaDisplayName,
      displayName,
      displayKey: normalizeLookupKey(displayName),
    },
  });
  return NextResponse.json({ ok: true, virtualArea });
}
