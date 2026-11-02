import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const ORIGIN = 'https://dinodia-platform-v2.vercel.app';

export class CustomerInvitationEmailError extends Error {
  constructor() { super('Customer invitation email could not be submitted'); }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function customerInvitationEmailContent(input: {
  invitationId: string; role: 'PROPERTY_MANAGER' | 'TENANT'; postcode: string; expiresAt: Date;
  temporaryPassword: string | null; inviterName?: string;
}): { subject: string; text: string; html: string } {
  const link = `${ORIGIN}/app/auth#invitation=${encodeURIComponent(input.invitationId)}`;
  const inviter = input.inviterName?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Someone in this Home';
  const roleText = input.role === 'TENANT' ? 'tenant' : 'property manager';
  const expires = input.expiresAt.toISOString();
  const intro = `${inviter} has invited you to join their Dinodia Smart Living Home as a ${roleText}.`;
  const steps = input.temporaryPassword
    ? 'Open the invitation and sign in using the email address this message was sent to and the one-time password below.'
    : 'Open the invitation, sign in with your current Dinodia account or create one using this email address, then choose this Home from your invitations and accept.';
  const passwordInstructions = 'After first sign-in, Dinodia will guide you to choose a new password and username, review the current policy, then choose this Home and accept the invitation.';
  const credentials = input.temporaryPassword
    ? `One-time temporary password: ${input.temporaryPassword}\n\n${passwordInstructions}`
    : 'If you already use Dinodia, sign in with your current details. Otherwise, create an account and verify this email address before accepting.';
  const subject = `${inviter} invited you to Dinodia Smart Living`.slice(0, 120);
  const text = `Hello,\n\n${intro}\n\nHome postcode: ${input.postcode}\n\n${steps}\n\n${credentials}\n\nReview invitation: ${link}\n\nThis invitation expires ${expires}. Opening this email or signing in does not grant Home access. If you were not expecting it, you can ignore this message.`;
  const passwordHtml = input.temporaryPassword
    ? `<p style="margin:20px 0 0;font-size:14px">One-time temporary password:<br><strong style="display:inline-block;margin-top:8px;padding:10px 14px;border-radius:10px;background:#f2f4f7;font-family:ui-monospace,Menlo,monospace">${escapeHtml(input.temporaryPassword)}</strong></p><p style="margin:14px 0 0;font-size:14px;line-height:1.55;color:#636366">${escapeHtml(passwordInstructions)}</p>`
    : `<p style="margin:18px 0 0;font-size:14px;line-height:1.55;color:#636366">${escapeHtml(credentials)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1c1e"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #d8e5f5;border-radius:24px;overflow:hidden"><tr><td style="padding:28px 30px 8px;color:#1687e8;font-size:13px;font-weight:700;letter-spacing:.08em">DINODIA SMART LIVING</td></tr><tr><td style="padding:8px 30px 0"><h1 style="font-size:26px;line-height:1.25;margin:0">You’re invited to a Home</h1></td></tr><tr><td style="padding:18px 30px 0;font-size:16px;line-height:1.55">${escapeHtml(intro)}</td></tr><tr><td style="padding:10px 30px 0;font-size:14px;line-height:1.5;color:#636366">Home postcode: <strong>${escapeHtml(input.postcode)}</strong></td></tr><tr><td style="padding:22px 30px 0;font-size:15px;line-height:1.55">${escapeHtml(steps)}</td></tr><tr><td>${passwordHtml}</td></tr><tr><td align="center" style="padding:26px 30px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 24px;border-radius:14px;background:#1687e8;color:#fff;text-decoration:none;font-weight:700">Choose this Home</a></td></tr><tr><td style="padding:0 30px 24px;font-size:13px;line-height:1.5;color:#636366">Invitation expires ${escapeHtml(expires)}. Nothing is shared until you accept. If you weren’t expecting this invitation, you can ignore this email.</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

function assertLoopbackEndpoint(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new CustomerInvitationEmailError(); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new CustomerInvitationEmailError();
}

/** Provider acceptance is not represented as inbox delivery or user acceptance. */
export async function sendCustomerInvitationEmail(input: {
  email: string;
  invitationId: string;
  role: 'PROPERTY_MANAGER' | 'TENANT';
  postcode: string;
  expiresAt: Date;
  temporaryPassword: string | null;
  inviterName?: string;
}): Promise<'ACCEPTED'> {
  const region = String(process.env.AWS_REGION ?? '').trim();
  const source = String(process.env.SES_FROM_EMAIL ?? '').trim();
  const testEndpoint = String(process.env.SES_TEST_ENDPOINT ?? '').trim();
  if (!region || !/^\S+@\S+\.\S+$/.test(source) || source.length > 320
    || !/^\S+@\S+\.\S+$/.test(input.email) || input.email.length > 320
    || !/^[0-9a-f-]{36}$/i.test(input.invitationId) || !/^.{1,32}$/.test(input.postcode)
    || !Number.isFinite(input.expiresAt.getTime())
    || (input.temporaryPassword !== null && (input.role !== 'TENANT' || input.temporaryPassword.length < 12))) {
    throw new CustomerInvitationEmailError();
  }
  if (testEndpoint && String(process.env.V2_ENVIRONMENT ?? '') !== 'test') throw new CustomerInvitationEmailError();
  if (testEndpoint) assertLoopbackEndpoint(testEndpoint);

  const content = customerInvitationEmailContent(input);
  const client = new SESv2Client({ region, ...(testEndpoint ? { endpoint: testEndpoint } : {}) });
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [input.email] },
      Content: { Simple: {
        Subject: { Data: content.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: content.text, Charset: 'UTF-8' },
          Html: { Data: content.html, Charset: 'UTF-8' },
        },
      } },
    }));
    if (!result.MessageId) throw new CustomerInvitationEmailError();
    return 'ACCEPTED';
  } catch {
    throw new CustomerInvitationEmailError();
  } finally {
    client.destroy();
  }
}
