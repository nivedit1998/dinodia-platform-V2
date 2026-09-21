// Browser-side operator-token minting is deliberately retired. The Company
// Portal issues only an opaque, durable handoff; Dinodia OS consumes it over
// its authenticated hub channel and keeps the short-lived OS bearer private.
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyOsSessionLauncher } from '@/lib/companyPortalGuards';

export async function POST(req: NextRequest) {
  const operator = await requireCompanyOsSessionLauncher(req);
  if (operator instanceof NextResponse) return operator;
  return NextResponse.json(
    { error: 'Operator sessions are consumed by the paired Dinodia OS hub.', errorCode: 'hub_only_operator_handoff' },
    { status: 410, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}
