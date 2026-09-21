// Architecture: API boundary /trigger-devices; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';

import { requireUserFromRequest } from '@/lib/apiGuards';
import { getTriggerDeviceDashboardContextForTenant } from '@/lib/triggerDevices';
import { safeLog } from '@/lib/safeLogger';

export async function GET(req: NextRequest) {
  let me;
  try {
    me = await requireUserFromRequest(req);
  } catch {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  if (me.role === Role.ADMIN) {
    return NextResponse.json({ error: 'Admin dashboards are observe-only.' }, { status: 403 });
  }

  try {
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const data = await getTriggerDeviceDashboardContextForTenant({
      userId: me.id,
      fresh,
      includeTargetOptions: true,
    });
    return NextResponse.json({
      ...data,
      degraded: false,
      retryInBackground: false,
      targetOptionsReady: true,
    });
  } catch (err) {
    safeLog('warn', '[api/trigger-devices] Failed to load trigger devices; returning empty trigger inventory', {
      error: err,
    });
    return NextResponse.json(
      {
        triggerDevices: [],
        targetOptions: [],
        degraded: true,
        retryInBackground: true,
        targetOptionsReady: false,
      },
      { status: 200 }
    );
  }
}
