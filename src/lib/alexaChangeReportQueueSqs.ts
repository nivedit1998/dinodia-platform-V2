// Architecture: Shared platform helper src/lib/alexaChangeReportQueueSqs.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AlexaProperty } from '@/lib/alexaProperties';

type EnqueueArgs = {
  haConnectionId: number;
  entityId: string;
  label: string;
  causeType: string;
  previousProperties: AlexaProperty[];
  delayMs: number;
};

function getQueueUrl() {
  const url = process.env.ALEXA_CHANGE_REPORT_QUEUE_URL;
  if (!url) {
    throw new Error('ALEXA_CHANGE_REPORT_QUEUE_URL is not configured');
  }
  return url;
}

function getSqsClient() {
  const region = process.env.AWS_SQS_REGION || process.env.AWS_REGION;
  if (!region) {
    throw new Error('AWS_SQS_REGION or AWS_REGION is not configured');
  }
  return new SQSClient({ region });
}

export async function enqueueAlexaChangeReportJobSqs(args: EnqueueArgs) {
  const queueUrl = getQueueUrl();
  const sqs = getSqsClient();

  const scheduledAtEpochMs = Date.now() + Math.max(0, Math.floor(args.delayMs));
  const delaySeconds = Math.min(900, Math.max(0, Math.floor(args.delayMs / 1000)));

  const payload = {
    scheduledAtEpochMs,
    haConnectionId: args.haConnectionId,
    entityId: args.entityId,
    label: args.label,
    causeType: args.causeType,
    previousProperties: args.previousProperties,
  };

  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    DelaySeconds: delaySeconds,
    MessageBody: JSON.stringify(payload),
  });

  await sqs.send(command);
}
