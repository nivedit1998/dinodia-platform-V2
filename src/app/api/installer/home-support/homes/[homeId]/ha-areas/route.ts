// Architecture: API boundary /installer/home-support/homes/[homeId]/ha-areas; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { requireCompanyHomeSupportQrOperator } from '@/lib/companyPortalGuards';

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

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export async function GET(req: NextRequest, context: { params: Promise<{ homeId: string }> }) {
  const operator = await requireCompanyHomeSupportQrOperator(req);
  if (operator instanceof NextResponse) return operator;

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');

  const home = await prisma.home.findUnique({
    where: { id: homeId },
    select: {
      hubInstall: {
        select: {
          id: true,
          lastReportedHaAreas: true,
          lastReportedHaAreasAt: true,
          rooms: { select: { haAreaName: true } },
        },
      },
    },
  });
  if (!home?.hubInstall) {
    return apiFailFromStatus(404, 'Home not found.');
  }

  const hub = home.hubInstall;
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
