import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const CANONICAL_ORIGIN = 'https://dinodia-platform-v2.vercel.app';

export type CustomerAuthEmailPurpose = 'verify' | 'reset' | 'change';

export class CustomerAuthEmailError extends Error {
  readonly code: string;
  constructor(code: string) {
    super('Customer authentication email delivery failed');
    this.code = code;
  }
}

function required(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new CustomerAuthEmailError(`missing_${name.toLowerCase()}`);
  return value;
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function assertLoopbackTestEndpoint(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new CustomerAuthEmailError('invalid_test_mail_endpoint'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new CustomerAuthEmailError('invalid_test_mail_endpoint');
  }
}

/**
 * Sends a one-use customer verification or password-reset link through the
 * existing SES authority. The bearer stays in a URL fragment (not an HTTP
 * request, referrer or server access log). A successful SES response means
 * provider-accepted, never inbox-delivered or user-verified.
 */
export async function sendCustomerAuthEmail(input: {
  email: string;
  purpose: CustomerAuthEmailPurpose;
  token: string;
  challengeId: string;
  expiresAt: Date;
}): Promise<'ACCEPTED'> {
  const region = required('AWS_REGION');
  const source = required('SES_FROM_EMAIL');
  const testEndpoint = String(process.env.SES_TEST_ENDPOINT ?? '').trim();
  if (testEndpoint && String(process.env.V2_ENVIRONMENT ?? '') !== 'test') throw new CustomerAuthEmailError('invalid_test_mail_endpoint');
  if (testEndpoint) assertLoopbackTestEndpoint(testEndpoint);
  if (!/^\S+@\S+\.\S+$/.test(source) || source.length > 320) throw new CustomerAuthEmailError('invalid_sender_configuration');
  if (!/^\S+@\S+\.\S+$/.test(input.email) || input.email.length > 320
    || !/^[A-Za-z0-9_-]{40,64}$/.test(input.token)
    || !/^[0-9a-f-]{36}$/i.test(input.challengeId)
    || !Number.isFinite(input.expiresAt.getTime())) throw new CustomerAuthEmailError('invalid_message');

  const verification = input.purpose === 'verify';
  const emailChange = input.purpose === 'change';
  const action = verification ? 'verify-email' : emailChange ? 'change-email' : 'reset-password';
  const title = verification ? 'Verify your Dinodia Smart Living email' : emailChange ? 'Confirm your new Dinodia Smart Living email' : 'Reset your Dinodia Smart Living password';
  const explanation = verification
    ? 'Confirm this email address to finish setting up your Dinodia account.'
    : emailChange ? 'Confirm this new email address to update your Dinodia account. Your current address remains active until confirmation.'
      : 'Choose a new password to restore access to your Dinodia account.';
  // /app/* is the V2-only Associated Domains namespace. iOS handles the
  // fragment in-app (without sending the bearer to a request/referrer); the
  // canonical web route remains the safe fallback when the app is absent.
  const link = `${CANONICAL_ORIGIN}/app/auth#${action}=${encodeURIComponent(input.token)}&challenge=${encodeURIComponent(input.challengeId)}`;
  const expires = input.expiresAt.toISOString();
  const client = new SESv2Client({ region, ...(testEndpoint ? { endpoint: testEndpoint } : {}) });
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [input.email] },
      Content: { Simple: {
        Subject: { Data: title, Charset: 'UTF-8' },
        Body: {
          Text: { Data: `${explanation}\n\nContinue securely: ${link}\n\nThis one-use link expires at ${expires}. If you did not request it, ignore this message.`, Charset: 'UTF-8' },
          Html: { Data: `<p>${html(explanation)}</p><p><a href="${html(link)}">${verification ? 'Verify email address' : emailChange ? 'Confirm new email address' : 'Choose a new password'}</a></p><p>This one-use link expires at ${html(expires)}. If you did not request it, ignore this message.</p>`, Charset: 'UTF-8' },
        },
      } },
    }));
    if (!result.MessageId) throw new CustomerAuthEmailError('provider_not_accepted');
    return 'ACCEPTED';
  } catch (error) {
    if (error instanceof CustomerAuthEmailError) throw error;
    throw new CustomerAuthEmailError('provider_send_failed');
  } finally {
    client.destroy();
  }
}

/**
 * Public Get Help proves control of the reply address before a standalone
 * support ticket is created. The one-time code is deliberately not an account
 * credential and the message contains no household/account-existence signal.
 */
export async function sendPublicSupportVerificationCode(input: { email: string; code: string; expiresAt: Date }): Promise<'ACCEPTED'> {
  const region = required('AWS_REGION');
  const source = required('SES_FROM_EMAIL');
  const testEndpoint = String(process.env.SES_TEST_ENDPOINT ?? '').trim();
  if (testEndpoint && String(process.env.V2_ENVIRONMENT ?? '') !== 'test') throw new CustomerAuthEmailError('invalid_test_mail_endpoint');
  if (testEndpoint) assertLoopbackTestEndpoint(testEndpoint);
  if (!/^\S+@\S+\.\S+$/.test(source) || source.length > 320
    || !/^\S+@\S+\.\S+$/.test(input.email) || input.email.length > 320
    || !/^\d{6}$/.test(input.code) || !Number.isFinite(input.expiresAt.getTime())) {
    throw new CustomerAuthEmailError('invalid_message');
  }
  const client = new SESv2Client({ region, ...(testEndpoint ? { endpoint: testEndpoint } : {}) });
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [input.email] },
      Content: { Simple: {
        Subject: { Data: 'Verify your Dinodia Smart Living support request', Charset: 'UTF-8' },
        Body: {
          Text: { Data: `Your one-time support verification code is ${input.code}. It expires at ${input.expiresAt.toISOString()}. If you did not request this, ignore this message.`, Charset: 'UTF-8' },
          Html: { Data: `<p>Enter this one-time code to submit your Dinodia Smart Living support request:</p><p><strong>${input.code}</strong></p><p>It expires at ${input.expiresAt.toISOString()}. If you did not request this, ignore this message.</p>`, Charset: 'UTF-8' },
        },
      } },
    }));
    if (!result.MessageId) throw new CustomerAuthEmailError('provider_not_accepted');
    return 'ACCEPTED';
  } catch (error) {
    if (error instanceof CustomerAuthEmailError) throw error;
    throw new CustomerAuthEmailError('provider_send_failed');
  } finally {
    client.destroy();
  }
}
