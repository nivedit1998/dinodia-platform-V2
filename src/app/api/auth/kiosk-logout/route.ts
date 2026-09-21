// Architecture: API boundary /auth/kiosk-logout; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { requireKioskDeviceSession } from '@/lib/deviceAuth';
import { bumpTrustedDeviceSession } from '@/lib/deviceTrust';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const kiosk = await requireKioskDeviceSession(req);
  await bumpTrustedDeviceSession(kiosk.user.id, kiosk.deviceId);
  return NextResponse.json({ ok: true });
}
