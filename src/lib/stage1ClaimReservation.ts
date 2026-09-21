import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const RESERVATION_TTL_MS = 30 * 60 * 1000;

function digest(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function token() {
  return crypto.randomBytes(32).toString('base64url');
}

function normaliseReference(value: string) {
  return value.trim();
}

type ClaimClient = typeof prisma | Prisma.TransactionClient;

type ReservationRecord = {
  id: string;
  hubInstallId: string;
  hubLabelReferenceHash: string;
  state: string;
  verifiedAccountId: number | null;
  reservedAt: Date | null;
  reservationExpiresAt: Date | null;
  claimedAt: Date | null;
  setupCheckpoint: Prisma.JsonValue | null;
  hubInstall: { serial: string; homeId: number | null };
};

function publicState(record: Pick<ReservationRecord, 'state' | 'reservationExpiresAt' | 'claimedAt'>, now: Date) {
  const reserved = record.state === 'RESERVED' && Boolean(record.reservationExpiresAt && record.reservationExpiresAt > now);
  return {
    available: record.state === 'AVAILABLE' || (record.state === 'RESERVED' && !reserved),
    reserved,
    claimed: record.state === 'CLAIMED',
    revoked: record.state === 'REVOKED',
    expiresAt: reserved ? record.reservationExpiresAt?.toISOString() ?? null : null,
    claimedAt: record.claimedAt?.toISOString() ?? null,
  };
}

async function findByReference(client: ClaimClient, reference: string) {
  return client.stage1ClaimReservation.findUnique({
    where: { hubLabelReferenceHash: digest(normaliseReference(reference)) },
    include: { hubInstall: { select: { serial: true, homeId: true } } },
  }) as Promise<ReservationRecord | null>;
}

export async function ensureStage1ClaimReservation(input: {
  hubInstallId: string;
  homeQrReference: string;
  now?: Date;
}) {
  const reference = normaliseReference(input.homeQrReference);
  if (!reference) throw new Error('home_qr_reference_required');
  const referenceHash = digest(reference);
  return prisma.$transaction(async (tx) => {
    const hub = await tx.hubInstall.findUnique({ where: { id: input.hubInstallId }, select: { id: true } });
    if (!hub) throw new Error('hub_install_not_found');
    const existing = await tx.stage1ClaimReservation.findUnique({ where: { hubLabelReferenceHash: referenceHash } });
    if (existing && existing.hubInstallId !== input.hubInstallId) throw new Error('home_qr_reference_conflict');
    return existing ?? tx.stage1ClaimReservation.create({
      data: {
        hubInstallId: input.hubInstallId,
        hubLabelReferenceHash: referenceHash,
        state: 'AVAILABLE',
      },
    });
  });
}

export async function resolveStage1Claim(input: { homeQrReference: string; serial: string; now?: Date }) {
  const now = input.now ?? new Date();
  const record = await findByReference(prisma, input.homeQrReference);
  // Keep the resolver deliberately generic. It never returns address, room,
  // device, account or membership information before an eligible claim.
  if (!record || record.hubInstall.serial !== input.serial.trim()) {
    return { ok: false as const, errorCode: 'claim_unavailable' as const };
  }
  const state = publicState(record, now);
  return { ok: true as const, state: state.available ? 'AVAILABLE' : record.state, requiresLiveHubChallenge: true, ...state };
}

export async function reserveStage1Claim(input: {
  homeQrReference: string;
  serial: string;
  accountId: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
  const reservationToken = token();
  const reservationTokenHash = digest(reservationToken);
  const referenceHash = digest(normaliseReference(input.homeQrReference));

  const result = await prisma.$transaction(async (tx) => {
    const record = await tx.stage1ClaimReservation.findUnique({
      where: { hubLabelReferenceHash: referenceHash },
      include: { hubInstall: { select: { serial: true } } },
    });
    if (!record || record.hubInstall.serial !== input.serial.trim()) return { kind: 'unavailable' as const };
    if (record.state === 'CLAIMED' || record.state === 'REVOKED') return { kind: 'unavailable' as const };
    if (record.state === 'RESERVED' && record.reservationExpiresAt && record.reservationExpiresAt > now) return { kind: 'busy' as const };

    const claimed = await tx.stage1ClaimReservation.updateMany({
      where: {
        id: record.id,
        state: { in: ['AVAILABLE', 'RESERVED'] },
        OR: [{ state: 'AVAILABLE' }, { reservationExpiresAt: { lte: now } }],
      },
      data: {
        state: 'RESERVED',
        reservationTokenHash,
        verifiedAccountId: input.accountId,
        reservedAt: now,
        reservationExpiresAt: expiresAt,
        releasedAt: null,
        claimedAt: null,
        setupCheckpoint: Prisma.JsonNull,
      },
    });
    if (claimed.count !== 1) return { kind: 'busy' as const };
    return { kind: 'reserved' as const, token: reservationToken, expiresAt };
  });

  if (result.kind !== 'reserved') return { ok: false as const, errorCode: result.kind };
  return { ok: true as const, reservationToken: result.token, expiresAt: result.expiresAt };
}

async function findActiveReservation(input: { reservationToken: string; accountId: number; now: Date }, tx: ClaimClient) {
  const reservationTokenHash = digest(input.reservationToken);
  return tx.stage1ClaimReservation.findFirst({
    where: {
      reservationTokenHash,
      verifiedAccountId: input.accountId,
      state: 'RESERVED',
      reservationExpiresAt: { gt: input.now },
    },
    select: { id: true, hubInstallId: true, state: true },
  });
}

export async function persistStage1SetupMutation(input: {
  reservationToken: string;
  accountId: number;
  mutation: string;
  checkpoint: Prisma.InputJsonValue;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
  if (!input.mutation.trim()) return { ok: false as const, errorCode: 'invalid_mutation' as const };
  const result = await prisma.$transaction(async (tx) => {
    const active = await findActiveReservation({ reservationToken: input.reservationToken, accountId: input.accountId, now }, tx);
    if (!active) return { count: 0 };
    return tx.stage1ClaimReservation.updateMany({
      where: { id: active.id, state: 'RESERVED', reservationTokenHash: digest(input.reservationToken), verifiedAccountId: input.accountId, reservationExpiresAt: { gt: now } },
      data: { setupCheckpoint: { mutation: input.mutation.trim().slice(0, 80), data: input.checkpoint }, reservationExpiresAt: expiresAt },
    });
  });
  return result.count === 1 ? { ok: true as const, expiresAt } : { ok: false as const, errorCode: 'reservation_invalid' as const };
}

export async function claimStage1Reservation(input: { reservationToken: string; accountId: number; now?: Date }) {
  const now = input.now ?? new Date();
  const result = await prisma.stage1ClaimReservation.updateMany({
    where: { reservationTokenHash: digest(input.reservationToken), verifiedAccountId: input.accountId, state: 'RESERVED', reservationExpiresAt: { gt: now } },
    data: { state: 'CLAIMED', claimedAt: now, reservationExpiresAt: null },
  });
  return result.count === 1
    ? { ok: true as const, stage3ActivationRequired: true }
    : { ok: false as const, errorCode: 'reservation_invalid' as const };
}

export async function releaseExpiredStage1Reservations(now = new Date()) {
  return prisma.stage1ClaimReservation.updateMany({
    where: { state: 'RESERVED', reservationExpiresAt: { lte: now } },
    data: { state: 'AVAILABLE', reservationTokenHash: null, verifiedAccountId: null, reservedAt: null, reservationExpiresAt: null, releasedAt: now, setupCheckpoint: Prisma.JsonNull },
  });
}

export async function releaseStage1Reservation(input: { homeQrReference: string; reason: string; actorUserId?: number; now?: Date }) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 256);
  if (!reason) return { ok: false as const, errorCode: 'reason_required' as const };
  return prisma.$transaction(async (tx) => {
    const record = await findByReference(tx, input.homeQrReference);
    if (!record || record.state !== 'RESERVED') return { ok: false as const, errorCode: 'reservation_not_releasable' as const };
    const released = await tx.stage1ClaimReservation.updateMany({
      where: { id: record.id, state: 'RESERVED' },
      data: { state: 'AVAILABLE', reservationTokenHash: null, verifiedAccountId: null, reservedAt: null, reservationExpiresAt: null, releasedAt: now, setupCheckpoint: Prisma.JsonNull },
    });
    if (released.count !== 1) return { ok: false as const, errorCode: 'reservation_not_releasable' as const };
    await tx.stage1ClaimAudit.create({ data: { reservationId: record.id, actorUserId: input.actorUserId, action: 'MANUAL_RELEASE', metadata: { stage: 'stage1', reason, releasedAt: now.toISOString() } } });
    return { ok: true as const };
  });
}

export { RESERVATION_TTL_MS };
