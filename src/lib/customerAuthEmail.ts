import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const CANONICAL_ORIGIN = 'https://dinodia-platform-v2.vercel.app';

export type CustomerAuthEmailPurpose = 'verify' | 'reset' | 'change' | 'ownership-transfer';

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

function configuredSesClient(): { client: SESv2Client; source: string } {
  const testEndpoint = String(process.env.SES_TEST_ENDPOINT ?? '').trim();
  const testEnvironment = String(process.env.V2_ENVIRONMENT ?? '') === 'test';
  if (testEnvironment && !testEndpoint) throw new CustomerAuthEmailError('test_mail_endpoint_missing');
  if (testEndpoint && !testEnvironment) throw new CustomerAuthEmailError('invalid_test_mail_endpoint');
  if (testEndpoint) assertLoopbackTestEndpoint(testEndpoint);
  // A loopback fake SES endpoint needs only a syntactically valid SigV4
  // region. Keep the fallback confined to the explicitly configured test
  // environment and validated loopback endpoint; Production always requires
  // its explicit AWS_REGION.
  const region = testEndpoint
    ? (String(process.env.AWS_REGION ?? '').trim() || 'us-east-1')
    : required('AWS_REGION');
  const source = required('SES_FROM_EMAIL');
  return { client: new SESv2Client({ region, ...(testEndpoint ? { endpoint: testEndpoint } : {}) }), source };
}

/** "in 24 hours" or "in 10 minutes": a plain-language expiry instead of a timestamp. */
function friendlyExpiry(expiresAt: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60000));
  if (minutes >= 90) return `in ${Math.round(minutes / 60)} hours`;
  return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
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
  const { client, source } = configuredSesClient();
  if (!/^\S+@\S+\.\S+$/.test(source) || source.length > 320) throw new CustomerAuthEmailError('invalid_sender_configuration');
  const tokenValid = input.purpose === 'ownership-transfer'
    ? /^dno_transfer_[0-9a-f-]{36}_[A-Za-z0-9_-]{40,64}$/.test(input.token)
    : /^[A-Za-z0-9_-]{40,64}$/.test(input.token);
  if (!/^\S+@\S+\.\S+$/.test(input.email) || input.email.length > 320
    || !tokenValid
    || !/^[0-9a-f-]{36}$/i.test(input.challengeId)
    || !Number.isFinite(input.expiresAt.getTime())) throw new CustomerAuthEmailError('invalid_message');

  const verification = input.purpose === 'verify';
  const emailChange = input.purpose === 'change';
  const ownershipTransfer = input.purpose === 'ownership-transfer';
  const action = verification ? 'verify-email' : emailChange ? 'change-email' : ownershipTransfer ? 'ownership-transfer' : 'reset-password';
  const title = verification ? 'Confirm your email for Dinodia' : emailChange ? 'Confirm your new Dinodia Smart Living email' : ownershipTransfer ? 'Accept a Dinodia Smart Living home transfer' : 'Reset your Dinodia password';
  const explanation = verification
    ? 'Tap the button to confirm your email, then open the Dinodia app to continue.'
    : emailChange ? 'Confirm this new email address to update your Dinodia account. Your current address remains active until confirmation.'
      : ownershipTransfer ? 'The current homeowner has invited this verified email address to receive the home. Review and accept only if you expected this transfer.'
        : 'Tap the button to choose a new password for your Dinodia account.';
  // /app/* is the V2-only Associated Domains namespace. iOS handles the
  // fragment in-app (without sending the bearer to a request/referrer); the
  // canonical web route remains the safe fallback when the app is absent.
  const link = `${CANONICAL_ORIGIN}/app/auth#${action}=${encodeURIComponent(input.token)}&challenge=${encodeURIComponent(input.challengeId)}`;
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [input.email] },
      Content: { Simple: {
        Subject: { Data: title, Charset: 'UTF-8' },
        Body: {
          Text: { Data: `${explanation}\n\nContinue securely: ${link}\n\n${ownershipTransfer ? 'The transfer does not expire automatically, but this link is disabled if the homeowner cancels or completes the transfer.' : `This link works once and expires ${friendlyExpiry(input.expiresAt)}.`} If you did not request it, ignore this message.`, Charset: 'UTF-8' },
          Html: { Data: `<p>${html(explanation)}</p><p><a href="${html(link)}">${verification ? 'Verify email address' : emailChange ? 'Confirm new email address' : ownershipTransfer ? 'Review home transfer' : 'Choose a new password'}</a></p><p>${ownershipTransfer ? 'The transfer does not expire automatically, but this link is disabled if the homeowner cancels or completes the transfer.' : `This one-use link expires ${html(friendlyExpiry(input.expiresAt))}.`} If you did not request this, ignore this message.</p>`, Charset: 'UTF-8' },
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
  const { client, source } = configuredSesClient();
  if (!/^\S+@\S+\.\S+$/.test(source) || source.length > 320
    || !/^\S+@\S+\.\S+$/.test(input.email) || input.email.length > 320
    || !/^\d{6}$/.test(input.code) || !Number.isFinite(input.expiresAt.getTime())) {
    throw new CustomerAuthEmailError('invalid_message');
  }
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

/** Public Room QR email proof remains an onboarding attempt, not an account or access grant. */
export async function sendRoomAccessVerificationCode(input: { email: string; code: string; expiresAt: Date }): Promise<'ACCEPTED'> {
  const { client, source } = configuredSesClient();
  if (!/^\S+@\S+\.\S+$/.test(source) || source.length > 320
    || !/^\S+@\S+\.\S+$/.test(input.email) || input.email.length > 320
    || !/^\d{6}$/.test(input.code) || !Number.isFinite(input.expiresAt.getTime())) {
    throw new CustomerAuthEmailError('invalid_message');
  }
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [input.email] },
      Content: { Simple: {
        Subject: { Data: 'Verify your Dinodia Room access request', Charset: 'UTF-8' },
        Body: {
          Text: { Data: `Your one-time Room QR email verification code is ${input.code}. It expires at ${input.expiresAt.toISOString()}. If you did not scan a Room QR, ignore this email. Verifying your email does not grant access.`, Charset: 'UTF-8' },
          Html: { Data: `<p>Enter this one-time code to verify the email for your Dinodia Room access request:</p><p><strong>${input.code}</strong></p><p>It expires at ${input.expiresAt.toISOString()}. Verifying your email does not grant access. If you did not scan a Room QR, ignore this email.</p>`, Charset: 'UTF-8' },
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
