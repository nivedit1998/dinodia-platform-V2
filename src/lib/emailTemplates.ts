// Architecture: Shared platform helper src/lib/emailTemplates.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
type VerifyEmailKind =
  | 'ADMIN_EMAIL_VERIFY'
  | 'TENANT_ENABLE_2FA'
  | 'LOGIN_NEW_DEVICE'
  | 'REMOTE_ACCESS_SETUP'
  | 'SUPPORT_HOME_ACCESS'
  | 'SUPPORT_USER_REMOTE_SUPPORT';

export type BuildVerifyLinkEmailParams = {
  kind: VerifyEmailKind;
  verifyUrl: string;
  appUrl: string;
  username?: string;
  deviceLabel?: string;
};

export function buildVerifyLinkEmail(params: BuildVerifyLinkEmailParams) {
  const { kind, verifyUrl, appUrl, username, deviceLabel } = params;

  const subject = (() => {
    switch (kind) {
      case 'ADMIN_EMAIL_VERIFY':
        return 'Verify your Dinodia admin email';
      case 'TENANT_ENABLE_2FA':
        return 'Enable email verification for your Dinodia account';
      case 'LOGIN_NEW_DEVICE':
        return 'Approve new device login on Dinodia';
      case 'REMOTE_ACCESS_SETUP':
        return 'Approve remote access setup on Dinodia';
      case 'SUPPORT_HOME_ACCESS':
        return 'Approve installer home support access';
      case 'SUPPORT_USER_REMOTE_SUPPORT':
        return 'Approve installer remote support access';
      default:
        return 'Verify your Dinodia access';
    }
  })();

  const purposeCopy = (() => {
    switch (kind) {
      case 'ADMIN_EMAIL_VERIFY':
        return 'Confirm your email to continue as a Dinodia admin.';
      case 'TENANT_ENABLE_2FA':
        return 'Verify your email to turn on device verification for your account.';
      case 'LOGIN_NEW_DEVICE':
        return `Approve this sign-in${deviceLabel ? ` from "${deviceLabel}"` : ''} before continuing.`;
      case 'REMOTE_ACCESS_SETUP':
        return `Approve remote access setup${deviceLabel ? ` on "${deviceLabel}"` : ''} to continue.`;
      case 'SUPPORT_HOME_ACCESS':
        return 'Allow your installer to view sensitive home credentials for support.';
      case 'SUPPORT_USER_REMOTE_SUPPORT':
        return 'Allow your installer to access your Dinodia dashboard for support.';
      default:
        return 'Complete email verification to continue.';
    }
  })();

  const greeting = username ? `Hi ${username},` : 'Hi,';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${greeting}</p>
      <p style="margin: 0 0 12px 0;">${purposeCopy}</p>
      <p style="margin: 0 0 16px 0;">Click the button to continue:</p>
      <p style="margin: 0 0 16px 0;">
        <a href="${verifyUrl}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Verify and continue</a>
      </p>
      <p style="margin: 0 0 12px 0;">Or open this link: <a href="${verifyUrl}">${verifyUrl}</a></p>
      <p style="margin: 0 0 12px 0; color: #475569;">This link expires soon.</p>
      <p style="margin: 0 0 12px 0; color: #475569;">You can always return to <a href="${appUrl}">${appUrl}</a> to sign in again.</p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    greeting,
    '',
    purposeCopy,
    'Verify and continue:',
    verifyUrl,
    '',
    'This link expires soon.',
    `Return to ${appUrl} to sign in again if needed.`,
  ].join('\n');

  return { subject, html, text };
}

export type BuildSupportApprovalEmailParams = {
  kind: 'SUPPORT_HOME_ACCESS' | 'SUPPORT_USER_REMOTE_SUPPORT';
  verifyUrl: string;
  appUrl: string;
  installerUsername: string;
  homeId: number;
  targetUsername?: string;
  reason?: string;
  scope?: string;
  revokeUrl?: string;
};

export function buildSupportApprovalEmail(params: BuildSupportApprovalEmailParams) {
  const { kind, verifyUrl, appUrl, installerUsername, homeId, targetUsername, reason, scope, revokeUrl } = params;
  const isHome = kind === 'SUPPORT_HOME_ACCESS';
  const subject = isHome
    ? 'Approve installer home support access'
    : 'Approve installer remote support access';
  const greeting = targetUsername ? `Hi ${targetUsername},` : 'Hi,';
  const purposeCopy = isHome
    ? `Allow installer "${installerUsername}" to view home credentials for Home #${homeId} to troubleshoot.`
    : `Allow installer "${installerUsername}" to temporarily access your Dinodia dashboard for Home #${homeId}.`;
  const normalizedReason = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null;
  const scopeCopy = (() => {
    if (isHome) {
      if (scope === 'VIEW_HOME_STATUS') return 'Requested scope: View home status only.';
      if (scope === 'VIEW_CREDENTIALS') return 'Requested scope: View home status and credentials.';
      return 'Requested scope: Home support access.';
    }
    if (scope === 'IMPERSONATE_USER') {
      return 'Requested scope: Temporary dashboard access as your account for troubleshooting.';
    }
    return 'Requested scope: Remote support access.';
  })();
  const safeAppUrl = appUrl.replace(/\/$/, '');
  const revokeLink = revokeUrl?.trim() || `${safeAppUrl}/tenant/dashboard?panel=access`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${greeting}</p>
      <p style="margin: 0 0 12px 0;">${purposeCopy}</p>
      <p style="margin: 0 0 12px 0; color: #334155;">${scopeCopy}</p>
      ${normalizedReason ? `<p style="margin: 0 0 12px 0; color: #334155;">Reason: ${normalizedReason}</p>` : ''}
      <p style="margin: 0 0 16px 0;">Click to approve this request:</p>
      <p style="margin: 0 0 16px 0;">
        <a href="${verifyUrl}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Approve access</a>
      </p>
      <p style="margin: 0 0 12px 0;">Or open this link: <a href="${verifyUrl}">${verifyUrl}</a></p>
      <p style="margin: 0 0 12px 0; color: #475569;">Support access is temporary and under your control.</p>
      <p style="margin: 0 0 16px 0;">
        <a href="${revokeLink}" style="background:#b91c1c;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Revoke access now</a>
      </p>
      <p style="margin: 0 0 12px 0;">Revoke link: <a href="${revokeLink}">${revokeLink}</a></p>
      <p style="margin: 0 0 12px 0; color: #475569;">This approval link expires soon.</p>
      <p style="margin: 0 0 12px 0; color: #475569;">You can return to <a href="${appUrl}">${appUrl}</a> anytime.</p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    greeting,
    '',
    purposeCopy,
    scopeCopy,
    normalizedReason ? `Reason: ${normalizedReason}` : null,
    'Approve access:',
    verifyUrl,
    '',
    'Support access is temporary and under your control.',
    'Revoke access now:',
    revokeLink,
    '',
    'This approval link expires soon.',
    `Return to ${appUrl} anytime.`,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');

  return { subject, html, text };
}

export type BuildTenantDeactivatedEmailParams = {
  appUrl: string;
  propertyLabel: string;
  username?: string;
};

export function buildTenantDeactivatedEmail(params: BuildTenantDeactivatedEmailParams) {
  const { appUrl, propertyLabel, username } = params;
  const greeting = username ? `Hi ${username},` : 'Hi,';
  const subject = 'Your Dinodia smart home account was deactivated';

  const body = `Your smart home account has been deactivated and you no longer have access to ${propertyLabel}.`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${greeting}</p>
      <p style="margin: 0 0 12px 0;">${body}</p>
      <p style="margin: 0 0 12px 0; color: #475569;">If you believe this is a mistake, contact your homeowner.</p>
      <p style="margin: 0 0 12px 0; color: #475569;">You can still visit <a href="${appUrl}">${appUrl}</a>.</p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    greeting,
    '',
    body,
    '',
    'If you believe this is a mistake, contact your homeowner.',
    `Visit: ${appUrl}`,
  ].join('\n');

  return { subject, html, text };
}

export type BuildPasswordResetEmailParams = {
  resetUrl: string;
  appUrl: string;
  username?: string;
  ttlMinutes?: number;
  roleLabel?: string;
};

export type BuildCompanyEmployeeWelcomeEmailParams = {
  loginUrl: string;
  username: string;
  roleLabel: string;
  temporaryPassword: string;
  isPasswordReset?: boolean;
};

export function buildCompanyEmployeeWelcomeEmail(params: BuildCompanyEmployeeWelcomeEmailParams) {
  const { loginUrl, username, roleLabel, temporaryPassword, isPasswordReset = false } = params;
  const subject = isPasswordReset
    ? 'Your Dinodia Smart Living password has been reset'
    : 'Welcome to Dinodia Smart Living';
  const greeting = `Hi ${username},`;
  const intro = isPasswordReset
    ? 'Your Dinodia Smart Living password has been reset by the CXO team.'
    : `You have been added to the Dinodia Smart Living company portal as ${roleLabel}.`;
  const cultureCopy =
    'Dinodia Smart Living builds secure connected-home software and internal operational tools with a strong focus on reliability, privacy, and clear ownership. We prefer careful changes, documented decisions, and practical collaboration.';
  const valuesCopy =
    'Our core values are: protect customer trust, keep systems simple, ship carefully, and work with honesty and respect.';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; color: #0f172a; line-height: 1.6;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${greeting}</p>
      <p style="margin: 0 0 12px 0;">${intro}</p>
      <p style="margin: 0 0 12px 0;">${cultureCopy}</p>
      <p style="margin: 0 0 12px 0;">${valuesCopy}</p>
      <p style="margin: 0 0 12px 0;"><strong>Temporary password:</strong> <code style="background:#f8fafc;padding:2px 6px;border-radius:4px;">${temporaryPassword}</code></p>
      <p style="margin: 0 0 12px 0;">Use the link below to get started. You will be asked to change your password on first login.</p>
      <p style="margin: 0 0 16px 0;">
        <a href="${loginUrl}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Get started</a>
      </p>
      <p style="margin: 0 0 12px 0;">Open the portal here: <a href="${loginUrl}">${loginUrl}</a></p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    greeting,
    '',
    intro,
    '',
    cultureCopy,
    '',
    valuesCopy,
    '',
    `Temporary password: ${temporaryPassword}`,
    'Get started:',
    loginUrl,
    '',
    'You will be asked to change your password on first login.',
  ].join('\n');

  return { subject, html, text };
}

export function buildPasswordResetEmail(params: BuildPasswordResetEmailParams) {
  const { resetUrl, appUrl, username, ttlMinutes = 10, roleLabel } = params;

  const greeting = username ? `Hi ${username},` : 'Hi,';
  const ttlCopy = ttlMinutes ? `This link expires in ${ttlMinutes} minutes.` : 'This link expires soon.';
  const accountLabel = roleLabel ? `${roleLabel} account` : 'account';

  const subject = roleLabel
    ? `Reset your Dinodia ${roleLabel} password`
    : 'Reset your Dinodia password';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${greeting}</p>
      <p style="margin: 0 0 12px 0;">We received a request to reset your Dinodia ${accountLabel} password. Click below to choose a new one.</p>
      ${username ? `<p style="margin: 0 0 12px 0; color: #475569;">Username: ${username}</p>` : ''}
      <p style="margin: 0 0 16px 0;">
        <a href="${resetUrl}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Reset password</a>
      </p>
      <p style="margin: 0 0 12px 0;">Or open this link: <a href="${resetUrl}">${resetUrl}</a></p>
      <p style="margin: 0 0 12px 0; color: #475569;">${ttlCopy}</p>
      <p style="margin: 0 0 12px 0; color: #475569;">If you didn’t request this, you can ignore this email. Your password won’t change until you reset it.</p>
      <p style="margin: 0 0 12px 0; color: #475569;">You can always return to <a href="${appUrl}">${appUrl}</a> to sign in again.</p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    greeting,
    '',
    `We received a request to reset your Dinodia ${accountLabel} password. Use the link below to choose a new one:`,
    username ? `Username: ${username}` : null,
    resetUrl,
    '',
    ttlCopy,
    'If you didn’t request this, you can ignore this email. Your password won’t change until you reset it.',
    `You can return to ${appUrl} to sign in again.`,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');

  return { subject, html, text };
}

export type BuildHomeownerPolicyAcceptedEmailParams = {
  appUrl: string;
  policyVersion: string;
  homeownerUsername: string;
  signatureName: string;
  acceptedAtIso: string;
  addressReference: string;
  statements: Record<string, boolean>;
  homeId: number;
  acceptanceId: string;
};

export function buildHomeownerPolicyAcceptedEmail(params: BuildHomeownerPolicyAcceptedEmailParams) {
  const {
    appUrl,
    policyVersion,
    homeownerUsername,
    signatureName,
    acceptedAtIso,
    addressReference,
    statements,
    homeId,
    acceptanceId,
  } = params;
  const normalizedAppUrl = appUrl.replace(/\/$/, '');
  const logoUrl = `${normalizedAppUrl}/brand/logo-lockup.png`;
  const formattedAcceptedAt = new Date(acceptedAtIso).toUTCString();
  const statementsHtml = Object.entries(statements)
    .map(([key, value]) => {
      const label = key.replace(/_/g, ' ');
      return `<li style=\"margin-bottom:4px;\">${label}: <strong>${value ? 'accepted' : 'not accepted'}</strong></li>`;
    })
    .join('');

  const subject = `Congratulations on your Smart Property — Terms accepted (${policyVersion})`;
  const html = `
    <div style=\"font-family: Arial, sans-serif; max-width: 640px; color: #0f172a;\">
      <p style=\"margin: 0 0 16px 0;\">
        <img src=\"${logoUrl}\" alt=\"Dinodia Smart Living\" style=\"max-width: 220px; height: auto;\" />
      </p>
      <h2 style=\"margin: 0 0 12px 0; color:#0f172a;\">Congratulations on your Smart Property</h2>
      <p style=\"margin: 0 0 12px 0;\">This confirms the homeowner terms and conditions have been accepted.</p>
      <div style=\"margin: 14px 0; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; background:#f8fafc;\">
        <p style=\"margin: 0 0 8px 0;\"><strong>Signed Copy</strong></p>
        <p style=\"margin: 0 0 6px 0;\">Policy version: <strong>${policyVersion}</strong></p>
        <p style=\"margin: 0 0 6px 0;\">Homeowner username: <strong>${homeownerUsername}</strong></p>
        <p style=\"margin: 0 0 6px 0;\">Typed full name: <strong>${signatureName}</strong></p>
        <p style=\"margin: 0 0 6px 0;\">Accepted at: <strong>${formattedAcceptedAt}</strong></p>
        <p style=\"margin: 0 0 6px 0;\">Address: <strong>${addressReference}</strong></p>
        <ul style=\"margin: 8px 0 0 18px; padding:0;\">${statementsHtml}</ul>
      </div>
      <p style=\"margin: 0 0 6px 0;\">Home ID: <strong>${homeId}</strong></p>
      <p style=\"margin: 0 0 12px 0;\">Audit reference: <strong>${acceptanceId}</strong></p>
      <p style=\"margin: 0 0 12px 0; color:#475569;\">If policy versions change in future, re-acceptance will be required.</p>
      <p style=\"margin: 0 0 12px 0; color:#475569;\">You can return to <a href=\"${normalizedAppUrl}\">${normalizedAppUrl}</a> any time.</p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    'Congratulations on your Smart Property',
    '',
    'This confirms the homeowner terms and conditions have been accepted.',
    '',
    `Policy version: ${policyVersion}`,
    `Homeowner username: ${homeownerUsername}`,
    `Typed full name: ${signatureName}`,
    `Accepted at: ${formattedAcceptedAt}`,
    `Address: ${addressReference}`,
    ...Object.entries(statements).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value ? 'accepted' : 'not accepted'}`),
    '',
    `Home ID: ${homeId}`,
    `Audit reference: ${acceptanceId}`,
    'If policy versions change in future, re-acceptance will be required.',
    `Return to ${normalizedAppUrl} any time.`,
  ].join('\\n');

  return { subject, html, text };
}

export type BuildClaimCodeEmailParams = {
  claimCode: string;
  appUrl: string;
  username?: string;
};

export function buildClaimCodeEmail(params: BuildClaimCodeEmailParams) {
  const { claimCode, appUrl, username } = params;
  const greeting = username ? `Hi ${username},` : 'Hi,';
  const claimUrl = `${appUrl.replace(/\/$/, '')}/claim`;

  const subject = 'Your Dinodia home claim code';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; color: #0f172a;">
      <h2 style="color: #0f172a; margin-bottom: 12px;">Dinodia Smart Living</h2>
      <p style="margin: 0 0 12px 0;">${greeting}</p>
      <p style="margin: 0 0 12px 0;">
        Here is the claim code for your home. Forward this email to the next homeowner.
      </p>
      <p style="margin: 0 0 16px 0; font-size: 18px;">
        Claim code: <strong style="letter-spacing: 0.08em;">${claimCode}</strong>
      </p>
      <p style="margin: 0 0 12px 0;">
        The next homeowner can start at <a href="${claimUrl}">${claimUrl}</a>.
      </p>
      <p style="margin: 0 0 12px 0; color: #475569;">
        This code can only be used once.
      </p>
    </div>
  `;

  const text = [
    'Dinodia Smart Living',
    greeting,
    '',
    'Here is the claim code for your home. Forward this email to the next homeowner.',
    `Claim code: ${claimCode}`,
    '',
    `The next homeowner can start at ${claimUrl}.`,
    'This code can only be used once.',
  ].join('\n');

  return { subject, html, text };
}
