import { NextResponse } from 'next/server';
import { runNativeMaintenance, acquireOperationsLease, completeOperationsLease } from '@/lib/nativeOperations';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = String(process.env.CRON_SECRET ?? '');
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const now = new Date();
  const lease = await acquireOperationsLease('native-maintenance', now);
  if (!lease) return NextResponse.json({ ok: true, skipped: 'already_running' }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  let outcome: Parameters<typeof completeOperationsLease>[2] = { failedTasks: lease.taskIds };
  try {
    const result = await runNativeMaintenance(now);
    outcome = result;
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ ok: false, error: 'Native maintenance failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }); }
  finally { try { await completeOperationsLease('native-maintenance', lease, outcome); } catch { /* the bounded lease safely expires if recording fails */ } }
}
