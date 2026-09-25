import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const CANONICAL_ORIGIN = 'https://dinodia-platform-v2.vercel.app';

export class CxoInvitationDeliveryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super('Initial employee invitation delivery failed');
    this.code = code;
  }
}

function required(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new CxoInvitationDeliveryError(`missing_${name.toLowerCase()}`);
  return value;
}

export function configuredInitialCxoMailbox(): string {
  const value = required('COMPANY_PORTAL_INITIAL_CXO_EMAIL').toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(value) || value.length > 320) throw new CxoInvitationDeliveryError('invalid_recipient_configuration');
  return value;
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function assertLoopbackTestEndpoint(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new CxoInvitationDeliveryError('invalid_test_mail_endpoint'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new CxoInvitationDeliveryError('invalid_test_mail_endpoint');
  }
}

/**
 * Sends the invitation through SES only. The token is placed in a URL
 * fragment, so it is not sent in the subsequent HTTP request or server logs.
 * This function intentionally returns no provider response or message ID.
 */
export async function sendInitialCxoInvitation(input: { displayName: string; invitation: string; expiresAt: Date }): Promise<void> {
  const region = required('AWS_REGION');
  const source = required('SES_FROM_EMAIL');
  const testEndpoint = String(process.env.SES_TEST_ENDPOINT ?? '').trim();
  // A local SES endpoint is permitted only for the disposable integration
  // harness. Production must always use the AWS SDK's normal regional
  // endpoint and credentials chain.
  if (testEndpoint && String(process.env.V2_ENVIRONMENT ?? '') !== 'test') throw new CxoInvitationDeliveryError('invalid_test_mail_endpoint');
  if (testEndpoint) assertLoopbackTestEndpoint(testEndpoint);
  if (!/^\S+@\S+\.\S+$/.test(source) || source.length > 320) throw new CxoInvitationDeliveryError('invalid_sender_configuration');
  const recipient = configuredInitialCxoMailbox();
  const inviteUrl = `${CANONICAL_ORIGIN}/company/bootstrap#invitation=${encodeURIComponent(input.invitation)}`;
  const expires = input.expiresAt.toISOString();
  const client = new SESv2Client({ region, ...(testEndpoint ? { endpoint: testEndpoint } : {}) });
  try {
    await client.send(new SendEmailCommand({
      FromEmailAddress: source,
      Destination: { ToAddresses: [recipient] },
      Content: {
        Simple: {
          Subject: { Data: 'Dinodia Smart Living Company Portal invitation', Charset: 'UTF-8' },
          Body: {
            Text: { Data: `Hello ${input.displayName},\n\nComplete your Dinodia Smart Living Company Portal invitation here:\n${inviteUrl}\n\nThis one-use invitation expires at ${expires}. If you did not request it, ignore this message.`, Charset: 'UTF-8' },
            Html: { Data: `<p>Hello ${html(input.displayName)},</p><p>Complete your Dinodia Smart Living Company Portal invitation:</p><p><a href="${html(inviteUrl)}">Open the invitation</a></p><p>This one-use invitation expires at ${html(expires)}. If you did not request it, ignore this message.</p>`, Charset: 'UTF-8' },
          },
        },
      },
    }));
  } catch {
    throw new CxoInvitationDeliveryError('provider_send_failed');
  }
}
