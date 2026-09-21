import { NextRequest, NextResponse } from 'next/server';
import { parseManufacturingRoots } from '@/lib/manufacturingIdentity';
import { registerManufacturingAttempt } from '@/lib/durableProvisioning';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { envelope?: unknown; code?: unknown } | null;
  if (!body?.envelope || typeof body.code !== 'string' || body.code.length < 16 || body.code.length > 256) return NextResponse.json({ error: 'A signed pairing envelope and short-lived presentation are required.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  const roots = parseManufacturingRoots();
  const result = await registerManufacturingAttempt({ envelope: body.envelope as never, code: body.code, roots });
  if (!result.ok) return NextResponse.json({ error: 'Manufacturing identity was not accepted.', errorCode: result.errorCode }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json({ ok: true, attemptId: result.attemptId, pairingId: result.id, serial: result.serial, baseUrl: result.baseUrl, homeQrReference: result.homeQrReference, expiresAt: result.expiresAt }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
