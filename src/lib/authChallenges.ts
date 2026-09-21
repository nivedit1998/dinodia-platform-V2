// Architecture: Shared platform helper src/lib/authChallenges.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import crypto from 'crypto';
import {
  AuditEventType,
  AuthChallengePurpose,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { prisma } from './prisma';
import { buildVerifyLinkEmail } from './emailTemplates';
import { sendEmail } from './email';
import { safeLog } from './safeLogger';

const DEFAULT_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 30;
const REPLY_TO = 'niveditgupta@dinodiasmartliving.com';

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

type TokenLookupChallenge = {
  id: string;
  userId: number;
  purpose: AuthChallengePurpose;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
};

type CompletionChallenge = TokenLookupChallenge & {
  email: string;
  deviceId: string | null;
};

const TOKEN_LOOKUP_SELECT = {
  id: true,
  userId: true,
  purpose: true,
  expiresAt: true,
  approvedAt: true,
  consumedAt: true,
} as const;

const COMPLETION_CHALLENGE_SELECT = {
  id: true,
  userId: true,
  purpose: true,
  email: true,
  deviceId: true,
  expiresAt: true,
  approvedAt: true,
  consumedAt: true,
} as const;

type TokenLookupResult =
  | { kind: 'NOT_FOUND' }
  | { kind: 'ACTIVE'; challenge: TokenLookupChallenge }
  | { kind: 'SUPERSEDED'; challenge: TokenLookupChallenge };

export type VerifyTokenStatus = 'PENDING' | 'APPROVED' | 'CONSUMED' | 'EXPIRED' | 'NOT_FOUND' | 'SUPERSEDED';

export type ApproveChallengeResult =
  | {
      ok: true;
      status: 'APPROVED_NOW' | 'ALREADY_APPROVED' | 'ALREADY_CONSUMED';
      challengeId: string;
      purpose: AuthChallengePurpose;
    }
  | {
      ok: false;
      reason: 'NOT_FOUND' | 'EXPIRED' | 'SUPERSEDED';
      challengeId?: string;
      purpose?: AuthChallengePurpose;
    };

export type ChallengeCompletionValidationResult =
  | {
      ok: true;
      challenge: CompletionChallenge;
    }
  | {
      ok: false;
      reason:
        | 'NOT_FOUND'
        | 'ALREADY_CONSUMED'
        | 'EXPIRED'
        | 'NOT_APPROVED'
        | 'DEVICE_MISMATCH'
        | 'DEVICE_REQUIRED';
      challenge?: CompletionChallenge;
    };

async function findChallengeByTokenHash(tokenHash: string): Promise<TokenLookupResult> {
  const active = await prisma.authChallenge.findUnique({
    where: { tokenHash },
    select: TOKEN_LOOKUP_SELECT,
  });
  if (active) {
    return { kind: 'ACTIVE', challenge: active };
  }

  const superseded = await prisma.authChallenge.findFirst({
    where: { supersededTokenHashes: { has: tokenHash } },
    select: TOKEN_LOOKUP_SELECT,
  });
  if (superseded) {
    return { kind: 'SUPERSEDED', challenge: superseded };
  }

  return { kind: 'NOT_FOUND' };
}

async function recordSupportRequestApproval(
  client: PrismaClientOrTx,
  challengeId: string,
  approverUserId: number,
  approvedAt: Date
) {
  const supportRequest = await client.supportRequest.findUnique({
    where: { authChallengeId: challengeId },
    select: {
      id: true,
      kind: true,
      homeId: true,
      installerUserId: true,
      targetUserId: true,
      scope: true,
      reason: true,
    },
  });

  if (!supportRequest) return;

  await client.supportRequest.update({
    where: { id: supportRequest.id },
    data: { approvedByUserId: approverUserId },
  });

  await client.auditEvent.create({
    data: {
      type: AuditEventType.SUPPORT_REQUEST_APPROVED,
      homeId: supportRequest.homeId,
      actorUserId: approverUserId,
      metadata: {
        supportRequestId: supportRequest.id,
        kind: supportRequest.kind,
        installerUserId: supportRequest.installerUserId,
        targetUserId: supportRequest.targetUserId,
        scope: supportRequest.scope,
        reason: supportRequest.reason,
        approvedAt: approvedAt.toISOString(),
      },
    },
  });
}

function isCompletionDeviceRelaxed(purpose: AuthChallengePurpose) {
  return (
    purpose === AuthChallengePurpose.ADMIN_EMAIL_VERIFY ||
    purpose === AuthChallengePurpose.LOGIN_NEW_DEVICE ||
    purpose === AuthChallengePurpose.TENANT_ENABLE_2FA
  );
}

export function getAppUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    'http://localhost:3000'
  );
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function createAuthChallenge(args: {
  userId: number;
  purpose: AuthChallengePurpose;
  email: string;
  deviceId?: string | null;
  ttlMinutes?: number;
}): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + (args.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60 * 1000
  );

  const challenge = await prisma.authChallenge.create({
    data: {
      userId: args.userId,
      purpose: args.purpose,
      email: args.email,
      deviceId: args.deviceId ?? null,
      tokenHash,
      expiresAt,
    },
  });

  return { id: challenge.id, token, expiresAt };
}

export async function approveAuthChallengeByToken(rawToken: string): Promise<ApproveChallengeResult> {
  const tokenHash = hashToken(rawToken);
  const lookup = await findChallengeByTokenHash(tokenHash);
  const now = new Date();

  if (lookup.kind === 'NOT_FOUND') {
    safeLog('info', '[authChallenges] approval result', {
      event: 'auth_challenge_approval',
      result: 'not_found',
    });
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const challenge = lookup.challenge;
  if (lookup.kind === 'SUPERSEDED') {
    safeLog('info', '[authChallenges] approval result', {
      event: 'auth_challenge_approval',
      result: 'superseded',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    });
    return {
      ok: false,
      reason: 'SUPERSEDED',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    };
  }
  if (challenge.consumedAt) {
    safeLog('info', '[authChallenges] approval result', {
      event: 'auth_challenge_approval',
      result: 'already_consumed',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    });
    return {
      ok: true,
      status: 'ALREADY_CONSUMED',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    };
  }
  if (challenge.approvedAt) {
    safeLog('info', '[authChallenges] approval result', {
      event: 'auth_challenge_approval',
      result: 'already_approved',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    });
    return {
      ok: true,
      status: 'ALREADY_APPROVED',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    };
  }
  if (challenge.expiresAt < now) {
    safeLog('info', '[authChallenges] approval result', {
      event: 'auth_challenge_approval',
      result: 'expired',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    });
    return {
      ok: false,
      reason: 'EXPIRED',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const approvedAt = new Date();
    const updated = await tx.authChallenge.updateMany({
      where: {
        id: challenge.id,
        approvedAt: null,
        consumedAt: null,
        expiresAt: { gt: approvedAt },
      },
      data: { approvedAt },
    });

    if (updated.count === 1) {
      await recordSupportRequestApproval(tx, challenge.id, challenge.userId, approvedAt);
      return 'APPROVED_NOW' as const;
    }

    const current = await tx.authChallenge.findUnique({
      where: { id: challenge.id },
      select: TOKEN_LOOKUP_SELECT,
    });
    if (!current) return 'NOT_FOUND' as const;
    if (current.consumedAt) return 'ALREADY_CONSUMED' as const;
    if (current.approvedAt) return 'ALREADY_APPROVED' as const;
    if (current.expiresAt < approvedAt) return 'EXPIRED' as const;
    return 'NOT_FOUND' as const;
  });

  if (outcome === 'EXPIRED' || outcome === 'NOT_FOUND') {
    safeLog('info', '[authChallenges] approval result', {
      event: 'auth_challenge_approval',
      result: outcome === 'EXPIRED' ? 'expired' : 'not_found',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    });
    return {
      ok: false,
      reason: outcome === 'EXPIRED' ? 'EXPIRED' : 'NOT_FOUND',
      challengeId: challenge.id,
      purpose: challenge.purpose,
    };
  }

  safeLog('info', '[authChallenges] approval result', {
    event: 'auth_challenge_approval',
    result:
      outcome === 'APPROVED_NOW'
        ? 'approved_now'
        : outcome === 'ALREADY_APPROVED'
          ? 'already_approved'
          : 'already_consumed',
    challengeId: challenge.id,
    purpose: challenge.purpose,
  });

  return {
    ok: true,
    status: outcome,
    challengeId: challenge.id,
    purpose: challenge.purpose,
  };
}

export async function getChallengeStatusByToken(rawToken: string): Promise<{
  status: VerifyTokenStatus;
  challengeId?: string;
}> {
  const tokenHash = hashToken(rawToken);
  const lookup = await findChallengeByTokenHash(tokenHash);

  if (lookup.kind === 'NOT_FOUND') return { status: 'NOT_FOUND' };

  const challenge = lookup.challenge;
  if (lookup.kind === 'SUPERSEDED') return { status: 'SUPERSEDED', challengeId: challenge.id };
  if (challenge.consumedAt) return { status: 'CONSUMED', challengeId: challenge.id };
  if (challenge.approvedAt) return { status: 'APPROVED', challengeId: challenge.id };
  if (challenge.expiresAt < new Date()) return { status: 'EXPIRED', challengeId: challenge.id };
  return { status: 'PENDING', challengeId: challenge.id };
}

export type ChallengeStatusDetail = {
  status: 'PENDING' | 'APPROVED' | 'CONSUMED' | 'EXPIRED' | 'NOT_FOUND';
  challengeId?: string;
  expiresAt?: string;
  approvedAt?: string | null;
  consumedAt?: string | null;
  serverNow: string;
};

export async function getChallengeStatusDetail(id: string): Promise<ChallengeStatusDetail> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id },
    select: {
      id: true,
      expiresAt: true,
      approvedAt: true,
      consumedAt: true,
    },
  });

  const serverNow = new Date().toISOString();
  if (!challenge) return { status: 'NOT_FOUND', serverNow };

  const detail = {
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt.toISOString(),
    approvedAt: challenge.approvedAt?.toISOString() ?? null,
    consumedAt: challenge.consumedAt?.toISOString() ?? null,
    serverNow,
  };

  if (challenge.consumedAt) return { status: 'CONSUMED', ...detail };
  if (challenge.approvedAt) return { status: 'APPROVED', ...detail };
  if (challenge.expiresAt < new Date()) return { status: 'EXPIRED', ...detail };
  return { status: 'PENDING', ...detail };
}

export async function getChallengeStatus(id: string): Promise<
  'PENDING' | 'APPROVED' | 'CONSUMED' | 'EXPIRED' | 'NOT_FOUND'
> {
  const detail = await getChallengeStatusDetail(id);
  return detail.status;
}

export async function resendChallengeEmail(id: string): Promise<
  | { ok: true; resentAt: string; resendAvailableAt: string; expiresAt: string }
  | { ok: false; reason: string; retryAfterSeconds?: number }
> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id },
    include: { user: { select: { username: true } } },
  });

  if (!challenge) return { ok: false, reason: 'NOT_FOUND' };
  if (challenge.purpose === AuthChallengePurpose.PASSWORD_RESET) {
    return { ok: false, reason: 'UNSUPPORTED' };
  }
  if (challenge.consumedAt) return { ok: false, reason: 'ALREADY_CONSUMED' };
  if (challenge.approvedAt) return { ok: false, reason: 'ALREADY_APPROVED' };
  if (challenge.expiresAt < new Date()) return { ok: false, reason: 'EXPIRED' };

  const secondsSinceCreated = (Date.now() - challenge.createdAt.getTime()) / 1000;
  if (secondsSinceCreated < RESEND_COOLDOWN_SECONDS) {
    return {
      ok: false,
      reason: 'TOO_SOON',
      retryAfterSeconds: Math.max(1, Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceCreated)),
    };
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const resentAt = new Date();
  const supersededTokenHashes = challenge.supersededTokenHashes.includes(challenge.tokenHash)
    ? challenge.supersededTokenHashes
    : [...challenge.supersededTokenHashes, challenge.tokenHash];

  const rotated = await prisma.authChallenge.updateMany({
    where: {
      id: challenge.id,
      consumedAt: null,
      approvedAt: null,
      expiresAt: { gt: resentAt },
      createdAt: challenge.createdAt,
    },
    data: {
      tokenHash,
      supersededTokenHashes,
      createdAt: resentAt,
    },
  });

  if (rotated.count !== 1) {
    const current = await prisma.authChallenge.findUnique({
      where: { id: challenge.id },
      select: {
        approvedAt: true,
        consumedAt: true,
        expiresAt: true,
      },
    });
    if (!current) return { ok: false, reason: 'NOT_FOUND' };
    if (current.consumedAt) return { ok: false, reason: 'ALREADY_CONSUMED' };
    if (current.approvedAt) return { ok: false, reason: 'ALREADY_APPROVED' };
    if (current.expiresAt < resentAt) return { ok: false, reason: 'EXPIRED' };
    return { ok: false, reason: 'UNSUPPORTED' };
  }

  const appUrl = getAppUrl();
  const verifyUrl = `${appUrl}/auth/verify?token=${token}`;
  const email = buildVerifyLinkEmail({
    kind: challenge.purpose,
    verifyUrl,
    appUrl,
    username: challenge.user?.username,
  });

  await sendEmail({
    to: challenge.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: REPLY_TO,
  });

  return {
    ok: true,
    resentAt: resentAt.toISOString(),
    resendAvailableAt: new Date(
      resentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000
    ).toISOString(),
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

export async function validateChallengeForCompletion(args: {
  id: string;
  deviceId?: string;
}): Promise<ChallengeCompletionValidationResult> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id: args.id },
    select: COMPLETION_CHALLENGE_SELECT,
  });

  if (!challenge) return { ok: false, reason: 'NOT_FOUND' };
  if (challenge.consumedAt) return { ok: false, reason: 'ALREADY_CONSUMED', challenge };

  const now = new Date();
  if (!challenge.approvedAt) {
    if (challenge.expiresAt < now) return { ok: false, reason: 'EXPIRED', challenge };
    return { ok: false, reason: 'NOT_APPROVED', challenge };
  }

  if (challenge.deviceId && args.deviceId && challenge.deviceId !== args.deviceId) {
    if (!isCompletionDeviceRelaxed(challenge.purpose)) {
      return { ok: false, reason: 'DEVICE_MISMATCH', challenge };
    }
  }
  if (challenge.deviceId && !args.deviceId) {
    if (!isCompletionDeviceRelaxed(challenge.purpose)) {
      return { ok: false, reason: 'DEVICE_REQUIRED', challenge };
    }
  }

  return { ok: true, challenge };
}

export async function markChallengeConsumed(
  id: string,
  client: PrismaClientOrTx = prisma,
  consumedAt = new Date()
) {
  const result = await client.authChallenge.updateMany({
    where: {
      id,
      approvedAt: { not: null },
      consumedAt: null,
    },
    data: { consumedAt },
  });
  return result.count === 1;
}

export function buildVerifyUrl(token: string) {
  return `${getAppUrl()}/auth/verify?token=${token}`;
}

export function buildPasswordResetUrl(token: string) {
  return `${getAppUrl()}/reset-password?token=${token}`;
}
