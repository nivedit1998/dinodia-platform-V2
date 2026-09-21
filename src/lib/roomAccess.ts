// Architecture: Shared platform helper src/lib/roomAccess.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import crypto from 'crypto';
import { AuditEventType, HomeContactType, HomeStatus, Role, RoomAccessApprovalKind, RoomAccessRequestStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { getAppUrl } from '@/lib/authChallenges';
import { sendEmail } from '@/lib/email';
import { buildRoomAccessDecisionEmail, buildRoomAccessRequestEmail, buildTenantWelcomeEmail } from '@/lib/roomAccessEmails';
import { hashSha256, generateRandomHex } from '@/lib/hubCrypto';
import { getPropertyManagerEmail } from '@/lib/homeContacts';

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const APPROVAL_TTL_DAYS = 7;

function looksLikeEmail(value: string): boolean {
  return EMAIL_REGEX.test(value.trim());
}

export function generateTemporaryPassword(): string {
  // Non-hex so it doesn't look like an API token.
  return `${generateRandomHex(8)}-${generateRandomHex(8)}`; // ~34 chars including dash
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.+/g, '.');
}

export async function generateUniqueUsername(args: { requestedName: string; requestedEmail: string }): Promise<string> {
  const fromName = slugify(args.requestedName);
  const fromEmail = slugify(args.requestedEmail.split('@')[0] ?? '');
  const base = (fromName || fromEmail || 'tenant').slice(0, 24);

  const candidates: string[] = [base];
  for (let i = 1; i <= 30; i += 1) {
    candidates.push(`${base}.${i}`);
  }
  const existing = await prisma.user.findMany({
    where: { username: { in: candidates } },
    select: { username: true },
  });
  const taken = new Set(existing.map((u) => u.username.toLowerCase()));
  const pick = candidates.find((c) => !taken.has(c.toLowerCase()));
  if (pick) return pick;

  // Fallback: randomized suffix
  for (let i = 0; i < 10; i += 1) {
    const candidate = `${base}.${generateRandomHex(2)}`.slice(0, 32);
    const exists = await prisma.user.findFirst({
      where: { username: { equals: candidate, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!exists) return candidate;
  }

  throw new Error('Unable to generate a unique username.');
}

export async function resolveSingleHomeownerAdmin(homeId: number): Promise<{ id: number; username: string; email: string }> {
  const admins = await prisma.user.findMany({
    where: { homeId, role: Role.ADMIN },
    select: { id: true, username: true, email: true },
    orderBy: { id: 'asc' },
  });
  if (admins.length !== 1) {
    throw new Error('Homeowner configuration error. Please contact support.');
  }
  const email = admins[0]?.email?.trim();
  if (!email || !looksLikeEmail(email)) {
    throw new Error('Homeowner email is missing. Please contact support.');
  }
  return { id: admins[0].id, username: admins[0].username, email };
}

function generateApprovalToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashSha256(raw) };
}

export async function createRoomAccessRequestEmails(args: {
  requestId: string;
  homeId: number;
  roomDisplayName: string;
  requestedName: string;
  requestedEmail: string;
  requestedPhoneNumber?: string | null;
}) {
  const homeowner = await resolveSingleHomeownerAdmin(args.homeId);
  const propertyManagerEmail = await getPropertyManagerEmail(args.homeId);
  const rawRecipients = [homeowner.email, propertyManagerEmail].filter(
    (email): email is string => typeof email === 'string' && email.trim().length > 0
  );
  const recipients = Array.from(
    new Map(
      rawRecipients.map((email) => [email.toLowerCase(), email])
    ).values()
  );

  if (recipients.length === 0) {
    throw new Error('No homeowner email found for this home.');
  }

  const appUrl = getAppUrl().replace(/\/$/, '');
  const now = Date.now();
  const expiresAt = new Date(now + APPROVAL_TTL_DAYS * 24 * 60 * 60 * 1000);

  const createdTokens: Array<{ recipientEmail: string; approveRaw: string; rejectRaw: string }> = [];

  await prisma.$transaction(async (tx) => {
    for (const recipientEmail of recipients) {
      const approve = generateApprovalToken();
      const reject = generateApprovalToken();
      await tx.roomAccessApprovalToken.createMany({
        data: [
          {
            requestId: args.requestId,
            kind: RoomAccessApprovalKind.APPROVE,
            recipientEmail,
            tokenHash: approve.hash,
            expiresAt,
          },
          {
            requestId: args.requestId,
            kind: RoomAccessApprovalKind.REJECT,
            recipientEmail,
            tokenHash: reject.hash,
            expiresAt,
          },
        ],
      });
      createdTokens.push({ recipientEmail, approveRaw: approve.raw, rejectRaw: reject.raw });
    }
  });

  const emailPayloads = createdTokens.map((entry) => {
    // Send recipients to a safe, side-effect-free preview page first. The final approve/reject
    // action is performed via POST from the browser.
    const approveUrl = `${appUrl}/rooms/requests/approve?token=${encodeURIComponent(entry.approveRaw)}`;
    const rejectUrl = `${appUrl}/rooms/requests/reject?token=${encodeURIComponent(entry.rejectRaw)}`;
    const content = buildRoomAccessRequestEmail({
      appUrl,
      approveUrl,
      rejectUrl,
      requestedName: args.requestedName,
      requestedEmail: args.requestedEmail,
      requestedPhoneNumber: args.requestedPhoneNumber ?? null,
      roomDisplayName: args.roomDisplayName,
    });
    return { to: entry.recipientEmail, content };
  });

  for (const payload of emailPayloads) {
    await sendEmail({
      to: payload.to,
      subject: payload.content.subject,
      html: payload.content.html,
      text: payload.content.text,
      replyTo: 'niveditgupta@dinodiasmartliving.com',
    });
  }

  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.ROOM_ACCESS_REQUESTED,
      homeId: args.homeId,
      actorUserId: null,
      metadata: {
        requestId: args.requestId,
        requestedName: args.requestedName,
        requestedEmail: args.requestedEmail,
        requestedPhoneNumber: args.requestedPhoneNumber ?? null,
        room: args.roomDisplayName,
        recipients,
        expiresAt: expiresAt.toISOString(),
      },
    },
  });

  return { recipients, expiresAt };
}

export async function approveOrRejectRoomAccessByToken(args: { tokenRaw: string; kind: RoomAccessApprovalKind }) {
  const tokenHash = hashSha256(args.tokenRaw);
  const now = new Date();

  const tokenRow = await prisma.roomAccessApprovalToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      kind: true,
      recipientEmail: true,
      consumedAt: true,
      expiresAt: true,
      requestId: true,
      request: {
        select: {
          id: true,
          status: true,
          resolvedAt: true,
          requestedName: true,
          requestedEmail: true,
          tenantUserId: true,
          hubInstallId: true,
          roomId: true,
          homeIdSnapshot: true,
          room: { select: { displayName: true, haAreaName: true } },
          hubInstall: { select: { homeId: true } },
        },
      },
    },
  });

  if (!tokenRow) return { ok: false as const, reason: 'NOT_FOUND' as const };
  if (tokenRow.kind !== args.kind) return { ok: false as const, reason: 'NOT_FOUND' as const };
  if (tokenRow.consumedAt) return { ok: false as const, reason: 'CONSUMED' as const };
  if (tokenRow.expiresAt < now) return { ok: false as const, reason: 'EXPIRED' as const };

  const homeId = tokenRow.request.hubInstall.homeId;
  if (!homeId) return { ok: false as const, reason: 'HOME_MISSING' as const };

  const home = await prisma.home.findUnique({ where: { id: homeId }, select: { status: true } });
  if (!home || home.status === HomeStatus.UNCLAIMED) return { ok: false as const, reason: 'HOME_UNCLAIMED' as const };

  // Ensure single homeowner exists before performing any irreversible action.
  await resolveSingleHomeownerAdmin(homeId);

  const result = await prisma.$transaction(async (tx) => {
    const freshToken = await tx.roomAccessApprovalToken.findUnique({
      where: { id: tokenRow.id },
      select: { id: true, consumedAt: true, expiresAt: true },
    });
    if (!freshToken) return { ok: false as const, reason: 'NOT_FOUND' as const };
    if (freshToken.consumedAt) return { ok: false as const, reason: 'CONSUMED' as const };
    if (freshToken.expiresAt < now) return { ok: false as const, reason: 'EXPIRED' as const };

    const request = await tx.roomAccessRequest.findUnique({
      where: { id: tokenRow.requestId },
      include: {
        room: { select: { displayName: true, haAreaName: true } },
        hubInstall: { select: { homeId: true } },
        approvalTokens: { select: { id: true } },
      },
    });
    if (!request) return { ok: false as const, reason: 'NOT_FOUND' as const };
    if (request.status !== RoomAccessRequestStatus.PENDING) {
      await tx.roomAccessApprovalToken.update({ where: { id: tokenRow.id }, data: { consumedAt: now } });
      return { ok: false as const, reason: 'ALREADY_HANDLED' as const, status: request.status };
    }

    const decisionStatus =
      args.kind === RoomAccessApprovalKind.APPROVE
        ? RoomAccessRequestStatus.APPROVED
        : RoomAccessRequestStatus.REJECTED;

    const updatedRequest = await tx.roomAccessRequest.update({
      where: { id: request.id },
      data: { status: decisionStatus, resolvedAt: now },
      select: {
        id: true,
        requestedName: true,
        requestedEmail: true,
        requestedPhoneNumber: true,
        tenantUserId: true,
        room: { select: { displayName: true, haAreaName: true } },
        hubInstall: { select: { homeId: true, home: { select: { haConnectionId: true } } } },
      },
    });

    // Consume all tokens for this request (first decision wins)
    await tx.roomAccessApprovalToken.updateMany({
      where: { requestId: request.id, consumedAt: null },
      data: { consumedAt: now },
    });

    if (decisionStatus === RoomAccessRequestStatus.REJECTED) {
      return { ok: true as const, decision: 'REJECTED' as const, request: updatedRequest, tempPassword: null, username: null };
    }

    const homeIdForTenant = updatedRequest.hubInstall.homeId;
    if (!homeIdForTenant) {
      throw new Error('Home missing.');
    }
    const haConnectionId = updatedRequest.hubInstall.home?.haConnectionId;
    if (!haConnectionId) {
      throw new Error('Dinodia Hub connection isn’t set up yet for this home.');
    }

    let tenantUserId = updatedRequest.tenantUserId;
    let username: string | null = null;
    let tempPassword: string | null = null;

    if (!tenantUserId) {
      const requestedEmailNormalized = updatedRequest.requestedEmail.trim();
      const requestedPhoneNumber = (updatedRequest.requestedPhoneNumber ?? '').trim() || null;
      if (!requestedPhoneNumber) {
        throw new Error('Tenant phone number is missing for this room access request.');
      }

      // Defensive: public scan flow should block if a tenant already exists for this email, but
      // older requests may still exist. In that case, do NOT create a second tenant—attach to
      // the existing tenant if and only if it belongs to this home.
      const existingTenant = await tx.user.findFirst({
        where: {
          role: Role.TENANT,
          OR: [
            { email: { equals: requestedEmailNormalized, mode: 'insensitive' } },
            { emailPending: { equals: requestedEmailNormalized, mode: 'insensitive' } },
          ],
        },
        select: { id: true, homeId: true, phoneNumber: true },
      });

      if (existingTenant) {
        if (existingTenant.homeId !== homeIdForTenant) {
          throw new Error('This email is already linked to a tenant account for a different home.');
        }
        tenantUserId = existingTenant.id;
        await tx.roomAccessRequest.update({
          where: { id: updatedRequest.id },
          data: { tenantUserId },
        });
        if (!existingTenant.phoneNumber) {
          const phoneConflict = await tx.user.findFirst({
            where: { role: Role.TENANT, phoneNumber: requestedPhoneNumber, id: { not: existingTenant.id } },
            select: { id: true },
          });
          if (phoneConflict) {
            throw new Error('This phone number is already linked to a tenant account for a different user.');
          }
          await tx.user.update({
            where: { id: existingTenant.id },
            data: { phoneNumber: requestedPhoneNumber },
          });
        }
      } else {
        username = await generateUniqueUsername({
          requestedName: updatedRequest.requestedName,
          requestedEmail: requestedEmailNormalized,
        });
        tempPassword = generateTemporaryPassword();
        const passwordHash = await hashPassword(tempPassword);

        const tenant = await tx.user.create({
          data: {
            username,
            passwordHash,
            mustChangePassword: true,
            role: Role.TENANT,
            homeId: homeIdForTenant,
            haConnectionId,
            emailPending: requestedEmailNormalized,
            emailVerifiedAt: null,
            email2faEnabled: false,
            phoneNumber: requestedPhoneNumber,
          },
          select: { id: true },
        });
        tenantUserId = tenant.id;
        await tx.roomAccessRequest.update({
          where: { id: updatedRequest.id },
          data: { tenantUserId },
        });
      }
    }

    await tx.accessRule.createMany({
      data: [{ userId: tenantUserId, area: updatedRequest.room.haAreaName }],
      skipDuplicates: true,
    });

    return { ok: true as const, decision: 'APPROVED' as const, request: updatedRequest, tempPassword, username };
  });

  if (!result.ok) return result;

  const roomName = result.request.room.displayName;
  const requestedEmail = result.request.requestedEmail.trim();
  const appUrl = getAppUrl();

  if (result.decision === 'APPROVED' && result.username && result.tempPassword) {
    const content = buildTenantWelcomeEmail({
      appUrl,
      username: result.username,
      tempPassword: result.tempPassword,
      roomDisplayName: roomName,
    });
    await sendEmail({
      to: requestedEmail,
      subject: content.subject,
      html: content.html,
      text: content.text,
      replyTo: 'niveditgupta@dinodiasmartliving.com',
    });
  }

  await prisma.auditEvent.create({
    data: {
      type: result.decision === 'APPROVED' ? AuditEventType.ROOM_ACCESS_APPROVED : AuditEventType.ROOM_ACCESS_REJECTED,
      homeId,
      actorUserId: null,
      metadata: {
        requestId: result.request.id,
        decision: result.decision,
        room: roomName,
        requestedEmail,
        recipientEmail: tokenRow.recipientEmail,
        decidedAt: now.toISOString(),
      },
    },
  });

  const decisionContent = buildRoomAccessDecisionEmail({
    status: result.decision,
    roomDisplayName: roomName,
  });

  return { ok: true as const, decision: result.decision, message: decisionContent.message };
}

export async function clearHomePropertyManagerContacts(homeId: number) {
  await prisma.homeContact.deleteMany({ where: { homeId, type: HomeContactType.PROPERTY_MANAGER } });
}

export type RoomAccessDecisionPreviewStatus =
  | 'ACTIONABLE'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'CONSUMED'
  | 'ALREADY_HANDLED'
  | 'HOME_MISSING'
  | 'HOME_UNCLAIMED';

export type RoomAccessDecisionPreview = {
  status: RoomAccessDecisionPreviewStatus;
  kind: RoomAccessApprovalKind;
  roomDisplayName: string | null;
  requestedName: string | null;
  requestedEmail: string | null;
  requestedPhoneNumber: string | null;
  requestStatus: RoomAccessRequestStatus | null;
  expiresAt: string | null;
  consumedAt: string | null;
};

export async function previewRoomAccessDecisionByToken(args: { tokenRaw: string; kind: RoomAccessApprovalKind }): Promise<RoomAccessDecisionPreview> {
  const tokenHash = hashSha256(args.tokenRaw);
  const now = new Date();

  const tokenRow = await prisma.roomAccessApprovalToken.findUnique({
    where: { tokenHash },
    select: {
      kind: true,
      consumedAt: true,
      expiresAt: true,
      request: {
        select: {
          status: true,
          requestedName: true,
          requestedEmail: true,
          requestedPhoneNumber: true,
          room: { select: { displayName: true } },
          hubInstall: { select: { homeId: true } },
        },
      },
    },
  });

  if (!tokenRow) {
    return {
      status: 'NOT_FOUND',
      kind: args.kind,
      roomDisplayName: null,
      requestedName: null,
      requestedEmail: null,
      requestedPhoneNumber: null,
      requestStatus: null,
      expiresAt: null,
      consumedAt: null,
    };
  }

  if (tokenRow.kind !== args.kind) {
    return {
      status: 'NOT_FOUND',
      kind: args.kind,
      roomDisplayName: null,
      requestedName: null,
      requestedEmail: null,
      requestedPhoneNumber: null,
      requestStatus: null,
      expiresAt: null,
      consumedAt: null,
    };
  }

  const homeId = tokenRow.request.hubInstall.homeId;
  if (!homeId) {
    return {
      status: 'HOME_MISSING',
      kind: args.kind,
      roomDisplayName: tokenRow.request.room.displayName,
      requestedName: tokenRow.request.requestedName,
      requestedEmail: tokenRow.request.requestedEmail,
      requestedPhoneNumber: tokenRow.request.requestedPhoneNumber ?? null,
      requestStatus: tokenRow.request.status,
      expiresAt: tokenRow.expiresAt.toISOString(),
      consumedAt: tokenRow.consumedAt?.toISOString() ?? null,
    };
  }

  const home = await prisma.home.findUnique({ where: { id: homeId }, select: { status: true } });
  if (!home || home.status === HomeStatus.UNCLAIMED) {
    return {
      status: 'HOME_UNCLAIMED',
      kind: args.kind,
      roomDisplayName: tokenRow.request.room.displayName,
      requestedName: tokenRow.request.requestedName,
      requestedEmail: tokenRow.request.requestedEmail,
      requestedPhoneNumber: tokenRow.request.requestedPhoneNumber ?? null,
      requestStatus: tokenRow.request.status,
      expiresAt: tokenRow.expiresAt.toISOString(),
      consumedAt: tokenRow.consumedAt?.toISOString() ?? null,
    };
  }

  if (tokenRow.expiresAt < now) {
    return {
      status: 'EXPIRED',
      kind: args.kind,
      roomDisplayName: tokenRow.request.room.displayName,
      requestedName: tokenRow.request.requestedName,
      requestedEmail: tokenRow.request.requestedEmail,
      requestedPhoneNumber: tokenRow.request.requestedPhoneNumber ?? null,
      requestStatus: tokenRow.request.status,
      expiresAt: tokenRow.expiresAt.toISOString(),
      consumedAt: tokenRow.consumedAt?.toISOString() ?? null,
    };
  }

  if (tokenRow.consumedAt) {
    return {
      status: 'CONSUMED',
      kind: args.kind,
      roomDisplayName: tokenRow.request.room.displayName,
      requestedName: tokenRow.request.requestedName,
      requestedEmail: tokenRow.request.requestedEmail,
      requestedPhoneNumber: tokenRow.request.requestedPhoneNumber ?? null,
      requestStatus: tokenRow.request.status,
      expiresAt: tokenRow.expiresAt.toISOString(),
      consumedAt: tokenRow.consumedAt.toISOString(),
    };
  }

  if (tokenRow.request.status !== RoomAccessRequestStatus.PENDING) {
    return {
      status: 'ALREADY_HANDLED',
      kind: args.kind,
      roomDisplayName: tokenRow.request.room.displayName,
      requestedName: tokenRow.request.requestedName,
      requestedEmail: tokenRow.request.requestedEmail,
      requestedPhoneNumber: tokenRow.request.requestedPhoneNumber ?? null,
      requestStatus: tokenRow.request.status,
      expiresAt: tokenRow.expiresAt.toISOString(),
      consumedAt: null,
    };
  }

  return {
    status: 'ACTIONABLE',
    kind: args.kind,
    roomDisplayName: tokenRow.request.room.displayName,
    requestedName: tokenRow.request.requestedName,
    requestedEmail: tokenRow.request.requestedEmail,
    requestedPhoneNumber: tokenRow.request.requestedPhoneNumber ?? null,
    requestStatus: tokenRow.request.status,
    expiresAt: tokenRow.expiresAt.toISOString(),
    consumedAt: null,
  };
}
