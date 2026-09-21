// Architecture: API boundary /tenant/monitoring/history; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { getDevicesForHaConnection } from '@/lib/devicesSnapshot';
import { aggregateMonitoringHistory, parseBucket, parseDays } from '@/lib/monitoringHistory';
import { logServerError } from '@/lib/serverErrorLog';

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || (me.role !== Role.ADMIN && me.role !== Role.TENANT)) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
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

  let user;
  let haConnection;
  try {
    ({ user, haConnection } = await getUserWithHaConnection(me.id));
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'HA connection not configured' },
      { status: 400 }
    );
  }

  const haConnectionId = haConnection.id;

  if (user.role === Role.TENANT) {
    let devices;
    try {
      devices = await getDevicesForHaConnection(haConnectionId);
    } catch (err) {
      logServerError('[api/tenant/monitoring/history] Failed to fetch devices for tenant history', err, {
        userId: me.id,
        haConnectionId,
      });
      return NextResponse.json(
        { error: 'Dinodia Hub did not respond when loading devices.' },
        { status: 502 }
      );
    }

    const allowedDevices = devices.filter(
      (d) =>
        d.areaName !== null &&
        user.accessRules.some((r) => r.area === d.areaName)
    );
    const target = allowedDevices.find((d) => d.entityId === entityId);
    if (!target) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'You don’t have access to this device. Ask the homeowner to update your access in Dinodia.',
        },
        { status: 403 }
      );
    }
  }

  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let readings;
  let baseline;
  try {
    readings = await prisma.monitoringReading.findMany({
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
    baseline = await prisma.monitoringReading.findFirst({
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
  } catch (err) {
    logServerError('[api/tenant/monitoring/history] Failed to fetch monitoring history', err, {
      userId: me.id,
      haConnectionId,
    });
    return NextResponse.json(
      { error: 'Failed to load history' },
      { status: 500 }
    );
  }

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
