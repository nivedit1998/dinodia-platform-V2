// Architecture: API boundary /homeowner/onboarding/finalize; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { finalizePendingHomeownerOnboarding } from '@/lib/homeownerOnboardingPending';

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json({ ok: false, error: 'Admin access required.' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const pendingOnboardingId =
    body && typeof body.pendingOnboardingId === 'string' && body.pendingOnboardingId.trim().length > 0
      ? body.pendingOnboardingId.trim()
      : null;

  try {
    const result = await finalizePendingHomeownerOnboarding({
      userId: me.id,
      pendingOnboardingId,
    });

    return NextResponse.json({
      ok: true,
      finalized: result.finalized,
      pendingOnboardingId: result.pendingOnboardingId,
      homeId: result.homeId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to finalize homeowner onboarding.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
