// Architecture: API boundary /installer/home-support/homes/[homeId]/policy-email/resend; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { canAccessHomeSupport } from '@/lib/companyPortalAccess';
import {
  getPolicyNotificationDeliveryStatus,
  resendPendingPolicyAcceptedEmails,
} from '@/lib/homeownerPolicyNotifications';

function parseHomeId(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ homeId: string }> }
) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || !canAccessHomeSupport(me.role)) {
    return NextResponse.json({ ok: false, error: 'Installer access required.' }, { status: 401 });
  }

  const { homeId: rawHomeId } = await context.params;
  const homeId = parseHomeId(rawHomeId);
  if (!homeId) {
    return NextResponse.json({ ok: false, error: 'Invalid home id.' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const reason =
    body && typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : '';

  if (!reason) {
    return NextResponse.json({ ok: false, error: 'Reason is required for resend.' }, { status: 400 });
  }

  const status = await getPolicyNotificationDeliveryStatus(homeId);
  if (!status) {
    return NextResponse.json({ ok: false, error: 'No homeowner policy acceptance found for this home.' }, { status: 404 });
  }

  if (!status.canResend) {
    return NextResponse.json({ ok: false, error: 'No pending or failed homeowner policy emails to resend.' }, { status: 409 });
  }

  try {
    const result = await resendPendingPolicyAcceptedEmails({
      homeId,
      actorUserId: me.id,
      reason,
    });

    return NextResponse.json({
      ok: true,
      acceptanceId: result.acceptanceId,
      allSent: result.allSent,
      skipped: result.skipped,
      results: result.results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resend homeowner policy emails.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
