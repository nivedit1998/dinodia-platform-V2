// Architecture: App Router surface src/app/support/ha-gate/route.ts; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { NextRequest, NextResponse } from 'next/server';
import { canAccessHomeSupport } from '@/lib/companyPortalAccess';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { escapeHtml } from '@/lib/htmlEscape';
import { prisma } from '@/lib/prisma';
import {
  buildSupportFailureMessage,
  buildSupportFailureTitle,
  createHomeSupportLaunchTicket,
  HOME_SUPPORT_BOOTSTRAP_RESUME_WINDOW_SECONDS,
  resolveHomeSupportGateStatus,
  type HomeSupportGateStatus,
} from '@/lib/supportHomeAccess';

export const runtime = 'nodejs';

function isValidHaHostname(raw: string | null) {
  if (!raw) return false;
  return /^ha[a-z0-9-]*\.dinodiasmartliving\.com$/i.test(raw.trim());
}

function buildStatusPath(input: { requestId: string; homeId: string; host: string }) {
  const statusUrl = new URL('/api/support/ha-gate/status', 'https://app.dinodiasmartliving.com');
  statusUrl.searchParams.set('requestId', input.requestId);
  statusUrl.searchParams.set('homeId', input.homeId);
  statusUrl.searchParams.set('host', input.host);
  return `${statusUrl.pathname}${statusUrl.search}`;
}

function buildBootstrapUrl(host: string) {
  const url = new URL(`https://${host}/`);
  url.searchParams.set('__dinodia_bootstrap', '1');
  return url.toString();
}

function buildStorageKey(requestId: string) {
  return `dinodia_ha_launch:${requestId}`;
}

function renderGatePage(input: {
  title: string;
  message: string;
  requestId?: string | null;
  homeId?: string | null;
  host?: string | null;
  showCodeForm?: boolean;
  showLoginLink?: boolean;
  showWaitingPoll?: boolean;
  showConnecting?: boolean;
  launchUrl?: string | null;
  bootstrapUrl?: string | null;
  failureCode?: string | null;
  loginHref?: string;
}) {
  const safeTitle = escapeHtml(input.title);
  const safeMessage = escapeHtml(input.message);
  const safeFailureCode = input.failureCode ? escapeHtml(input.failureCode) : null;
  const loginHref = input.loginHref ? escapeHtml(input.loginHref) : '/companylogin/login';
  const statusPath =
    input.requestId && input.homeId && input.host
      ? buildStatusPath({
          requestId: input.requestId,
          homeId: input.homeId,
          host: input.host,
        })
      : null;
  const storageKey = input.requestId ? buildStorageKey(input.requestId) : null;
  const hiddenFields =
    input.requestId && input.homeId && input.host
      ? `
        <input type="hidden" name="requestId" value="${escapeHtml(input.requestId)}" />
        <input type="hidden" name="homeId" value="${escapeHtml(input.homeId)}" />
        <input type="hidden" name="host" value="${escapeHtml(input.host)}" />
      `
      : '';
  const codeForm =
    input.showCodeForm && input.requestId && input.homeId && input.host
      ? `
      <form method="POST" id="ha-support-code-form" style="margin-top:16px;">
        ${hiddenFields}
        <label style="display:block;font-size:12px;color:#475569;font-weight:600;margin-bottom:8px;">Enter the one-time HASecurityCode</label>
        <input type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="width:100%;max-width:220px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px;letter-spacing:0.16em;" />
        <div style="margin-top:12px;">
          <button type="submit" id="ha-support-submit" style="padding:10px 16px; background:#111827; color:#fff; border:none; border-radius:8px; cursor:pointer;">Connect to the Dinodia hub</button>
        </div>
      </form>`
      : '';
  const waitingNote =
    input.showWaitingPoll && statusPath
      ? `<p style="margin-top:16px;color:#475569;">This page will update automatically when approval state changes.</p>`
      : '';
  const loginLink = input.showLoginLink
    ? `<p style="margin-top:16px;"><a href="${loginHref}" style="display:inline-block;padding:10px 16px;background:#111827;color:#fff;border-radius:8px;text-decoration:none;">Company login</a></p>`
    : '';
  const failureCodeBlock = safeFailureCode
    ? `<p style="margin-top:16px;font-size:12px;color:#475569;">Error code: <span style="font-family:monospace;">${safeFailureCode}</span></p>`
    : '';

  const scripts: string[] = [];

  if (input.showCodeForm) {
    scripts.push(`
      (function () {
        var form = document.getElementById("ha-support-code-form");
        var button = document.getElementById("ha-support-submit");
        if (!form || !button) return;
        form.addEventListener("submit", function () {
          button.setAttribute("disabled", "disabled");
          button.textContent = "Connecting...";
          button.style.opacity = "0.7";
          button.style.cursor = "default";
        });
      })();
    `);
  }

  if (input.showWaitingPoll && statusPath) {
    scripts.push(`
      (function () {
        var statusUrl = ${JSON.stringify(statusPath)};
        var terminal = {
          READY_FOR_CODE: true,
          RESUME_BOOTSTRAP: true,
          ACTIVE_OTHER_DEVICE: true,
          FAILED: true,
          EXPIRED: true,
          REVOKED: true
        };
        async function poll() {
          try {
            var res = await fetch(statusUrl, { cache: "no-store", credentials: "same-origin" });
            if (!res.ok) return;
            var data = await res.json();
            if (data && terminal[data.status]) {
              window.location.reload();
              return;
            }
          } catch (_err) {}
          window.setTimeout(poll, 3000);
        }
        window.setTimeout(poll, 3000);
      })();
    `);
  }

  if (input.showConnecting && storageKey) {
    scripts.push(`
      (function () {
        var storageKey = ${JSON.stringify(storageKey)};
        var launchUrl = ${JSON.stringify(input.launchUrl || "")};
        var bootstrapUrl = ${JSON.stringify(input.bootstrapUrl || "")};
        var now = Date.now();
        var maxAgeMs = ${HOME_SUPPORT_BOOTSTRAP_RESUME_WINDOW_SECONDS * 1000};
        try {
          var current = {
            launchUrl: launchUrl || null,
            bootstrapUrl: bootstrapUrl || null,
            createdAt: now
          };
          if (launchUrl || bootstrapUrl) {
            sessionStorage.setItem(storageKey, JSON.stringify(current));
          }
          var raw = sessionStorage.getItem(storageKey);
          var parsed = raw ? JSON.parse(raw) : null;
          var target = "";
          if (parsed && parsed.createdAt && now - Number(parsed.createdAt) < maxAgeMs) {
            target = parsed.launchUrl || parsed.bootstrapUrl || "";
          }
          if (!target) {
            target = bootstrapUrl || launchUrl || "";
          }
          if (!target) return;
          window.setTimeout(function () {
            window.location.replace(target);
          }, 120);
        } catch (_err) {
          var fallback = bootstrapUrl || launchUrl || "";
          if (!fallback) return;
          window.setTimeout(function () {
            window.location.replace(fallback);
          }, 120);
        }
      })();
    `);
  }

  const scriptBlock =
    scripts.length > 0 ? `<script>${scripts.join('\n')}</script>` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dinodia support gate</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 40px; }
      .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0 0 12px 0; font-size: 22px; }
      p { margin: 0; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      ${waitingNote}
      ${codeForm}
      ${failureCodeBlock}
      ${loginLink}
    </div>
    ${scriptBlock}
  </body>
</html>`;
}

function html(input: Parameters<typeof renderGatePage>[0], status = 200) {
  return new NextResponse(renderGatePage(input), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function renderGateState(input: {
  gateStatus: HomeSupportGateStatus;
  requestId: string;
  homeId: string;
  host: string;
  approvedBy: string;
  failureCode?: string | null;
}) {
  switch (input.gateStatus) {
    case 'WAITING_FOR_APPROVAL':
      return html({
        title: 'Approval required',
        message:
          'This support request has not been approved yet. Return to Home Support and wait for the homeowner or property manager approval email.',
        requestId: input.requestId,
        homeId: input.homeId,
        host: input.host,
        showWaitingPoll: true,
      });
    case 'READY_FOR_CODE':
      return html({
        title: 'Connect to the Dinodia hub',
        message: `Approved by ${input.approvedBy}. Enter the current one-time HASecurityCode to continue into Home Assistant.`,
        requestId: input.requestId,
        homeId: input.homeId,
        host: input.host,
        showCodeForm: true,
      });
    case 'RESUME_BOOTSTRAP':
      return html({
        title: 'Connecting to the Dinodia hub',
        message: 'The support session is already being prepared on this device. Continuing into Home Assistant now.',
        requestId: input.requestId,
        homeId: input.homeId,
        host: input.host,
        showConnecting: true,
        bootstrapUrl: buildBootstrapUrl(input.host),
      });
    case 'ACTIVE_OTHER_DEVICE':
      return html(
        {
          title: 'Session already active',
          message: 'This support session is already in use on another device or tab. Request access again if needed.',
        },
        409
      );
    case 'FAILED':
      return html(
        {
          title: buildSupportFailureTitle(),
          message: buildSupportFailureMessage(),
          failureCode: input.failureCode ?? null,
        },
        410
      );
    case 'REVOKED':
      return html(
        {
          title: 'Access revoked',
          message: 'This support request has already been revoked.',
        },
        410
      );
    case 'EXPIRED':
      return html(
        {
          title: 'Approval expired',
          message: 'This support approval has expired. Request approval again from Home Support.',
        },
        410
      );
    default:
      return html(
        {
          title: 'Support request not found',
          message: 'This support request does not belong to your company account or no longer exists.',
        },
        404
      );
  }
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  const requestId = req.nextUrl.searchParams.get('requestId');
  const homeId = req.nextUrl.searchParams.get('homeId');
  const host = req.nextUrl.searchParams.get('host');
  const currentPath = `${req.nextUrl.pathname}${req.nextUrl.search}`;

  if (!me || !canAccessHomeSupport(me.role)) {
    return html(
      {
        title: 'Company login required',
        message:
          'Dinodia company login is required before remote Home Assistant access can continue. Sign in, then return to this page from Home Support.',
        showLoginLink: true,
        loginHref: `/companylogin/login?next=${encodeURIComponent(currentPath)}`,
      },
      401
    );
  }

  if (!requestId || !homeId || !isValidHaHostname(host)) {
    return html(
      {
        title: 'Support request required',
        message:
          'No active Home Support request was supplied for this home. Start from the Home Support page and request approved access first.',
      },
      400
    );
  }
  const resolvedHost = host!.trim();

  const supportRequest = await prisma.supportRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      homeId: true,
      installerUserId: true,
      approvedAt: true,
      approvalValidUntil: true,
      approvalRecipientName: true,
      approvalRecipientEmail: true,
      revokedAt: true,
      haSessionRevokedAt: true,
      haSessionFailureAt: true,
      haSessionFailureCode: true,
      haSessionStartedAt: true,
      haSessionExpiresAt: true,
      haSessionEndedAt: true,
      haSecurityCodeHash: true,
      haSecurityCodeConsumedAt: true,
      haSecurityCodeExpiresAt: true,
      gatewaySessionHash: true,
      gatewaySessionBoundAt: true,
      gatewaySessionUserAgentHash: true,
    },
  });

  if (!supportRequest || supportRequest.homeId !== Number(homeId) || supportRequest.installerUserId !== me.id) {
    return renderGateState({
      gateStatus: 'NOT_FOUND',
      requestId,
      homeId,
      host: resolvedHost,
      approvedBy: 'the approver',
    });
  }

  const gateStatus = resolveHomeSupportGateStatus(supportRequest, req.headers.get('user-agent'));
  const approvedBy = supportRequest.approvalRecipientName || supportRequest.approvalRecipientEmail || 'the approver';
  return renderGateState({
    gateStatus,
    requestId,
    homeId,
    host: resolvedHost,
    approvedBy,
    failureCode: supportRequest.haSessionFailureCode ?? null,
  });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  const currentPath = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (!me || !canAccessHomeSupport(me.role)) {
    return html(
      {
        title: 'Company login required',
        message:
          'Dinodia company login is required before remote Home Assistant access can continue. Sign in, then return to this page from Home Support.',
        showLoginLink: true,
        loginHref: `/companylogin/login?next=${encodeURIComponent(currentPath)}`,
      },
      401
    );
  }

  const form = await req.formData().catch(() => null);
  const requestId = form?.get('requestId')?.toString() || null;
  const homeId = form?.get('homeId')?.toString() || null;
  const host = form?.get('host')?.toString() || null;
  const code = form?.get('code')?.toString().trim() || '';

  if (!requestId || !homeId || !isValidHaHostname(host)) {
    return html(
      {
        title: 'Support request required',
        message: 'No valid support request was supplied for this home.',
      },
      400
    );
  }
  const resolvedHost = host!.trim();

  if (!/^\d{6}$/.test(code)) {
    return html(
      {
        title: 'Code required',
        message: 'Enter the 6-digit HASecurityCode shown to the homeowner or property manager after approval.',
        requestId,
        homeId,
        host: resolvedHost,
        showCodeForm: true,
      },
      400
    );
  }

  const result = await createHomeSupportLaunchTicket({
    client: prisma,
    supportRequestId: requestId,
    installerUserId: me.id,
    code,
    hostname: resolvedHost,
    actorUserId: me.id,
    actorUsername: me.username,
    userAgent: req.headers.get('user-agent'),
  });

  if (!result.ok) {
    if (result.reason === 'BOOTSTRAP_IN_PROGRESS') {
      return html({
        title: 'Connecting to the Dinodia hub',
        message: 'The support session is already being prepared on this device. Continuing into Home Assistant now.',
        requestId,
        homeId,
        host: resolvedHost,
        showConnecting: true,
        bootstrapUrl: buildBootstrapUrl(resolvedHost),
      });
    }

    const message =
      result.reason === 'ACTIVE_OTHER_DEVICE'
        ? 'This support session is already in use on another device or tab. Request access again if needed.'
        : result.reason === 'INVALID_CODE'
          ? 'The HASecurityCode is not valid for this request. Approval must be requested again.'
          : buildSupportFailureMessage();
    return html(
      {
        title: result.reason === 'ACTIVE_OTHER_DEVICE' ? 'Session already active' : buildSupportFailureTitle(),
        message,
      },
      result.reason === 'ACTIVE_OTHER_DEVICE' ? 409 : 410
    );
  }

  const launchUrl = new URL(`https://${resolvedHost}/__dinodia/launch`);
  launchUrl.searchParams.set('ticket', result.launchTicket);

  return html({
    title: 'Connecting to the Dinodia hub',
    message: 'Connecting to Home Assistant now. This page will continue automatically.',
    requestId,
    homeId,
    host: resolvedHost,
    showConnecting: true,
    launchUrl: launchUrl.toString(),
    bootstrapUrl: buildBootstrapUrl(resolvedHost),
  });
}
