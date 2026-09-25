import { NextResponse } from 'next/server';
import { runNativeOperations, acquireOperationsLease } from '@/lib/nativeOperations';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = String(process.env.CRON_SECRET ?? '');
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const now = new Date();
  if (!(await acquireOperationsLease('native-maintenance', now))) return NextResponse.json({ ok: true, skipped: 'already_running' }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  try { return NextResponse.json({ ok: true, ...(await runNativeOperations(now)) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ ok: false, error: 'Native maintenance failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }); }
}
