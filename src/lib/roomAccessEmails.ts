// Architecture: Shared platform helper src/lib/roomAccessEmails.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
type RoomAccessRequestEmailParams = {
  appUrl: string;
  approveUrl: string;
  rejectUrl: string;
  requestedName: string;
  requestedEmail: string;
  requestedPhoneNumber?: string | null;
  roomDisplayName: string;
};

export function buildRoomAccessRequestEmail(params: RoomAccessRequestEmailParams) {
  const { approveUrl, rejectUrl, requestedName, requestedEmail, requestedPhoneNumber, roomDisplayName } = params;

  const subject = `Approve room access request: ${roomDisplayName}`;
  const phoneLine = requestedPhoneNumber ? `<p style="margin: 0 0 16px 0; color: #334155;">Phone: ${escapeHtml(requestedPhoneNumber)}</p>` : '';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">A tenant requested access to <strong>${roomDisplayName}</strong>.</p>
      <p style="margin: 0 0 12px 0; color: #334155;">Name: ${escapeHtml(requestedName)}</p>
      <p style="margin: 0 0 16px 0; color: #334155;">Email: ${escapeHtml(requestedEmail)}</p>
      ${phoneLine}
      <p style="margin: 0 0 16px 0;">Approve or reject this request:</p>
      <p style="margin: 0 0 12px 0;">
        <a href="${approveUrl}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Approve</a>
      </p>
      <p style="margin: 0 0 16px 0;">
        <a href="${rejectUrl}" style="background:#b91c1c;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Reject</a>
      </p>
      <p style="margin: 0 0 12px 0;">Approve link: <a href="${approveUrl}">${approveUrl}</a></p>
      <p style="margin: 0 0 12px 0;">Reject link: <a href="${rejectUrl}">${rejectUrl}</a></p>
      <p style="margin: 0 0 12px 0; color: #475569;">These links expire in 7 days.</p>
      <p style="margin: 0 0 12px 0; color: #475569;">You can return to <a href="${params.appUrl}">${params.appUrl}</a> anytime.</p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    '',
    `A tenant requested access to ${roomDisplayName}.`,
    `Name: ${requestedName}`,
    `Email: ${requestedEmail}`,
    ...(requestedPhoneNumber ? [`Phone: ${requestedPhoneNumber}`] : []),
    '',
    `Approve: ${approveUrl}`,
    `Reject: ${rejectUrl}`,
    '',
    'These links expire in 7 days.',
  ].join('\n');

  return { subject, html, text };
}

export function buildTenantWelcomeEmail(args: {
  appUrl: string;
  username: string;
  tempPassword: string;
  roomDisplayName: string;
}) {
  const subject = `You now have access to ${args.roomDisplayName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">Congratulations — you now have access to <strong>${escapeHtml(args.roomDisplayName)}</strong>.</p>
      <p style="margin: 0 0 12px 0;">Sign in with your email or username:</p>
      <p style="margin: 0 0 6px 0; color: #334155;">Username: <strong>${escapeHtml(args.username)}</strong></p>
      <p style="margin: 0 0 16px 0; color: #334155;">Temporary password: <strong>${escapeHtml(args.tempPassword)}</strong></p>
      <p style="margin: 0 0 16px 0;">Open the app and sign in at <a href="${args.appUrl}">${args.appUrl}</a>.</p>
      <p style="margin: 0 0 12px 0; color: #475569;">You’ll be asked to change your password on first login.</p>
    </div>
  `;
  const text = [
    'Dinodia Smart Living',
    '',
    `Congratulations — you now have access to ${args.roomDisplayName}.`,
    'Sign in with your email or username:',
    `Username: ${args.username}`,
    `Temporary password: ${args.tempPassword}`,
    '',
    `Open: ${args.appUrl}`,
    '',
    'You’ll be asked to change your password on first login.',
  ].join('\n');
  return { subject, html, text };
}

export function buildRoomAccessDecisionEmail(args: { status: 'APPROVED' | 'REJECTED'; roomDisplayName: string }) {
  const message =
    args.status === 'APPROVED'
      ? `Room access approved for ${args.roomDisplayName}.`
      : `Room access rejected for ${args.roomDisplayName}.`;
  return { message };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
