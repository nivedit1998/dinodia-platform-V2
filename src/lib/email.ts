// Architecture: Shared platform helper src/lib/email.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { hashForLog, safeLog } from '@/lib/safeLogger';

export type SendEmailInput = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
};

type SesConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fromEmail: string;
};

type SesMode =
  | { mode: 'send'; config: SesConfig }
  | { mode: 'log-only' };

let sesClient: SESClient | null = null;

function resolveSesConfig(): SesMode {
  const isProd = process.env.NODE_ENV === 'production';
  const region = process.env.AWS_SES_REGION || process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const fromEmail = process.env.SES_FROM_EMAIL;

  if (!isProd && !fromEmail) {
    return { mode: 'log-only' };
  }

  const missing = [];
  if (!region) missing.push('AWS_SES_REGION or AWS_REGION');
  if (!accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
  if (!fromEmail) missing.push('SES_FROM_EMAIL');

  if (missing.length > 0) {
    throw new Error(`Missing SES env vars: ${missing.join(', ')}`);
  }

  return {
    mode: 'send',
    config: {
      region: region!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      fromEmail: fromEmail!,
    },
  };
}

function getSesClient(config: SesConfig) {
  if (!sesClient) {
    sesClient = new SESClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  return sesClient;
}

function emailDomain(value: string | undefined): string | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return null;
  return raw.slice(at + 1);
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const { to, subject, html, text, replyTo } = input;

  if (!html && !text) {
    throw new Error('sendEmail requires at least one of html or text to be provided');
  }

  const sesMode = resolveSesConfig();

  if (sesMode.mode === 'log-only') {
    safeLog('info', '[email:log-only] SES_FROM_EMAIL missing; email not sent', {
      toHash: hashForLog(to.toLowerCase()),
      toDomain: emailDomain(to),
      replyToDomain: emailDomain(replyTo),
      subjectHash: hashForLog(subject),
      subjectLength: subject.length,
      hasHtml: Boolean(html),
      hasText: Boolean(text),
    });
    return;
  }

  const config = sesMode.config;
  const client = getSesClient(config);

  const body: {
    Html?: { Data: string; Charset: string };
    Text?: { Data: string; Charset: string };
  } = {};

  if (html) body.Html = { Data: html, Charset: 'UTF-8' };
  if (text) body.Text = { Data: text, Charset: 'UTF-8' };

  await client.send(
    new SendEmailCommand({
      Source: config.fromEmail,
      Destination: { ToAddresses: [to] },
      ReplyToAddresses: replyTo ? [replyTo] : undefined,
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: body,
      },
    })
  );
}
