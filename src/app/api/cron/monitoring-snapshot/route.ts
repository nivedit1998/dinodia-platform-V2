// Architecture: API boundary /cron/monitoring-snapshot; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
// Architecture boundary: scheduled monitoring ingress. The Cloudflare edge
// worker invokes this route with the cron authorization header; the route fans
// out to monitoring/boiler/hub-status snapshots and cleanup on both deployments.

import { NextRequest, NextResponse } from 'next/server';
import { captureBoilerTempSnapshotForAllConnections } from '@/lib/boilerMonitoring';
import { captureDailyMonitoringSnapshotForAllConnections } from '@/lib/monitoring';
import { cleanupMonitoringReadings } from '@/lib/monitoringCleanup';
import { captureElectricUsageSnapshotForAllConnections } from '@/lib/electricUsageMonitoring';
import { compactElectricUsageDetail } from '@/lib/electricUsageCompaction';
import { syncHubStatusMarkersForAllConnections } from '@/lib/hubStatusMarkers';
import { safeLog } from '@/lib/safeLogger';
import { logServerError } from '@/lib/serverErrorLog';
import { runNativeOperationsDispatcher } from '@/lib/nativeOperationsDispatcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPECTED_SECRET = process.env.CRON_SECRET;
const DISABLE_QUERY_SECRET =
  (process.env.DISABLE_CRON_QUERY_SECRET ?? 'true').toLowerCase() === 'true';

export async function GET(req: NextRequest) {
  if (!EXPECTED_SECRET) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 }
    );
  }

  const authHeader = req.headers.get('authorization');
  const bearerSecret =
    authHeader && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice('bearer '.length)
      : null;
  const secretParam = req.nextUrl.searchParams.get('secret');
  const secret =
    bearerSecret ?? (DISABLE_QUERY_SECRET ? null : secretParam);

  if (secretParam && DISABLE_QUERY_SECRET) {
    safeLog('warn', '[cron/monitoring-snapshot] Query param secret rejected; use Authorization header.');
  } else if (secretParam && process.env.NODE_ENV === 'production') {
    safeLog('warn', '[cron/monitoring-snapshot] Secret passed via query param; prefer Authorization header.');
  }

  if (!secret || secret !== EXPECTED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const boilerSummary = await captureBoilerTempSnapshotForAllConnections();
    const energySummary = await captureDailyMonitoringSnapshotForAllConnections();
    let electricSummary: Awaited<ReturnType<typeof captureElectricUsageSnapshotForAllConnections>> | null = null;
    let electricCompaction: Awaited<ReturnType<typeof compactElectricUsageDetail>> | null = null;
    let electricError: string | null = null;
    let electricCompactionError: string | null = null;

    try {
      electricSummary = await captureElectricUsageSnapshotForAllConnections();
    } catch (err) {
      electricError = err instanceof Error ? err.message : 'Electric usage snapshot failed';
      logServerError('[cron/monitoring-snapshot] electric usage snapshot error', err);
    }

    try {
      electricCompaction = await compactElectricUsageDetail();
    } catch (err) {
      electricCompactionError = err instanceof Error ? err.message : 'Electric usage compaction failed';
      logServerError('[cron/monitoring-snapshot] electric usage compaction error', err);
    }

    let cleanupError: string | null = null;
    let hubStatusError: string | null = null;
    let hubStatus: { processed: number; wrote: number } | null = null;
    let credentialLifecycle: Awaited<ReturnType<typeof runNativeOperationsDispatcher>>['credentialLifecycle'] | null = null;
    let credentialLifecycleError: string | null = null;

    try {
      await cleanupMonitoringReadings();
    } catch (err) {
      cleanupError = err instanceof Error ? err.message : 'Monitoring cleanup failed';
      logServerError('[cron/monitoring-snapshot] cleanup error', err);
    }

    try {
      hubStatus = await syncHubStatusMarkersForAllConnections();
    } catch (err) {
      hubStatusError = err instanceof Error ? err.message : 'Hub status sync failed';
      logServerError('[cron/monitoring-snapshot] hub status sync error', err);
    }

    try {
      credentialLifecycle = (await runNativeOperationsDispatcher()).credentialLifecycle;
    } catch (err) {
      credentialLifecycleError = err instanceof Error ? err.message : 'Credential lifecycle reconciliation failed';
      logServerError('[cron/monitoring-snapshot] credential lifecycle error', err);
    }

    const degraded =
      (boilerSummary.failedConnections ?? 0) > 0 ||
      (energySummary.failedConnections ?? 0) > 0 ||
      (electricSummary?.failedConnections ?? 0) > 0 ||
      electricError !== null ||
      electricCompactionError !== null ||
      cleanupError !== null ||
      hubStatusError !== null ||
      credentialLifecycleError !== null;

    if (degraded) {
      safeLog('warn', '[cron/monitoring-snapshot] completed with partial failures', {
        boilerFailedConnections: boilerSummary.failedConnections ?? 0,
        energyFailedConnections: energySummary.failedConnections ?? 0,
        electricFailedConnections: electricSummary?.failedConnections ?? 0,
        electricError,
        electricCompactionError,
        cleanupFailed: cleanupError !== null,
        credentialLifecycleFailed: credentialLifecycleError !== null,
      });
    }

    return NextResponse.json({
      ok: true,
      degraded,
      ...energySummary,
      boiler: boilerSummary,
      electricUsage: {
        ok: electricError === null,
        error: electricError,
        ...(electricSummary || { processed: 0, skipped: 0, failedConnections: 0 }),
      },
      electricCompaction: {
        ok: electricCompactionError === null,
        error: electricCompactionError,
        result: electricCompaction,
      },
      cleanup: {
        ok: cleanupError === null,
        error: cleanupError,
      },
      hubStatus: {
        ok: hubStatusError === null,
        error: hubStatusError,
        processed: hubStatus?.processed ?? 0,
        wrote: hubStatus?.wrote ?? 0,
      },
      credentialLifecycle: {
        ok: credentialLifecycleError === null,
        error: credentialLifecycleError,
        result: credentialLifecycle,
      },
    });
  } catch (err) {
    logServerError('[cron/monitoring-snapshot] error', err);
    return NextResponse.json({ error: 'Snapshot failed' }, { status: 500 });
  }
}
