import { NextResponse } from 'next/server';
import { runNativeOperations, acquireOperationsLease } from '@/lib/nativeOperations';

export const dynamic = 'force-dynamic';

function authorized(request: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? '');
  const supplied = request.headers.get('authorization') ?? '';
  return Boolean(secret && supplied === `Bearer ${secret}`);
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const now = new Date();
  if (!(await acquireOperationsLease('native-operations', now))) return NextResponse.json({ ok: true, skipped: 'already_running' }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  try { return NextResponse.json({ ok: true, ...(await runNativeOperations(now)) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ ok: false, error: 'Native operations failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }); }
}
