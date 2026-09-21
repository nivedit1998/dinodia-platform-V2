// Architecture: API boundary /installer/hubs/[hubInstallId]/ha-areas; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { requireTrustedPrivilegedDevice } from '@/lib/deviceAuth';
import { canAccessProvision } from '@/lib/companyPortalAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function addAreasFromHubSnapshot(addArea: (value: string | null | undefined) => void, snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const obj = snapshot as Record<string, unknown>;
  const rawAreas = obj.areas;
  if (!Array.isArray(rawAreas)) return;
  for (const row of rawAreas) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (name) addArea(name);
  }
}

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
  const hub = await prisma.hubInstall.findUnique({
    where: { id: hubInstallId },
    select: {
      id: true,
      lastReportedHaAreas: true,
      lastReportedHaAreasAt: true,
      rooms: { select: { haAreaName: true } },
    },
  });
  if (!hub) {
    return apiFailFromStatus(404, 'Hub not found.');
  }

  const merged = new Map<string, string>();
  const addArea = (value: string | null | undefined) => {
    const normalized = (value ?? '').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!merged.has(key)) merged.set(key, normalized);
  };

  (hub.rooms ?? []).forEach((r) => addArea(r.haAreaName));
  addAreasFromHubSnapshot(addArea, hub.lastReportedHaAreas);

  return NextResponse.json({
    ok: true,
    areas: Array.from(merged.values()).sort((a, b) => a.localeCompare(b)),
    capturedAt: hub.lastReportedHaAreasAt ? hub.lastReportedHaAreasAt.toISOString() : null,
  });
}
