// Architecture: API boundary /devices/manage/stolen; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { DeviceStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { markDeviceStatus } from '@/lib/deviceRegistry';
import { bumpTrustedDeviceSession } from '@/lib/deviceTrust';
import { requireKioskDeviceSession } from '@/lib/deviceAuth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const kiosk = await requireKioskDeviceSession(req).catch(() => null);
  const user = kiosk ? kiosk.user : await getCurrentUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => null);
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
  const label = typeof body?.label === 'string' ? body.label.trim() : undefined;

  if (!deviceId) {
    return NextResponse.json({ error: 'Device id is required.' }, { status: 400 });
  }

  await markDeviceStatus(deviceId, DeviceStatus.STOLEN, label);
  await prisma.trustedDevice.updateMany({
    where: { userId: user.id, deviceId },
    data: { revokedAt: new Date() },
  });
  await bumpTrustedDeviceSession(user.id, deviceId);

  return NextResponse.json({ ok: true });
}
