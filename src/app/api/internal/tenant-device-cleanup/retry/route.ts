// Architecture: API boundary /internal/tenant-device-cleanup/retry; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { cleanupPendingTenantDevices } from '@/lib/tenantDeviceCleanup';

function isAuthorized(req: NextRequest) {
  const configured = process.env.INTERNAL_API_SECRET || process.env.CRON_SECRET;
  if (!configured) return false;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${configured}`;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await cleanupPendingTenantDevices({ limit: 50 });
  return NextResponse.json({ ok: true, ...result });
}
