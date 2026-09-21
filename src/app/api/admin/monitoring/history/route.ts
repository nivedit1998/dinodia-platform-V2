// Architecture: API boundary /admin/monitoring/history; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { aggregateMonitoringHistory, parseBucket, parseDays } from '@/lib/monitoringHistory';

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const entityId = searchParams.get('entityId');
  const bucket = parseBucket(searchParams.get('bucket'));
  const days = parseDays(bucket, searchParams.get('days'));

  if (!entityId || typeof entityId !== 'string' || entityId.trim().length === 0) {
    return NextResponse.json(
      { error: 'Please select a valid device to view history.' },
      { status: 400 }
    );
  }

  let haConnectionId: number;
  try {
    const { haConnection } = await getUserWithHaConnection(me.id);
    haConnectionId = haConnection.id;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'HA connection not configured' },
      { status: 400 }
    );
  }

  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const readings = await prisma.monitoringReading.findMany({
    where: {
      haConnectionId,
      entityId,
      capturedAt: { gte: fromDate },
    },
    orderBy: { capturedAt: 'asc' },
    select: {
      numericValue: true,
      unit: true,
      capturedAt: true,
    },
  });

  const baseline = await prisma.monitoringReading.findFirst({
    where: {
      haConnectionId,
      entityId,
      capturedAt: { lt: fromDate },
    },
    orderBy: { capturedAt: 'desc' },
    select: {
      numericValue: true,
      unit: true,
      capturedAt: true,
    },
  });

  const { unit, points } = aggregateMonitoringHistory({
    readings,
    baseline: baseline ?? null,
    bucket,
    omitFirstIfNoBaseline: true,
    entityId,
  });

  return NextResponse.json({
    ok: true,
    entityId,
    bucket,
    unit,
    points,
  });
}
