import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const ORIGIN = 'https://dinodia-platform-v2.vercel.app';

export class CustomerInvitationEmailError extends Error {
  constructor() { super('Customer invitation email could not be submitted'); }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
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

  const link = `${ORIGIN}/app/auth#invitation=${encodeURIComponent(input.invitationId)}`;
  const roleText = input.role === 'TENANT' ? 'tenant' : 'property manager';
  const credentialText = input.temporaryPassword
    ? `\n\nOne-time temporary password: ${input.temporaryPassword}\n\nOpen the invitation link, enter this one-time password and your invited email, then verify the email link. Sign in with the one-time password, replace it, choose your own username, and only then accept the invitation.`
    : '\n\nIf you already have a Dinodia account, keep using your existing sign-in details. Otherwise, register and verify this email address before accepting.';
  const expires = input.expiresAt.toISOString();
  const client = new SESv2Client({ region, ...(testEndpoint ? { endpoint: testEndpoint } : {}) });
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [input.email] },
      Content: { Simple: {
        Subject: { Data: 'Dinodia Smart Living Home invitation', Charset: 'UTF-8' },
        Body: {
          Text: { Data: `You have been invited as a ${roleText} for the property with postcode ${input.postcode}.\n\nReview the invitation securely: ${link}${credentialText}\n\nThe invitation expires at ${expires}. Sending this message does not grant Home access.`, Charset: 'UTF-8' },
          Html: { Data: `<p>You have been invited as a ${escapeHtml(roleText)} for the property with postcode ${escapeHtml(input.postcode)}.</p><p><a href="${escapeHtml(link)}">Review invitation</a></p>${input.temporaryPassword ? `<p>One-time temporary password: <strong>${escapeHtml(input.temporaryPassword)}</strong></p><p>Open the invitation link, enter this password and your invited email, verify the email link, then sign in with the one-time password. Replace it, choose your own username, and explicitly accept the invitation.</p>` : '<p>Existing accounts keep their current credentials. New property managers register and verify this email using credentials they choose.</p>'}<p>The invitation expires at ${escapeHtml(expires)}. Sending this message does not grant Home access.</p>`, Charset: 'UTF-8' },
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
