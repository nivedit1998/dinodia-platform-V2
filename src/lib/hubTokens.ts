// Architecture: cloud-side token lifecycle for Hub Agent pairing and sync.
// The /api/hub-agent/pair and /api/hub-agent/token-state routes use these helpers;
// the installed Hub Agent consumes only the signed/hashed protocol results. Plain
// tokens and bootstrap/sync secrets must never be placed in logs or client code.

import { HubTokenStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { decryptSecret, encryptSecret, generateRandomHex, hashSha256 } from './hubCrypto';

export function generateHubToken() {
  const plaintext = generateRandomHex(32);
  return {
    plaintext,
    hash: hashSha256(plaintext),
    ciphertext: encryptSecret(plaintext),
  };
}

export function encryptSyncSecret(secret: string): string {
  return encryptSecret(secret);
}

export function decryptSyncSecret(ciphertext: string): string {
  return decryptSecret(ciphertext);
}

export function encryptBootstrapSecret(secret: string): string {
  return encryptSecret(secret);
}

export function decryptBootstrapSecret(ciphertext: string): string {
  return decryptSecret(ciphertext);
}

export async function revokeExpiredGraceTokens(hubInstallId: string, now = new Date()) {
  await prisma.hubToken.updateMany({
    where: {
      hubInstallId,
      status: HubTokenStatus.GRACE,
      graceUntil: { lt: now },
    },
    data: { status: HubTokenStatus.REVOKED },
  });
}

export async function cleanupHubTokens(hubInstallId: string) {
  const tokens = await prisma.hubToken.findMany({
    where: { hubInstallId },
    select: {
      id: true,
      status: true,
      version: true,
      publishedAt: true,
      graceUntil: true,
      createdAt: true,
    },
  });

  if (tokens.length === 0) return;

  const pickLatest = <T extends (typeof tokens)[number]>(list: T[], compare: (a: T, b: T) => number) => {
    if (list.length === 0) return null;
    return list.slice().sort(compare)[0] ?? null;
  };

  const active = pickLatest(
    tokens.filter((t) => t.status === HubTokenStatus.ACTIVE),
    (a, b) => {
      const aPublished = a.publishedAt ? a.publishedAt.getTime() : -1;
      const bPublished = b.publishedAt ? b.publishedAt.getTime() : -1;
      if (aPublished !== bPublished) return bPublished - aPublished;
      if (a.version !== b.version) return b.version - a.version;
      return b.createdAt.getTime() - a.createdAt.getTime();
    }
  );

  const grace = pickLatest(
    tokens.filter((t) => t.status === HubTokenStatus.GRACE),
    (a, b) => {
      const aGrace = a.graceUntil ? a.graceUntil.getTime() : -1;
      const bGrace = b.graceUntil ? b.graceUntil.getTime() : -1;
      if (aGrace !== bGrace) return bGrace - aGrace;
      if (a.version !== b.version) return b.version - a.version;
      return b.createdAt.getTime() - a.createdAt.getTime();
    }
  );

  const pending = pickLatest(
    tokens.filter((t) => t.status === HubTokenStatus.PENDING),
    (a, b) => {
      if (a.version !== b.version) return b.version - a.version;
      return b.createdAt.getTime() - a.createdAt.getTime();
    }
  );

  const revoked = pickLatest(
    tokens.filter((t) => t.status === HubTokenStatus.REVOKED),
    (a, b) => {
      if (a.version !== b.version) return b.version - a.version;
      return b.createdAt.getTime() - a.createdAt.getTime();
    }
  );

  const keepIds = new Set<string>();
  if (active) keepIds.add(active.id);
  if (grace) keepIds.add(grace.id);
  if (pending) keepIds.add(pending.id);
  if (revoked) keepIds.add(revoked.id);

  if (keepIds.size === 0) return;

  await prisma.hubToken.deleteMany({
    where: {
      hubInstallId,
      id: { notIn: Array.from(keepIds) },
    },
  });
}

export async function getAcceptedTokenHashes(hubInstallId: string, now = new Date()) {
  const tokens = await prisma.hubToken.findMany({
    where: {
      hubInstallId,
      status: { in: [HubTokenStatus.ACTIVE, HubTokenStatus.PENDING, HubTokenStatus.GRACE] },
      OR: [{ graceUntil: null }, { graceUntil: { gt: now } }],
    },
    orderBy: { version: 'asc' },
    select: { tokenHash: true },
  });
  return tokens.map((t) => t.tokenHash);
}

export async function getLatestVersion(hubInstallId: string): Promise<number> {
  const latest = await prisma.hubToken.findFirst({
    where: { hubInstallId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return latest?.version ?? 0;
}

export async function publishPendingIfAcked(
  hubInstallId: string,
  pendingVersion: number,
  publishedVersion: number,
  graceMinutes: number
) {
  const now = new Date();
  const graceUntil = new Date(now.getTime() + graceMinutes * 60 * 1000);

  const pending = await prisma.hubToken.findFirst({
    where: { hubInstallId, version: pendingVersion, status: HubTokenStatus.PENDING },
  });
  if (!pending) return publishedVersion;

  const previous = await prisma.hubToken.findFirst({
    where: { hubInstallId, version: publishedVersion },
  });

  await prisma.$transaction(async (tx) => {
    if (previous) {
      await tx.hubToken.update({
        where: { id: previous.id },
        data: { status: HubTokenStatus.GRACE, graceUntil },
      });
    }
    await tx.hubToken.update({
      where: { id: pending.id },
      data: { status: HubTokenStatus.ACTIVE, publishedAt: now },
    });
    await tx.hubInstall.update({
      where: { id: hubInstallId },
      data: { publishedHubTokenVersion: pendingVersion },
    });
  });

  await cleanupHubTokens(hubInstallId);

  return pendingVersion;
}

export function decryptTokenPlaintext(ciphertext: string): string {
  return decryptSecret(ciphertext);
}

export async function getPublishedHubTokenPlaintext(
  hubInstallId: string,
  publishedVersion?: number | null
): Promise<string> {
  const version =
    typeof publishedVersion === 'number' && Number.isFinite(publishedVersion) && publishedVersion > 0
      ? publishedVersion
      : (
          await prisma.hubInstall.findUnique({
            where: { id: hubInstallId },
            select: { publishedHubTokenVersion: true },
          })
        )?.publishedHubTokenVersion ?? 0;

  if (!version || version <= 0) {
    throw new Error('No published hub token is available.');
  }

  const token = await prisma.hubToken.findFirst({
    where: { hubInstallId, version },
    select: { tokenCiphertext: true },
  });
  if (!token) throw new Error('Published hub token not found.');
  return decryptTokenPlaintext(token.tokenCiphertext);
}
