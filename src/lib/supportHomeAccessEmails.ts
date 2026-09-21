// Architecture: Shared platform helper src/lib/supportHomeAccessEmails.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

export type SupportSessionStartedEmailParams = {
  homeLabel: string;
  supportAgentName: string;
  startedAt: Date;
  appUrl: string;
};

function renderShell(subject: string, body: string) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; color: #0f172a; line-height: 1.6;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${body}</p>
    </div>
  `;
}

function formatStartedAt(value: Date) {
  return value.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildSupportHomeApprovalEmail(params: {
  verifyUrl: string;
  appUrl: string;
  installerUsername: string;
  homeLabel: string;
  recipientName?: string | null;
  reason: string;
}) {
  const greeting = params.recipientName ? `Hi ${params.recipientName},` : 'Hi,';
  const subject = 'Approve Dinodia Home Assistant support access';
  const body = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; color: #0f172a; line-height: 1.6;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${greeting}</p>
      <p style="margin: 0 0 12px 0;">
        Dinodia support wants temporary remote access to your Home Assistant backend for troubleshooting.
      </p>
      <p style="margin: 0 0 8px 0;"><strong>Support agent:</strong> ${params.installerUsername}</p>
      <p style="margin: 0 0 8px 0;"><strong>Home:</strong> ${params.homeLabel}</p>
      <p style="margin: 0 0 12px 0;"><strong>Reason:</strong> ${params.reason}</p>
      <p style="margin: 0 0 12px 0; color: #475569;">This approval expires in 30 minutes.</p>
      <p style="margin: 0 0 16px 0;">
        <a href="${params.verifyUrl}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Approve access</a>
      </p>
      <p style="margin: 0 0 12px 0;">If the button does not work, open this link: <a href="${params.verifyUrl}">${params.verifyUrl}</a></p>
      <p style="margin: 0; color: #475569;">You can always return to <a href="${params.appUrl}">${params.appUrl}</a>.</p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    greeting,
    '',
    'Dinodia support wants temporary remote access to your Home Assistant backend for troubleshooting.',
    `Support agent: ${params.installerUsername}`,
    `Home: ${params.homeLabel}`,
    `Reason: ${params.reason}`,
    '',
    'This approval expires in 30 minutes.',
    `Approve access: ${params.verifyUrl}`,
    `Return to ${params.appUrl}`,
  ].join('\n');

  return { subject, html: body, text };
}

export function buildSupportApprovalSuccessCopy(code: string) {
  return `Approval successful. Your one-time HASecurityCode is ${code}. This code expires in 10 minutes and can only be used once. If the support agent does not use it in time, they must request approval again.`;
}

export function buildSupportHomeownerAccessStartedEmail(params: SupportSessionStartedEmailParams) {
  const subject = 'Dinodia support is accessing your smart home';
  const body = `Your Dinodia home is being accessed by Dinodia support and we are trying to fix the issue.<br /><br />
    <strong>Support agent:</strong> ${params.supportAgentName}<br />
    <strong>Home:</strong> ${params.homeLabel}<br />
    <strong>Started:</strong> ${formatStartedAt(params.startedAt)}<br /><br />
    If this was not expected, please contact Dinodia support immediately.`;
  const html = renderShell(subject, body);
  const text = [
    'Dinodia Smart Living',
    '',
    'Your Dinodia home is being accessed by Dinodia support and we are trying to fix the issue.',
    `Support agent: ${params.supportAgentName}`,
    `Home: ${params.homeLabel}`,
    `Started: ${formatStartedAt(params.startedAt)}`,
    'If this was not expected, please contact Dinodia support immediately.',
    `App: ${params.appUrl}`,
  ].join('\n');
  return { subject, html, text };
}

export function buildSupportTenantAccessStartedEmail(params: SupportSessionStartedEmailParams) {
  const subject = 'Dinodia support is troubleshooting your smart home';
  const body = `Your Dinodia Home is facing some issues. With approval from your homeowner Dinodia support are trying to fix the issue remotely.<br /><br />
    <strong>Home:</strong> ${params.homeLabel}<br />
    <strong>Support agent:</strong> ${params.supportAgentName}<br />
    <strong>Started:</strong> ${formatStartedAt(params.startedAt)}<br /><br />
    If you were not expecting this, please contact Dinodia support.`;
  const html = renderShell(subject, body);
  const text = [
    'Dinodia Smart Living',
    '',
    'Your Dinodia Home is facing some issues. With approval from your homeowner Dinodia support are trying to fix the issue remotely.',
    `Home: ${params.homeLabel}`,
    `Support agent: ${params.supportAgentName}`,
    `Started: ${formatStartedAt(params.startedAt)}`,
    'If you were not expecting this, please contact Dinodia support.',
    `App: ${params.appUrl}`,
  ].join('\n');
  return { subject, html, text };
}
