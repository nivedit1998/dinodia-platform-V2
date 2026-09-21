// Architecture: API boundary /policy/status; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserPolicyStatus } from '@/lib/policyAcceptance';
import { logServerError } from '@/lib/serverErrorLog';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(req);
    if (!user) return NextResponse.json({ ok: false, error: 'Authentication required.' }, { status: 401 });

    const status = await getUserPolicyStatus(user.id);
    return NextResponse.json({
      ok: true,
      privacyVersion: status.privacyVersion,
      termsVersion: status.termsVersion,
      privacyAccepted: status.privacyAccepted,
      termsAccepted: status.termsAccepted,
      privacyAcceptedAt: status.privacyAcceptedAt ? status.privacyAcceptedAt.toISOString() : null,
      termsAcceptedAt: status.termsAcceptedAt ? status.termsAcceptedAt.toISOString() : null,
    });
  } catch (err) {
    logServerError('[api/policy/status] unhandled', err);
    return NextResponse.json({ ok: false, error: 'Unable to load policy status.' }, { status: 500 });
  }
}
