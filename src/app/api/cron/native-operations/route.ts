import { NextResponse } from 'next/server';
import { runNativeOperations, acquireOperationsLease, completeOperationsLease } from '@/lib/nativeOperations';

export const dynamic = 'force-dynamic';

function isNativeOperationsAuthorized(request: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? '');
  const supplied = request.headers.get('authorization') ?? '';
  return Boolean(secret && supplied === `Bearer ${secret}`);
}

export async function POST(request: Request) {
  if (!isNativeOperationsAuthorized(request)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const now = new Date();
  const lease = await acquireOperationsLease('native-operations', now);
  if (!lease) return NextResponse.json({ ok: true, skipped: 'already_running' }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  let outcome: Parameters<typeof completeOperationsLease>[2] = { failedTasks: lease.taskIds };
  try {
    const result = await runNativeOperations(now);
    outcome = result;
    return NextResponse.json({ ok: result.failedTasks.length === 0, ...result }, { status: result.failedTasks.length ? 207 : 200, headers: { 'Cache-Control': 'no-store' } });
  }
  catch { return NextResponse.json({ ok: false, error: 'Native operations failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }); }
  finally { try { await completeOperationsLease('native-operations', lease, outcome); } catch { /* the bounded lease safely expires if recording fails */ } }
}
