// Architecture: Shared platform helper src/lib/homeownerPolicyNotifications.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import {
  AuditEventType,
  HomeownerPolicyNotificationDelivery,
  HomeownerPolicyNotificationDeliveryStatus,
  HomeownerPolicyNotificationRecipientType,
  Role,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { buildHomeownerPolicyAcceptedEmail } from '@/lib/emailTemplates';
import { sendEmail } from '@/lib/email';
import { getAppUrl } from '@/lib/authChallenges';

const DEFAULT_REPLY_TO = 'niveditgupta@dinodiasmartliving.com';

type NotificationResult = {
  recipientType: HomeownerPolicyNotificationRecipientType;
  recipientEmail: string;
  status: HomeownerPolicyNotificationDeliveryStatus;
  error?: string;
};

export async function resolveInstallerNotificationEmail() {
  const override = process.env.HOMEOWNER_POLICY_INSTALLER_EMAIL?.trim();
  if (override) return override;

  const installerEnv = process.env.INSTALLER_EMAIL?.trim();
  if (installerEnv) return installerEnv;

  const installer = await prisma.user.findFirst({
    where: { role: Role.INSTALLER, email: { not: null } },
    select: { email: true },
    orderBy: { id: 'asc' },
  });
  return installer?.email?.trim() || null;
}

async function upsertDeliveryRow(args: {
  acceptanceId: string;
  homeId: number;
  recipientType: HomeownerPolicyNotificationRecipientType;
  recipientEmail: string;
}) {
  return prisma.homeownerPolicyNotificationDelivery.upsert({
    where: {
      acceptanceId_recipientType: {
        acceptanceId: args.acceptanceId,
        recipientType: args.recipientType,
      },
    },
    create: {
      acceptanceId: args.acceptanceId,
      homeId: args.homeId,
      recipientType: args.recipientType,
      recipientEmail: args.recipientEmail,
      status: HomeownerPolicyNotificationDeliveryStatus.PENDING,
    },
    update: {
      recipientEmail: args.recipientEmail,
      homeId: args.homeId,
    },
  });
}

function normalizeStatements(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const entries = Object.entries(input as Record<string, unknown>);
  const out: Record<string, boolean> = {};
  for (const [key, value] of entries) {
    out[key] = Boolean(value);
  }
  return out;
}

async function attemptDelivery(params: {
  delivery: HomeownerPolicyNotificationDelivery;
  homeownerUsername: string;
  signatureName: string;
  acceptedAtIso: string;
  policyVersion: string;
  addressReference: string;
  statements: Record<string, boolean>;
  homeId: number;
  acceptanceId: string;
  force: boolean;
}): Promise<NotificationResult> {
  const { delivery } = params;

  if (delivery.status === HomeownerPolicyNotificationDeliveryStatus.SENT && !params.force) {
    return {
      recipientType: delivery.recipientType,
      recipientEmail: delivery.recipientEmail,
      status: HomeownerPolicyNotificationDeliveryStatus.SENT,
    };
  }

  const content = buildHomeownerPolicyAcceptedEmail({
    appUrl: getAppUrl(),
    policyVersion: params.policyVersion,
    homeownerUsername: params.homeownerUsername,
    signatureName: params.signatureName,
    acceptedAtIso: params.acceptedAtIso,
    addressReference: params.addressReference,
    statements: params.statements,
    homeId: params.homeId,
    acceptanceId: params.acceptanceId,
  });

  try {
    await sendEmail({
      to: delivery.recipientEmail,
      subject: content.subject,
      html: content.html,
      text: content.text,
      replyTo: DEFAULT_REPLY_TO,
    });

    const updated = await prisma.homeownerPolicyNotificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: HomeownerPolicyNotificationDeliveryStatus.SENT,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        sentAt: new Date(),
        lastError: null,
      },
    });

    return {
      recipientType: updated.recipientType,
      recipientEmail: updated.recipientEmail,
      status: updated.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send homeowner policy email.';
    const updated = await prisma.homeownerPolicyNotificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: HomeownerPolicyNotificationDeliveryStatus.FAILED,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        lastError: message,
      },
    });

    return {
      recipientType: updated.recipientType,
      recipientEmail: updated.recipientEmail,
      status: updated.status,
      error: message,
    };
  }
}

export async function sendHomeownerPolicyAcceptedEmails(args: {
  acceptanceId: string;
  homeId: number;
  homeownerUserId: number;
  policyVersion: string;
}) {
  const acceptance = await prisma.homeownerPolicyAcceptance.findUnique({
    where: { id: args.acceptanceId },
    include: {
      homeownerUser: {
        select: { id: true, username: true, email: true },
      },
      notifications: true,
    },
  });

  if (!acceptance) {
    throw new Error('Homeowner policy acceptance was not found.');
  }

  if (acceptance.homeownerUserId !== args.homeownerUserId) {
    throw new Error('Acceptance user mismatch.');
  }

  const recipients: Array<{
    recipientType: HomeownerPolicyNotificationRecipientType;
    recipientEmail: string;
  }> = [];

  const homeownerEmail = acceptance.homeownerUser.email?.trim();
  if (homeownerEmail) {
    recipients.push({
      recipientType: HomeownerPolicyNotificationRecipientType.HOMEOWNER,
      recipientEmail: homeownerEmail,
    });
  }

  const installerEmail = await resolveInstallerNotificationEmail();
  if (installerEmail) {
    recipients.push({
      recipientType: HomeownerPolicyNotificationRecipientType.INSTALLER,
      recipientEmail: installerEmail,
    });
  }

  const statements = normalizeStatements(acceptance.acceptedStatements);

  const results: NotificationResult[] = [];
  for (const recipient of recipients) {
    const row = await upsertDeliveryRow({
      acceptanceId: acceptance.id,
      homeId: acceptance.homeId,
      recipientType: recipient.recipientType,
      recipientEmail: recipient.recipientEmail,
    });

    const result = await attemptDelivery({
      delivery: row,
      homeownerUsername: acceptance.homeownerUser.username,
      signatureName: acceptance.signatureName,
      acceptedAtIso: acceptance.acceptedAt.toISOString(),
      policyVersion: acceptance.policyVersion,
      addressReference: acceptance.addressReference,
      statements,
      homeId: acceptance.homeId,
      acceptanceId: acceptance.id,
      force: false,
    });
    results.push(result);
  }

  return {
    results,
    allSent: results.length > 0 && results.every((result) => result.status === HomeownerPolicyNotificationDeliveryStatus.SENT),
  };
}

export async function getPolicyNotificationDeliveryStatus(homeId: number) {
  const acceptance = await prisma.homeownerPolicyAcceptance.findFirst({
    where: { homeId },
    orderBy: { acceptedAt: 'desc' },
    include: {
      notifications: true,
      homeownerUser: { select: { username: true, email: true } },
    },
  });

  if (!acceptance) {
    return null;
  }

  const homeowner = acceptance.notifications.find(
    (item) => item.recipientType === HomeownerPolicyNotificationRecipientType.HOMEOWNER
  );
  const installer = acceptance.notifications.find(
    (item) => item.recipientType === HomeownerPolicyNotificationRecipientType.INSTALLER
  );

  return {
    acceptanceId: acceptance.id,
    policyVersion: acceptance.policyVersion,
    acceptedAt: acceptance.acceptedAt,
    homeownerUsername: acceptance.homeownerUser.username,
    homeownerEmail: homeowner?.recipientEmail ?? acceptance.homeownerUser.email ?? null,
    homeownerStatus: homeowner?.status ?? null,
    installerEmail: installer?.recipientEmail ?? null,
    installerStatus: installer?.status ?? null,
    canResend:
      (homeowner && homeowner.status !== HomeownerPolicyNotificationDeliveryStatus.SENT) ||
      (installer && installer.status !== HomeownerPolicyNotificationDeliveryStatus.SENT) ||
      (!homeowner && Boolean(acceptance.homeownerUser.email)) ||
      !installer,
  };
}

export async function resendPendingPolicyAcceptedEmails(args: {
  homeId: number;
  actorUserId: number;
  reason: string;
}) {
  const acceptance = await prisma.homeownerPolicyAcceptance.findFirst({
    where: { homeId: args.homeId },
    orderBy: { acceptedAt: 'desc' },
    include: {
      homeownerUser: { select: { id: true, username: true, email: true } },
      notifications: true,
    },
  });

  if (!acceptance) {
    throw new Error('No homeowner policy acceptance found for this home.');
  }

  const statements = normalizeStatements(acceptance.acceptedStatements);
  const rowsToResend = acceptance.notifications.filter(
    (row) => row.status !== HomeownerPolicyNotificationDeliveryStatus.SENT
  );

  if (rowsToResend.length === 0) {
    return {
      acceptanceId: acceptance.id,
      results: [] as NotificationResult[],
      allSent: true,
      skipped: true,
    };
  }

  const results: NotificationResult[] = [];
  for (const delivery of rowsToResend) {
    const result = await attemptDelivery({
      delivery,
      homeownerUsername: acceptance.homeownerUser.username,
      signatureName: acceptance.signatureName,
      acceptedAtIso: acceptance.acceptedAt.toISOString(),
      policyVersion: acceptance.policyVersion,
      addressReference: acceptance.addressReference,
      statements,
      homeId: acceptance.homeId,
      acceptanceId: acceptance.id,
      force: true,
    });
    results.push(result);
  }

  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.HOMEOWNER_POLICY_EMAIL_RESEND_REQUESTED,
      homeId: acceptance.homeId,
      actorUserId: args.actorUserId,
      metadata: {
        acceptanceId: acceptance.id,
        reason: args.reason,
        resentRecipients: results.map((item) => ({
          recipientType: item.recipientType,
          recipientEmail: item.recipientEmail,
          status: item.status,
          error: item.error ?? null,
        })),
      },
    },
  });

  return {
    acceptanceId: acceptance.id,
    results,
    allSent: results.length > 0 && results.every((item) => item.status === HomeownerPolicyNotificationDeliveryStatus.SENT),
    skipped: false,
  };
}
