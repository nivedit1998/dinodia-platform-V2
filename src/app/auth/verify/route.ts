// Architecture: App Router surface src/app/auth/verify/route.ts; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { NextRequest, NextResponse } from 'next/server';
import { approveAuthChallengeByToken, getChallengeStatusByToken } from '@/lib/authChallenges';
import { safeLog } from '@/lib/safeLogger';

export const runtime = 'nodejs';

const STATUS_COPY: Record<string, string> = {
  EXPIRED: 'This verification link has expired. Please start again from your device.',
  CONSUMED:
    'This verification has already been completed. Return to the device where you started and it should continue automatically.',
  ALREADY_CONSUMED:
    'This verification has already been completed. Return to the device where you started and it should continue automatically.',
  NOT_FOUND: 'This verification link is not valid. Return to your device and request a new email.',
  APPROVED: 'This verification link was already approved. Return to your device and wait for it to finish.',
  ALREADY_APPROVED:
    'This verification link was already approved. Return to your device and wait for it to finish.',
  SUPERSEDED:
    'This verification link has been replaced by a newer email. Please use the most recent verification email.',
};

function statusResponse(status: string, message: string) {
  const httpStatus =
    status === 'NOT_FOUND' ? 404 : status === 'EXPIRED' ? 410 : 200;
  return new NextResponse(renderPage(message, false), {
    status: httpStatus,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) {
    return new NextResponse(renderPage('Missing token.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const statusResult = await getChallengeStatusByToken(token);
  const status = statusResult.status;

  if (status !== 'PENDING') {
    const message = STATUS_COPY[status] || 'This verification link is not valid.';
    return statusResponse(status, message);
  }

  return new NextResponse(renderPage('Confirm this verification to continue.', true, token), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function POST(req: NextRequest) {
  const token =
    req.nextUrl.searchParams.get('token') ||
    (await req.formData().then((d) => d.get('token')?.toString()).catch(() => null));

  if (!token) {
    return new NextResponse(renderPage('Missing token.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const result = await approveAuthChallengeByToken(token);

  if (!result.ok) {
    safeLog('info', '[auth/verify] POST result', {
      event: 'auth_verify_post',
      route: '/auth/verify',
      result:
        result.reason === 'SUPERSEDED'
          ? 'superseded'
          : result.reason === 'EXPIRED'
            ? 'expired'
            : 'not_found',
      challengeId: result.challengeId ?? null,
      purpose: result.purpose ?? null,
    });
    const message = STATUS_COPY[result.reason ?? ''] || 'This verification link is not valid.';
    return statusResponse(result.reason ?? 'NOT_FOUND', message);
  }

  safeLog('info', '[auth/verify] POST result', {
    event: 'auth_verify_post',
    route: '/auth/verify',
    result:
      result.status === 'APPROVED_NOW'
        ? 'approved_now'
        : result.status === 'ALREADY_APPROVED'
          ? 'already_approved'
          : 'already_consumed',
    challengeId: result.challengeId,
    purpose: result.purpose,
  });

  const message =
    result.status === 'ALREADY_CONSUMED'
      ? STATUS_COPY.ALREADY_CONSUMED
      : result.status === 'ALREADY_APPROVED'
        ? STATUS_COPY.ALREADY_APPROVED
        : 'Approved. Return to the device where you’re signing in.';

  return new NextResponse(renderPage(message), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function renderPage(message: string, showConfirm = false, token?: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dinodia verification</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 40px; }
      .card { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0 0 12px 0; font-size: 22px; }
      p { margin: 0; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Dinodia Smart Living</h1>
      <p>${message}</p>
      ${
        showConfirm && token
          ? `<form method="POST" style="margin-top:16px;">
          <input type="hidden" name="token" value="${token}" />
          <button type="submit" style="margin-top:8px; padding:10px 16px; background:#0f172a; color:#fff; border:none; border-radius:8px; cursor:pointer;">Confirm</button>
        </form>`
          : ''
      }
    </div>
  </body>
</html>`;
}
