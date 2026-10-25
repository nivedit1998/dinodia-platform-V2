import { NextResponse } from 'next/server';
import { customerChallengeState } from '@/lib/customerAuthChallenges';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ challengeId: string }> }) {
  try {
    const { challengeId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(challengeId)) return NextResponse.json({ ok: true, state: 'EXPIRED' }, { headers: { 'Cache-Control': 'no-store' } });
    const state = await customerChallengeState(challengeId);
    return NextResponse.json({ ok: true, state }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
