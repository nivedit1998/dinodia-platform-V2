// Architecture: API boundary /admin/areas; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { prisma } from '@/lib/prisma';
import { normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { getAdminAreaInventory } from '@/lib/adminConfigurationInventory';
import {
  captureAlexaEndpointSnapshot,
  pushAlexaDiscoveryDiff,
  type AlexaEndpointSnapshot,
} from '@/lib/alexaDiscoverySync';
import { safeLog } from '@/lib/safeLogger';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function captureAlexaForHome(homeId: number, logContext: Record<string, unknown>): Promise<AlexaEndpointSnapshot> {
  try {
    return await captureAlexaEndpointSnapshot({ homeId });
  } catch (err) {
    safeLog('warn', '[api/admin/areas] Failed to capture Alexa discovery snapshot', { ...logContext, err });
    return new Map();
  }
}

async function pushAlexaAreaDiff(
  before: AlexaEndpointSnapshot,
  after: AlexaEndpointSnapshot,
  logContext: Record<string, unknown>
) {
  try {
    await pushAlexaDiscoveryDiff({ before, after });
  } catch (err) {
    safeLog('warn', '[api/admin/areas] Failed to push Alexa discovery diff', { ...logContext, err });
  }
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  let homeId: number;
  let haConnectionId: number;
  try {
    const resolved = await getUserWithHaConnection(me.id);
    const { user } = resolved;
    homeId = user.homeId!;
    haConnectionId = resolved.haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Dinodia Hub connection is missing for this home.' },
      { status: 400 }
    );
  }

  const inventory = await getAdminAreaInventory({ homeId, haConnectionId });
  return NextResponse.json({ ok: true, ...inventory });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  let homeId: number;
  let haConnectionId: number;
  try {
    const resolved = await getUserWithHaConnection(me.id);
    homeId = resolved.user.homeId!;
    haConnectionId = resolved.haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Dinodia Hub connection is missing for this home.' },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const haAreaName = normalizeDisplayText(body?.haAreaName);
  const displayName = normalizeDisplayText(body?.displayName);
  if (!haAreaName || !displayName) {
    return NextResponse.json(
      { error: 'Please include the Home Assistant area and display name.' },
      { status: 400 }
    );
  }
  const displayKey = normalizeLookupKey(displayName);
  const beforeAlexa = await captureAlexaForHome(homeId, { homeId, haConnectionId });
  const override = await prisma.areaDisplayOverride.upsert({
    where: { haConnectionId_haAreaName: { haConnectionId, haAreaName } },
    update: { displayName, displayKey, createdByUserId: me.id },
    create: { haConnectionId, haAreaName, displayName, displayKey, createdByUserId: me.id },
  });
  await prisma.tenantVirtualArea.updateMany({
    where: { haConnectionId, parentHaAreaName: haAreaName },
    data: { parentAreaDisplaySnapshot: displayName },
  });
  const afterAlexa = await captureAlexaForHome(homeId, { homeId, haConnectionId });
  await pushAlexaAreaDiff(beforeAlexa, afterAlexa, { homeId, haConnectionId });
  return NextResponse.json({ ok: true, area: override });
}

export const PATCH = POST;

export async function DELETE(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  let homeId: number;
  let haConnectionId: number;
  try {
    const resolved = await getUserWithHaConnection(me.id);
    homeId = resolved.user.homeId!;
    haConnectionId = resolved.haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Dinodia Hub connection is missing for this home.' },
      { status: 400 }
    );
  }

  const virtualAreas = await prisma.tenantVirtualArea.findMany({
    where: { haConnectionId },
    select: { id: true, parentHaAreaName: true },
  });

  const beforeAlexa = await captureAlexaForHome(homeId, { homeId, haConnectionId });
  await prisma.$transaction([
    prisma.areaDisplayOverride.deleteMany({ where: { haConnectionId } }),
    ...virtualAreas.map((area) =>
      prisma.tenantVirtualArea.update({
        where: { id: area.id },
        data: { parentAreaDisplaySnapshot: area.parentHaAreaName },
      })
    ),
  ]);
  const afterAlexa = await captureAlexaForHome(homeId, { homeId, haConnectionId });
  await pushAlexaAreaDiff(beforeAlexa, afterAlexa, { homeId, haConnectionId });

  return NextResponse.json({ ok: true });
}
