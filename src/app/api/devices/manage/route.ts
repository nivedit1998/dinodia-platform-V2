// Architecture: API boundary /devices/manage; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getDeviceRecord } from '@/lib/deviceRegistry';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const user = await getCurrentUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  const trusted = await prisma.trustedDevice.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      deviceId: true,
      label: true,
      firstSeenAt: true,
      lastSeenAt: true,
      revokedAt: true,
    },
    orderBy: { lastSeenAt: 'desc' },
  });

  const withStatus = await Promise.all(
    trusted.map(async (entry) => {
      const registry = await getDeviceRecord(entry.deviceId);
      return {
        ...entry,
        status: registry?.status ?? 'ACTIVE',
        registryLabel: registry?.label ?? null,
      };
    })
  );

  return NextResponse.json({ devices: withStatus });
}
