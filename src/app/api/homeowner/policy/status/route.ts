// Architecture: API boundary /homeowner/policy/status; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getHomeownerPolicyStatus } from '@/lib/homeownerPolicy';

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json({ ok: false, error: 'Admin access required.' }, { status: 401 });
  }

  const status = await getHomeownerPolicyStatus(me.id);
  if (!status) {
    return NextResponse.json({ ok: false, error: 'User not found.' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    policyVersion: status.policyVersion,
    requiresAcceptance: status.requiresAcceptance,
    emailVerified: status.emailVerified,
    acceptedVersion: status.acceptedVersion,
    acceptedAt: status.acceptedAt,
    currentAcceptance: status.currentAcceptance,
    homeId: status.homeId,
    pendingOnboardingId: status.pendingOnboardingId,
    pendingEmailVerifiedAt: status.pendingEmailVerifiedAt,
    pendingPolicyAcceptedAt: status.pendingPolicyAcceptedAt,
    pendingExpiresAt: status.pendingExpiresAt,
  });
}
