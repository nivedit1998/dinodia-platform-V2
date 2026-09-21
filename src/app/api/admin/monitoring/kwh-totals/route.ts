// Architecture: API boundary /admin/monitoring/kwh-totals; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { prisma } from '@/lib/prisma';
import { Role } from '@prisma/client';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const user = await getCurrentUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has ended. Please sign in again.' }, { status: 401 });
  }

  if (user.role !== Role.ADMIN) {
    return NextResponse.json({ ok: false, error: 'Admins only.' }, { status: 403 });
  }

  try {
    await requireTrustedAdminDevice(req, user.id);
  } catch (err) {
    const resp = toTrustedDeviceResponse(err);
    if (resp) return resp;
    throw err;
  }

  const body = await req.json().catch(() => null);
  const rawIds: unknown[] = Array.isArray(body?.entityIds) ? body.entityIds : [];
  const entityIds = rawIds
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());

  if (entityIds.length === 0) {
    return NextResponse.json({ ok: false, error: 'Provide entityIds as a non-empty array.' }, { status: 400 });
  }

  const uniqueIds = Array.from(new Set(entityIds));
  const { haConnection } = await getUserWithHaConnection(user.id);

  const rows = await prisma.monitoringReading.findMany({
    where: {
      haConnectionId: haConnection.id,
      entityId: { in: uniqueIds },
      unit: 'kWh',
    },
    orderBy: [{ entityId: 'asc' }, { capturedAt: 'asc' }],
  });

  const baselines = uniqueIds.map((entityId) => {
    const first = rows.find((r) => r.entityId === entityId);
    const numeric = first?.numericValue ?? (first ? Number(first.state) : null);
    const firstKwh = numeric !== null && Number.isFinite(numeric) ? Number(numeric) : null;
    return { entityId, firstKwh, firstCapturedAt: first?.capturedAt ?? null };
  });

  const priceEnv = process.env.ELECTRICITY_PRICE_PER_KWH;
  const pricePerKwh =
    typeof priceEnv === 'string' && priceEnv.trim().length > 0
      ? Number(priceEnv)
      : null;
  const validPrice =
    pricePerKwh !== null && Number.isFinite(pricePerKwh) && pricePerKwh >= 0
      ? pricePerKwh
      : null;

  return NextResponse.json({ ok: true, baselines, pricePerKwh: validPrice });
}
