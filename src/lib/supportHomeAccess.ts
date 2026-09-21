// Architecture: platform-owned support approval/session state. The installer and
// support UI create/revoke approvals here; the HA support gateway calls the
// internal session routes, and its Durable Object proxies the approved HA session.
// Keep this boundary separate from normal tenant auth and never expose HA tokens.

import 'server-only';

import crypto from 'crypto';
import {
  AuditEventType,
  HomeContactType,
  Prisma,
  PrismaClient,
  Role,
  SupportApprovalRecipientType,
  SupportRequest,
  SupportRequestApprovalToken,
} from '@prisma/client';
import { hashSecretForLookup, resolveHaUiCredentials } from '@/lib/haSecrets';
import { getAppUrl } from '@/lib/authChallenges';
import { sendEmail } from '@/lib/email';
import {
  buildSupportApprovalSuccessCopy,
  buildSupportHomeownerAccessStartedEmail,
  buildSupportTenantAccessStartedEmail,
} from '@/lib/supportHomeAccessEmails';
import { buildSupportAuditMetadata } from '@/lib/supportHomeAccessAudit';
import { escapeHtml } from '@/lib/htmlEscape';

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export const HOME_SUPPORT_APPROVAL_WINDOW_MINUTES = 30;
export const HOME_SUPPORT_CODE_WINDOW_MINUTES = 10;
export const HOME_SUPPORT_LAUNCH_TICKET_WINDOW_MINUTES = 5;
export const HOME_SUPPORT_BOOTSTRAP_TIMEOUT_SECONDS = 15;
export const HOME_SUPPORT_BOOTSTRAP_RESUME_WINDOW_SECONDS = 60;

export const HOME_SUPPORT_FAILURE_CODES = [
  'HA_LOGIN_FLOW_FAILED',
  'HA_BOOTSTRAP_TIMEOUT',
  'HA_BOOTSTRAP_WS_FAILED',
  'HA_BOOTSTRAP_WS_NOT_STARTED',
  'HA_BOOTSTRAP_AUTH_FAILED',
  'HA_BOOTSTRAP_FRONTEND_AUTH_REJECTED',
  'HA_BOOTSTRAP_TOKEN_BRIDGE_FAILED',
  'HA_BOOTSTRAP_HTML_MISSING',
  'HA_BOOTSTRAP_COOKIE_MISSING',
  'HA_LIVE_SESSION_DISCONNECTED',
  'HA_BOOTSTRAP_OTHER',
] as const;

export type HomeSupportFailureCode = (typeof HOME_SUPPORT_FAILURE_CODES)[number];

export type HomeSupportLifecycleStatus =
  | 'NOT_FOUND'
  | 'PENDING'
  | 'APPROVED'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'FAILED'
  | 'REVOKED'
  | 'CONSUMED';

export type HomeSupportGateStatus =
  | 'NOT_FOUND'
  | 'WAITING_FOR_APPROVAL'
  | 'READY_FOR_CODE'
  | 'RESUME_BOOTSTRAP'
  | 'ACTIVE_OTHER_DEVICE'
  | 'FAILED'
  | 'REVOKED'
  | 'EXPIRED';

export type RemoteSupportApprover = {
  recipientType: SupportApprovalRecipientType;
  recipientUserId: number | null;
  recipientEmail: string;
  recipientName: string | null;
};

export function buildSupportApproveUrl(rawToken: string) {
  return `${getAppUrl().replace(/\/$/, '')}/support/approve?token=${encodeURIComponent(rawToken)}`;
}

export function buildSupportGateUrl(input: {
  homeId: number;
  requestId: string;
  hostname: string;
}) {
  const url = new URL('/support/ha-gate', getAppUrl());
  url.searchParams.set('homeId', String(input.homeId));
  url.searchParams.set('requestId', input.requestId);
  url.searchParams.set('host', input.hostname);
  return url.toString();
}

export function buildHomeLabel(input: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postcode?: string | null;
  homeId: number;
}) {
  const bits = [input.addressLine1, input.addressLine2, input.city, input.postcode]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (bits.length > 0) return bits.join(', ');
  return `Home #${input.homeId}`;
}

export function buildSupportFailureMessage() {
  return 'Connection to the Dinodia hub failed. Approval must be requested again.';
}

export function buildSupportFailureTitle() {
  return 'Connection failed';
}

function generateOpaqueToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateNumericCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function sha256(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeHomeSupportFailureCode(value: string | null | undefined): HomeSupportFailureCode {
  switch ((value || '').trim()) {
    case 'HA_LOGIN_FLOW_FAILED':
    case 'HA_BOOTSTRAP_TIMEOUT':
    case 'HA_BOOTSTRAP_WS_FAILED':
    case 'HA_BOOTSTRAP_WS_NOT_STARTED':
    case 'HA_BOOTSTRAP_AUTH_FAILED':
    case 'HA_BOOTSTRAP_FRONTEND_AUTH_REJECTED':
    case 'HA_BOOTSTRAP_TOKEN_BRIDGE_FAILED':
    case 'HA_BOOTSTRAP_HTML_MISSING':
    case 'HA_BOOTSTRAP_COOKIE_MISSING':
    case 'HA_LIVE_SESSION_DISCONNECTED':
    case 'HA_BOOTSTRAP_OTHER':
      return value as HomeSupportFailureCode;
    default:
      return 'HA_BOOTSTRAP_OTHER';
  }
}

function matchesUserAgentHash(expectedHash: string | null | undefined, userAgent: string | null) {
  if (!expectedHash) return true;
  if (!userAgent) return false;
  return expectedHash === sha256(userAgent);
}

function nowPlusMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function computeHomeSupportStatus(
  request:
    | (Pick<
        SupportRequest,
        | 'approvedAt'
        | 'approvalValidUntil'
        | 'revokedAt'
        | 'haSessionRevokedAt'
        | 'haSessionFailureAt'
        | 'haSessionStartedAt'
        | 'haSessionExpiresAt'
        | 'haSessionEndedAt'
        | 'haSecurityCodeConsumedAt'
        | 'haSecurityCodeExpiresAt'
      > &
        Partial<Pick<SupportRequest, 'gatewaySessionHash'>>)
    | null,
  approvalTokens?: Array<Pick<SupportRequestApprovalToken, 'expiresAt' | 'approvedAt' | 'consumedAt'>> | null
): HomeSupportLifecycleStatus {
  if (!request) return 'NOT_FOUND';
  const now = new Date();

  if (request.revokedAt || request.haSessionRevokedAt) return 'REVOKED';
  if (request.haSessionFailureAt) return 'FAILED';

  if (request.haSessionStartedAt) {
    if (request.haSessionEndedAt) return 'EXPIRED';
    if (request.haSessionExpiresAt && request.haSessionExpiresAt.getTime() <= now.getTime()) {
      return 'EXPIRED';
    }
    return 'ACTIVE';
  }

  if (request.approvedAt) {
    if (request.approvalValidUntil && request.approvalValidUntil.getTime() <= now.getTime()) {
      return 'EXPIRED';
    }
    if (request.haSecurityCodeExpiresAt && request.haSecurityCodeExpiresAt.getTime() <= now.getTime()) {
      return 'EXPIRED';
    }
    if (request.haSecurityCodeConsumedAt || request.gatewaySessionHash) {
      return 'CONSUMED';
    }
    return 'APPROVED';
  }

  if (!approvalTokens || approvalTokens.length === 0) return 'NOT_FOUND';

  const pending = approvalTokens.some(
    (token) =>
      !token.approvedAt &&
      !token.consumedAt &&
      token.expiresAt.getTime() > now.getTime()
  );
  return pending ? 'PENDING' : 'EXPIRED';
}

type HomeSupportGateRequest = Pick<
  SupportRequest,
  | 'approvedAt'
  | 'approvalValidUntil'
  | 'revokedAt'
  | 'haSessionRevokedAt'
  | 'haSessionFailureAt'
  | 'haSessionFailureCode'
  | 'haSessionStartedAt'
  | 'haSessionExpiresAt'
  | 'haSessionEndedAt'
  | 'haSecurityCodeHash'
  | 'haSecurityCodeConsumedAt'
  | 'haSecurityCodeExpiresAt'
  | 'gatewaySessionHash'
  | 'gatewaySessionBoundAt'
  | 'gatewaySessionUserAgentHash'
>;

export function isHomeSupportBootstrapResumable(
  request: HomeSupportGateRequest | null,
  userAgent: string | null,
  now = new Date()
) {
  if (!request?.gatewaySessionHash || !request.gatewaySessionBoundAt) return false;
  if (request.revokedAt || request.haSessionRevokedAt || request.haSessionFailureAt) return false;
  if (!request.approvalValidUntil || request.approvalValidUntil.getTime() <= now.getTime()) return false;
  if (request.haSessionStartedAt || request.haSessionEndedAt) return false;
  if (!matchesUserAgentHash(request.gatewaySessionUserAgentHash, userAgent)) return false;
  return request.gatewaySessionBoundAt.getTime() + HOME_SUPPORT_BOOTSTRAP_RESUME_WINDOW_SECONDS * 1000 > now.getTime();
}

export function resolveHomeSupportGateStatus(
  request: HomeSupportGateRequest | null,
  userAgent: string | null,
  now = new Date()
): HomeSupportGateStatus {
  if (!request) return 'NOT_FOUND';
  if (request.revokedAt || request.haSessionRevokedAt) return 'REVOKED';
  if (request.haSessionFailureAt) return 'FAILED';
  if (!request.approvedAt || !request.approvalValidUntil) return 'WAITING_FOR_APPROVAL';
  if (request.approvalValidUntil.getTime() <= now.getTime()) return 'EXPIRED';
  if (request.haSessionStartedAt && request.haSessionExpiresAt && request.haSessionExpiresAt.getTime() > now.getTime()) {
    return 'ACTIVE_OTHER_DEVICE';
  }
  if (isHomeSupportBootstrapResumable(request, userAgent, now)) return 'RESUME_BOOTSTRAP';
  if (!request.haSecurityCodeHash || !request.haSecurityCodeExpiresAt) return 'EXPIRED';
  if (request.haSecurityCodeExpiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (request.haSecurityCodeConsumedAt) return 'EXPIRED';
  return 'READY_FOR_CODE';
}

export async function resolveRemoteSupportApprovers(
  client: PrismaLike,
  homeId: number
): Promise<RemoteSupportApprover[]> {
  const home = await client.home.findUnique({
    where: { id: homeId },
    select: {
      users: {
        where: { role: Role.ADMIN },
        select: { id: true, email: true, username: true },
      },
      homeContacts: {
        where: { type: HomeContactType.PROPERTY_MANAGER },
        select: { email: true },
      },
    },
  });

  if (!home) return [];

  const seen = new Set<string>();
  const approvers: RemoteSupportApprover[] = [];

  for (const user of home.users) {
    const email = user.email?.trim();
    if (!email) continue;
    const lower = email.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    approvers.push({
      recipientType: SupportApprovalRecipientType.HOMEOWNER,
      recipientUserId: user.id,
      recipientEmail: email,
      recipientName: user.username ?? null,
    });
  }

  const propertyManagerEmail = home.homeContacts[0]?.email?.trim();
  if (propertyManagerEmail) {
    const lower = propertyManagerEmail.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      approvers.push({
        recipientType: SupportApprovalRecipientType.PROPERTY_MANAGER,
        recipientUserId: null,
        recipientEmail: propertyManagerEmail,
        recipientName: null,
      });
    }
  }

  return approvers;
}

export async function issueHomeSupportApprovalTokens(args: {
  client: PrismaLike;
  supportRequestId: string;
  approvers: RemoteSupportApprover[];
}) {
  const issued = [];
  for (const approver of args.approvers) {
    const rawToken = generateOpaqueToken();
    const tokenHash = sha256(rawToken);
    const row = await args.client.supportRequestApprovalToken.create({
      data: {
        supportRequestId: args.supportRequestId,
        recipientType: approver.recipientType,
        recipientUserId: approver.recipientUserId,
        recipientEmail: approver.recipientEmail,
        recipientName: approver.recipientName,
        tokenHash,
        expiresAt: nowPlusMinutes(HOME_SUPPORT_APPROVAL_WINDOW_MINUTES),
      },
    });
    issued.push({ ...row, rawToken });
  }
  return issued;
}

export async function getLatestHomeSupportRequest(
  client: PrismaLike,
  homeId: number,
  installerUserId: number
) {
  return client.supportRequest.findFirst({
    where: {
      kind: 'HOME_ACCESS',
      homeId,
      installerUserId,
    },
    orderBy: { createdAt: 'desc' },
    include: {
      approvalTokens: true,
    },
  });
}

export async function approveHomeSupportByRawToken(
  client: PrismaClient,
  rawToken: string
): Promise<
  | {
      ok: true;
      status: 'APPROVED_NOW';
      supportRequestId: string;
      code: string;
      approvalRecipientName: string | null;
      approvedAt: Date;
      validUntil: Date;
      homeId: number;
    }
  | {
      ok: true;
      status: 'ALREADY_APPROVED';
      supportRequestId: string;
      approvalRecipientName: string | null;
      approvedAt: Date;
      validUntil: Date | null;
      homeId: number;
    }
  | {
      ok: false;
      reason: 'NOT_FOUND' | 'EXPIRED' | 'REVOKED';
    }
> {
  const tokenHash = sha256(rawToken);
  const token = await client.supportRequestApprovalToken.findUnique({
    where: { tokenHash },
    include: {
      supportRequest: true,
    },
  });

  if (!token) return { ok: false, reason: 'NOT_FOUND' };

  const request = token.supportRequest;
  const now = new Date();
  if (request.revokedAt || request.haSessionRevokedAt) {
    return { ok: false, reason: 'REVOKED' };
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (request.approvedAt) {
    return {
      ok: true,
      status: 'ALREADY_APPROVED',
      supportRequestId: request.id,
      approvalRecipientName: request.approvalRecipientName ?? null,
      approvedAt: request.approvedAt,
      validUntil: request.approvalValidUntil ?? null,
      homeId: request.homeId,
    };
  }

  const rawCode = generateNumericCode();
  const codeHash = hashSecretForLookup(rawCode);
  const validUntil = new Date(now.getTime() + HOME_SUPPORT_APPROVAL_WINDOW_MINUTES * 60 * 1000);
  const codeExpiresAt = new Date(now.getTime() + HOME_SUPPORT_CODE_WINDOW_MINUTES * 60 * 1000);

  await client.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        approvedByUserId: token.recipientUserId ?? undefined,
        approvedAt: now,
        approvalValidUntil: validUntil,
        approvalRecipientType: token.recipientType,
        approvalRecipientEmail: token.recipientEmail,
        approvalRecipientName: token.recipientName,
        haSecurityCodeHash: codeHash,
        haSecurityCodeIssuedAt: now,
        haSecurityCodeExpiresAt: codeExpiresAt,
      },
    });

    await tx.supportRequestApprovalToken.update({
      where: { id: token.id },
      data: {
        approvedAt: now,
        consumedAt: now,
      },
    });

    await tx.supportRequestApprovalToken.updateMany({
      where: {
        supportRequestId: request.id,
        id: { not: token.id },
        consumedAt: null,
      },
      data: { consumedAt: now },
    });

    await tx.auditEvent.create({
      data: {
        type: AuditEventType.SUPPORT_REQUEST_APPROVED,
        homeId: request.homeId,
        actorUserId: token.recipientUserId ?? null,
        metadata: buildSupportAuditMetadata({
          supportRequestId: request.id,
          homeId: request.homeId,
          approvalRecipientType: token.recipientType,
          approvalRecipientEmail: token.recipientEmail,
          approvalRecipientName: token.recipientName,
          sessionExpiresAt: validUntil,
        }),
      },
    });

    await tx.auditEvent.create({
      data: {
        type: AuditEventType.SUPPORT_HA_CODE_ISSUED,
        homeId: request.homeId,
        actorUserId: token.recipientUserId ?? null,
        metadata: buildSupportAuditMetadata({
          supportRequestId: request.id,
          homeId: request.homeId,
          approvalRecipientType: token.recipientType,
          approvalRecipientEmail: token.recipientEmail,
          approvalRecipientName: token.recipientName,
          sessionExpiresAt: codeExpiresAt,
        }),
      },
    });
  });

  return {
    ok: true,
    status: 'APPROVED_NOW',
    supportRequestId: request.id,
    code: rawCode,
    approvalRecipientName: token.recipientName ?? null,
    approvedAt: now,
    validUntil,
    homeId: request.homeId,
  };
}

export async function createHomeSupportLaunchTicket(args: {
  client: PrismaClient;
  supportRequestId: string;
  installerUserId: number;
  code: string;
  hostname: string;
  actorUserId: number;
  actorUsername?: string | null;
  userAgent?: string | null;
}) {
  const request = await args.client.supportRequest.findUnique({
    where: { id: args.supportRequestId },
  });

  if (!request || request.kind !== 'HOME_ACCESS' || request.installerUserId !== args.installerUserId) {
    return { ok: false as const, reason: 'NOT_FOUND' };
  }

  const now = new Date();
  if (!request.approvedAt || !request.approvalValidUntil || request.approvalValidUntil.getTime() <= now.getTime()) {
    return { ok: false as const, reason: 'EXPIRED' };
  }
  if (request.revokedAt || request.haSessionRevokedAt) {
    return { ok: false as const, reason: 'REVOKED' };
  }
  if (request.haSessionFailureAt) {
    return { ok: false as const, reason: 'FAILED' };
  }
  if (!request.haSecurityCodeHash || !request.haSecurityCodeExpiresAt) {
    return { ok: false as const, reason: 'EXPIRED' };
  }
  if (request.haSecurityCodeExpiresAt.getTime() <= now.getTime()) {
    return { ok: false as const, reason: 'EXPIRED' };
  }
  if (request.haSessionStartedAt && request.haSessionExpiresAt && request.haSessionExpiresAt.getTime() > now.getTime()) {
    return { ok: false as const, reason: 'ACTIVE_OTHER_DEVICE' };
  }
  if (request.haSecurityCodeConsumedAt) {
    if (isHomeSupportBootstrapResumable(request, args.userAgent ?? null, now)) {
      return { ok: false as const, reason: 'BOOTSTRAP_IN_PROGRESS' };
    }
    return { ok: false as const, reason: 'EXPIRED' };
  }
  if (request.gatewaySessionHash) {
    return { ok: false as const, reason: 'BOOTSTRAP_IN_PROGRESS' };
  }
  if (hashSecretForLookup(args.code) !== request.haSecurityCodeHash) {
    return { ok: false as const, reason: 'INVALID_CODE' };
  }

  const rawLaunchTicket = generateOpaqueToken();
  const launchTicketHash = sha256(rawLaunchTicket);
  const launchTicketExpiresAt = new Date(
    Math.min(
      now.getTime() + HOME_SUPPORT_LAUNCH_TICKET_WINDOW_MINUTES * 60 * 1000,
      request.approvalValidUntil.getTime()
    )
  );

  await args.client.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        supportGatewayHostname: args.hostname,
        haSecurityCodeConsumedAt: now,
        connectButtonClickedAt: request.connectButtonClickedAt ?? now,
        launchTicketHash,
        launchTicketExpiresAt,
        consumedAt: now,
        haSessionFailureAt: null,
        haSessionFailureCode: null,
        haSessionEndedAt: null,
        haSessionRevokedAt: null,
      },
    });

    await tx.auditEvent.create({
      data: {
        type: AuditEventType.SUPPORT_HA_CODE_CONSUMED,
        homeId: request.homeId,
        actorUserId: args.actorUserId,
        metadata: buildSupportAuditMetadata({
          supportRequestId: request.id,
          homeId: request.homeId,
          actorUserId: args.actorUserId,
          actorUsername: args.actorUsername ?? null,
          hostname: args.hostname,
          sessionExpiresAt: request.approvalValidUntil,
          extra: {
            phase: 'LAUNCH_TICKET_ISSUED',
            launchTicketExpiresAt: launchTicketExpiresAt.toISOString(),
          },
        }),
      },
    });
  });

  return {
    ok: true as const,
    launchTicket: rawLaunchTicket,
    launchTicketExpiresAt,
    validUntil: request.approvalValidUntil,
  };
}

export async function bootstrapGatewaySupportSession(args: {
  client: PrismaLike;
  rawLaunchTicket: string;
  hostname: string;
  userAgent: string | null;
  actorUsername?: string | null;
}) {
  const launchTicketHash = sha256(args.rawLaunchTicket);
  const request = await args.client.supportRequest.findFirst({
    where: { launchTicketHash, kind: 'HOME_ACCESS' },
    include: {
      approvalTokens: true,
    },
  });

  if (!request) return { ok: false as const, reason: 'NOT_FOUND' };

  const now = new Date();
  if (
    !request.launchTicketExpiresAt ||
    request.launchTicketExpiresAt.getTime() <= now.getTime() ||
    !request.approvalValidUntil ||
    request.approvalValidUntil.getTime() <= now.getTime()
  ) {
    return { ok: false as const, reason: 'EXPIRED' };
  }
  if (request.revokedAt || request.haSessionRevokedAt) return { ok: false as const, reason: 'REVOKED' };

  const userAgentHash = args.userAgent ? sha256(args.userAgent) : null;
  if (request.gatewaySessionHash) {
    const sameBoundSession =
      request.gatewaySessionHash === launchTicketHash &&
      (!request.supportGatewayHostname || request.supportGatewayHostname === args.hostname) &&
      matchesUserAgentHash(request.gatewaySessionUserAgentHash, args.userAgent) &&
      isHomeSupportBootstrapResumable(request, args.userAgent, now);

    if (sameBoundSession) {
      const resumedHome = await args.client.home.findUnique({
        where: { id: request.homeId },
        select: {
          haConnection: {
            select: {
              cloudUrl: true,
              haUsername: true,
              haUsernameCiphertext: true,
              haPassword: true,
              haPasswordCiphertext: true,
            },
          },
        },
      });

      if (!resumedHome?.haConnection) return { ok: false as const, reason: 'NOT_FOUND' };
      const { haUsername, haPassword } = resolveHaUiCredentials(resumedHome.haConnection);

      return {
        ok: true as const,
        resumedExistingBootstrap: true,
        supportRequestId: request.id,
        homeId: request.homeId,
        sessionToken: args.rawLaunchTicket,
        sessionExpiresAt: request.approvalValidUntil,
        cloudUrl: resumedHome.haConnection.cloudUrl ?? null,
        haUsername,
        haPassword,
      };
    }

    return { ok: false as const, reason: 'ACTIVE' };
  }

  const home = await args.client.home.findUnique({
    where: { id: request.homeId },
    select: {
      id: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      postcode: true,
      users: {
        where: { email: { not: null } },
        select: { id: true, username: true, email: true, role: true },
      },
      homeContacts: {
        where: { type: 'PROPERTY_MANAGER' },
        select: { email: true },
      },
      haConnection: {
        select: {
          baseUrl: true,
          cloudUrl: true,
          haUsername: true,
          haUsernameCiphertext: true,
          haPassword: true,
          haPasswordCiphertext: true,
          longLivedToken: true,
          longLivedTokenCiphertext: true,
        },
      },
    },
  });

  if (!home?.haConnection) return { ok: false as const, reason: 'NOT_FOUND' };

  const { haUsername, haPassword } = resolveHaUiCredentials(home.haConnection);

  await args.client.supportRequest.update({
    where: { id: request.id },
    data: {
      gatewaySessionHash: launchTicketHash,
      gatewaySessionBoundAt: now,
      gatewaySessionUserAgentHash: userAgentHash,
    },
  });

  return {
    ok: true as const,
    resumedExistingBootstrap: false,
    supportRequestId: request.id,
    homeId: request.homeId,
    sessionToken: args.rawLaunchTicket,
    sessionExpiresAt: request.approvalValidUntil,
    cloudUrl: home.haConnection.cloudUrl ?? null,
    haUsername,
    haPassword,
  };
}

export async function activateGatewaySupportSession(args: {
  client: PrismaLike;
  rawGatewaySessionToken: string;
  hostname: string;
  actorUsername?: string | null;
}) {
  const gatewaySessionHash = sha256(args.rawGatewaySessionToken);
  const request = await args.client.supportRequest.findFirst({
    where: { gatewaySessionHash, kind: 'HOME_ACCESS' },
    select: {
      id: true,
      homeId: true,
      installerUserId: true,
      approvalValidUntil: true,
      revokedAt: true,
      haSessionRevokedAt: true,
      haSessionFailureAt: true,
      haSessionStartedAt: true,
      haSessionExpiresAt: true,
    },
  });

  if (!request) return { ok: false as const, reason: 'NOT_FOUND' };

  const now = new Date();
  if (!request.approvalValidUntil || request.approvalValidUntil.getTime() <= now.getTime()) {
    return { ok: false as const, reason: 'EXPIRED', supportRequestId: request.id };
  }
  if (request.revokedAt || request.haSessionRevokedAt) {
    return { ok: false as const, reason: 'REVOKED', supportRequestId: request.id };
  }
  if (request.haSessionFailureAt) {
    return { ok: false as const, reason: 'FAILED', supportRequestId: request.id };
  }
  if (request.haSessionStartedAt && request.haSessionExpiresAt && request.haSessionExpiresAt.getTime() > now.getTime()) {
    return {
      ok: true as const,
      supportRequestId: request.id,
      sessionExpiresAt: request.haSessionExpiresAt,
      alreadyActive: true,
    };
  }

  const home = await args.client.home.findUnique({
    where: { id: request.homeId },
    select: {
      id: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      postcode: true,
      users: {
        where: { email: { not: null } },
        select: { id: true, username: true, email: true, role: true },
      },
      homeContacts: {
        where: { type: 'PROPERTY_MANAGER' },
        select: { email: true },
      },
    },
  });

  if (!home) return { ok: false as const, reason: 'NOT_FOUND', supportRequestId: request.id };

  await args.client.supportRequest.update({
    where: { id: request.id },
    data: {
      launchTicketHash: null,
      launchTicketExpiresAt: null,
      haSessionStartedAt: now,
      haSessionExpiresAt: request.approvalValidUntil,
      haSessionFailureAt: null,
      haSessionFailureCode: null,
      haSessionEndedAt: null,
    },
  });

  await args.client.auditEvent.create({
    data: {
      type: AuditEventType.SUPPORT_HA_SESSION_STARTED,
      homeId: request.homeId,
      actorUserId: request.installerUserId,
      metadata: buildSupportAuditMetadata({
        supportRequestId: request.id,
        homeId: request.homeId,
        actorUserId: request.installerUserId,
        actorUsername: args.actorUsername ?? null,
        hostname: args.hostname,
        sessionExpiresAt: request.approvalValidUntil,
        extra: {
          phase: 'SESSION_USABLE_CONFIRMED',
        },
      }),
    },
  });

  const notification = await sendHomeSupportSessionNotifications(args.client, {
    supportRequestId: request.id,
    homeId: request.homeId,
    homeLabel: buildHomeLabel({
      homeId: home.id,
      addressLine1: home.addressLine1,
      addressLine2: home.addressLine2,
      city: home.city,
      postcode: home.postcode,
    }),
    users: home.users,
    propertyManagerEmail: home.homeContacts[0]?.email?.trim() ?? null,
    supportAgentName: args.actorUsername ?? 'Dinodia support',
    startedAt: now,
  });

  await args.client.supportRequest.update({
    where: { id: request.id },
    data: notification.ok
      ? {
          notificationSentAt: now,
          notificationFailedAt: null,
          notificationFailureReason: null,
        }
      : {
          notificationFailedAt: now,
          notificationFailureReason: notification.error,
        },
  });

  return {
    ok: true as const,
    supportRequestId: request.id,
    sessionExpiresAt: request.approvalValidUntil,
    alreadyActive: false,
  };
}

export async function introspectGatewaySupportSession(args: {
  client: PrismaLike;
  rawGatewaySessionToken: string;
  hostname: string;
  userAgent: string | null;
  checkMode?: 'browser' | 'service';
}) {
  const gatewaySessionHash = sha256(args.rawGatewaySessionToken);
  const request = await args.client.supportRequest.findFirst({
    where: { gatewaySessionHash, kind: 'HOME_ACCESS' },
    select: {
      id: true,
      homeId: true,
      installerUserId: true,
      supportGatewayHostname: true,
      approvalValidUntil: true,
      revokedAt: true,
      haSessionRevokedAt: true,
      haSessionFailureAt: true,
      haSessionExpiresAt: true,
      gatewaySessionUserAgentHash: true,
    },
  });

  if (!request) return { ok: false as const, reason: 'NOT_FOUND' };
  const now = new Date();
  if (request.supportGatewayHostname && request.supportGatewayHostname !== args.hostname) {
    return { ok: false as const, reason: 'HOST_MISMATCH', supportRequestId: request.id };
  }
  if (request.revokedAt || request.haSessionRevokedAt) {
    return { ok: false as const, reason: 'REVOKED', supportRequestId: request.id };
  }
  if (request.haSessionFailureAt) {
    return { ok: false as const, reason: 'FAILED', supportRequestId: request.id };
  }
  if (!request.approvalValidUntil || request.approvalValidUntil.getTime() <= now.getTime()) {
    return { ok: false as const, reason: 'EXPIRED', supportRequestId: request.id };
  }
  if (request.haSessionExpiresAt && request.haSessionExpiresAt.getTime() <= now.getTime()) {
    return { ok: false as const, reason: 'EXPIRED', supportRequestId: request.id };
  }
  if (
    args.checkMode !== 'service' &&
    request.gatewaySessionUserAgentHash &&
    !matchesUserAgentHash(request.gatewaySessionUserAgentHash, args.userAgent)
  ) {
    return { ok: false as const, reason: 'USER_AGENT_MISMATCH', supportRequestId: request.id };
  }

  return {
    ok: true as const,
    supportRequestId: request.id,
    homeId: request.homeId,
    installerUserId: request.installerUserId,
    expiresAt: request.haSessionExpiresAt ?? request.approvalValidUntil,
  };
}

export async function markGatewaySupportSessionEnded(args: {
  client: PrismaLike;
  rawGatewaySessionToken?: string | null;
  supportRequestId?: string | null;
  reason: 'EXPIRED' | 'FAILED' | 'ENDED' | 'REVOKED';
  failureCode?: string | null;
}) {
  const request =
    args.rawGatewaySessionToken != null
      ? await args.client.supportRequest.findFirst({
          where: { gatewaySessionHash: sha256(args.rawGatewaySessionToken), kind: 'HOME_ACCESS' },
        })
      : args.supportRequestId
        ? await args.client.supportRequest.findUnique({ where: { id: args.supportRequestId } })
        : null;

  if (!request) return { ok: false as const, reason: 'NOT_FOUND' };

  const now = new Date();
  const updateData: Prisma.SupportRequestUpdateInput = {
    launchTicketHash: null,
    launchTicketExpiresAt: null,
    gatewaySessionHash: null,
    gatewaySessionBoundAt: null,
    gatewaySessionUserAgentHash: null,
  };
  if (args.reason === 'FAILED') {
    updateData.haSessionFailureAt = now;
    updateData.haSessionFailureCode = normalizeHomeSupportFailureCode(args.failureCode);
  } else if (args.reason === 'REVOKED') {
    updateData.haSessionRevokedAt = now;
  } else {
    updateData.haSessionEndedAt = now;
  }

  await args.client.supportRequest.update({
    where: { id: request.id },
    data: updateData,
  });

  if (args.reason === 'EXPIRED') {
    await args.client.auditEvent.create({
      data: {
        type: AuditEventType.SUPPORT_HA_SESSION_EXPIRED,
        homeId: request.homeId,
        actorUserId: request.installerUserId,
        metadata: buildSupportAuditMetadata({
          supportRequestId: request.id,
          homeId: request.homeId,
        }),
      },
    });
  } else if (args.reason === 'FAILED') {
    await args.client.auditEvent.create({
      data: {
        type: AuditEventType.SUPPORT_HA_SESSION_FAILED,
        homeId: request.homeId,
        actorUserId: request.installerUserId,
        metadata: buildSupportAuditMetadata({
          supportRequestId: request.id,
          homeId: request.homeId,
          failureCode: normalizeHomeSupportFailureCode(args.failureCode),
          extra: {
            phase: 'SESSION_FAILED',
          },
        }),
      },
    });
  }

  return { ok: true as const, supportRequestId: request.id };
}

export async function revokeHomeSupportRequest(args: {
  client: PrismaClient;
  supportRequestId: string;
  actorUserId?: number | null;
  actorUsername?: string | null;
  reason?: string | null;
}) {
  const request = await args.client.supportRequest.findUnique({
    where: { id: args.supportRequestId },
  });
  if (!request || request.kind !== 'HOME_ACCESS') {
    return { ok: false as const, reason: 'NOT_FOUND' };
  }
  const now = new Date();
  await args.client.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        revokedAt: now,
        revokedByUserId: args.actorUserId ?? undefined,
        haSessionRevokedAt: now,
        launchTicketHash: null,
        launchTicketExpiresAt: null,
        gatewaySessionHash: null,
        gatewaySessionBoundAt: null,
        gatewaySessionUserAgentHash: null,
      },
    });

    await tx.auditEvent.create({
      data: {
        type: AuditEventType.SUPPORT_REQUEST_REVOKED,
        homeId: request.homeId,
        actorUserId: args.actorUserId ?? null,
        metadata: buildSupportAuditMetadata({
          supportRequestId: request.id,
          homeId: request.homeId,
          actorUserId: args.actorUserId ?? null,
          actorUsername: args.actorUsername ?? null,
          reason: args.reason ?? 'Emergency remote access revoke',
        }),
      },
    });
  });

  return { ok: true as const, supportRequestId: request.id };
}

async function sendHomeSupportSessionNotifications(
  client: PrismaLike,
  args: {
    supportRequestId: string;
    homeId: number;
    homeLabel: string;
    users: Array<{ id: number; username: string; email: string | null; role: Role }>;
    propertyManagerEmail: string | null;
    supportAgentName: string;
    startedAt: Date;
  }
) {
  try {
    const appUrl = getAppUrl();
    const homeownerTemplate = buildSupportHomeownerAccessStartedEmail({
      homeLabel: args.homeLabel,
      supportAgentName: args.supportAgentName,
      startedAt: args.startedAt,
      appUrl,
    });
    const tenantTemplate = buildSupportTenantAccessStartedEmail({
      homeLabel: args.homeLabel,
      supportAgentName: args.supportAgentName,
      startedAt: args.startedAt,
      appUrl,
    });

    const sent = new Set<string>();

    const homeowners = args.users.filter((user) => user.role === Role.ADMIN && user.email);
    for (const user of homeowners) {
      const email = user.email!.trim().toLowerCase();
      if (sent.has(email)) continue;
      sent.add(email);
      await sendEmail({
        to: user.email!,
        subject: homeownerTemplate.subject,
        html: homeownerTemplate.html,
        text: homeownerTemplate.text,
      });
    }

    if (args.propertyManagerEmail) {
      const email = args.propertyManagerEmail.trim().toLowerCase();
      if (!sent.has(email)) {
        sent.add(email);
        await sendEmail({
          to: args.propertyManagerEmail,
          subject: homeownerTemplate.subject,
          html: homeownerTemplate.html,
          text: homeownerTemplate.text,
        });
      }
    }

    const tenants = args.users.filter((user) => user.role === Role.TENANT && user.email);
    for (const user of tenants) {
      const email = user.email!.trim().toLowerCase();
      if (sent.has(email)) continue;
      sent.add(email);
      await sendEmail({
        to: user.email!,
        subject: tenantTemplate.subject,
        html: tenantTemplate.html,
        text: tenantTemplate.text,
      });
    }

    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'Failed to send support notifications.',
    };
  }
}

export function renderSupportApprovalPage(input: {
  title: string;
  message: string;
  showApprove?: boolean;
  showRevoke?: boolean;
  token?: string;
  code?: string | null;
}) {
  const safeTitle = escapeHtml(input.title);
  const safeMessage = escapeHtml(input.message);
  const safeToken = escapeHtml(input.token ?? '');
  const safeCode = input.code ? escapeHtml(input.code) : null;
  const safeCodeCopy = safeCode ? escapeHtml(buildSupportApprovalSuccessCopy(input.code!)) : '';
  const codeSection = input.code
    ? `<div style="margin-top:16px;padding:16px;border-radius:10px;background:#f8fafc;border:1px solid #cbd5e1;">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:0.08em;">HASecurityCode</div>
        <div style="margin-top:8px;font-size:28px;font-weight:700;letter-spacing:0.16em;">${safeCode}</div>
        <div style="margin-top:8px;color:#475569;">${safeCodeCopy}</div>
      </div>`
    : '';
  const actionForm =
    input.showApprove && safeToken
      ? `<form method="POST" style="margin-top:16px;">
          <input type="hidden" name="token" value="${safeToken}" />
          <input type="hidden" name="action" value="approve" />
          <button type="submit" style="padding:10px 16px; background:#111827; color:#fff; border:none; border-radius:8px; cursor:pointer;">Approve access</button>
        </form>`
      : '';
  const revokeForm =
    input.showRevoke && safeToken
      ? `<form method="POST" style="margin-top:12px;">
          <input type="hidden" name="token" value="${safeToken}" />
          <input type="hidden" name="action" value="revoke" />
          <button type="submit" style="padding:10px 16px; background:#991b1b; color:#fff; border:none; border-radius:8px; cursor:pointer;">Revoke remote access now</button>
        </form>`
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dinodia support approval</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 40px; }
      .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0 0 12px 0; font-size: 22px; }
      p { margin: 0; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      ${codeSection}
      ${actionForm}
      ${revokeForm}
    </div>
  </body>
</html>`;
}
