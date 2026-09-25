import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { randomSecret, sha256 } from './stage1Crypto';

export const OPERATOR_ROTATION_MS = 60 * 60 * 1000;
export const OPERATOR_GRACE_MS = 20 * 60 * 1000;

export function encryptToHubKey(value: string, encryptionPublicKeyPem: string, purpose: string, version: number): Record<string, string | number> {
  const recipient = crypto.createPublicKey(encryptionPublicKeyPem);
  if (recipient.asymmetricKeyType !== 'x25519') throw new Error('The hub encryption identity is not X25519');
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(`dinodia-os-${purpose}`), Buffer.from(String(version)), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version,
    algorithm: 'x25519-hkdf-sha256/aes-256-gcm',
    purpose,
    ephemeralPublicKeyPem: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function encryptPlatformEnvelope(value: string): Record<string, string> {
  const configured = String(process.env.PLATFORM_DATA_ENCRYPTION_KEY ?? '');
  if (!configured) throw new Error('PLATFORM_DATA_ENCRYPTION_KEY is required');
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new Error('PLATFORM_DATA_ENCRYPTION_KEY must decode to 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { version: '1', algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export async function createPendingOperatorCredential(hubInstallationId: string, version: number): Promise<{ id: string; version: number; state: string }> {
  const secret = `dno_ops_${randomSecret(32)}`;
  const installation = await prisma.hubInstallation.findUnique({ where: { id: hubInstallationId }, select: { manufacturingIdentity: { select: { encryptionPublicKey: true } } } });
  if (!installation) throw new Error('hub identity not found');
  try {
    const row = await prisma.hubCredentialVersion.create({ data: { hubInstallationId, version, purpose: 'operator-credential', state: 'PENDING', tokenHash: sha256(secret), ciphertextKeyVersion: 1, encryptedDeliveryEnvelope: encryptToHubKey(secret, installation.manufacturingIdentity.encryptionPublicKey, 'operator-credential', version), deliveryAttempts: 0 } });
    return { id: row.id, version: row.version, state: row.state };
  } catch (error) {
    // Two native-operations invocations may observe the same due active
    // credential. The unique (hub, version) constraint is the durable
    // idempotency boundary; return the already-created pending row instead of
    // failing the whole shared dispatcher run.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const existing = await prisma.hubCredentialVersion.findUnique({ where: { HubCredentialVersion_hub_purpose_version_key: { hubInstallationId, purpose: 'operator-credential', version } }, select: { id: true, version: true, state: true, purpose: true } });
    if (!existing || existing.purpose !== 'operator-credential') throw error;
    return { id: existing.id, version: existing.version, state: existing.state };
  }
}

export async function acknowledgeOperatorCredential(hubInstallationId: string, version: number, fingerprint: string): Promise<void> {
  const row = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId, version, purpose: 'operator-credential' } });
  if (!row || !row.encryptedDeliveryEnvelope) throw new Error('credential version not found');
  if (fingerprint !== row.tokenHash) throw new Error('credential acknowledgement fingerprint mismatch');
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.hubCredentialVersion.updateMany({ where: { id: row.id, state: { in: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED'] } }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: now } });
    if (updated.count !== 1) throw new Error('credential acknowledgement race');
    await tx.hubCredentialVersion.updateMany({ where: { hubInstallationId, purpose: 'operator-credential', state: 'ACTIVE' }, data: { state: 'GRACE', graceUntil: new Date(now.getTime() + OPERATOR_GRACE_MS) } });
    await tx.hubCredentialVersion.update({ where: { id: row.id }, data: { state: 'ACTIVE', activatedAt: now } });
    await tx.hubInstallation.update({ where: { id: hubInstallationId }, data: { currentOperatorCredentialVersion: version } });
  });
}

export async function revokeOperatorCredentials(hubInstallationId: string, reason: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.hubCredentialVersion.updateMany({ where: { hubInstallationId, purpose: 'operator-credential', state: { in: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'ACTIVE', 'GRACE'] } }, data: { state: 'REVOKED', revokedAt: new Date(), revokedReason: reason } });
    if (result.count) await tx.hubInstallation.update({ where: { id: hubInstallationId }, data: { currentOperatorCredentialVersion: null, accessPolicyRevision: { increment: 1 } } });
    return result.count;
  });
}

export async function reconcileCredentialLifecycle(now = new Date()): Promise<{ rotated: number; revoked: number }> {
  const active = await prisma.hubCredentialVersion.findMany({ where: { purpose: 'operator-credential', state: 'ACTIVE', issuedAt: { lte: new Date(now.getTime() - OPERATOR_ROTATION_MS) } }, select: { hubInstallationId: true, version: true } });
  let rotated = 0;
  for (const current of active) {
    const latest = await prisma.hubCredentialVersion.aggregate({ where: { hubInstallationId: current.hubInstallationId, purpose: 'operator-credential' }, _max: { version: true } });
    const next = Number(latest._max.version ?? current.version) + 1;
    const pending = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: current.hubInstallationId, purpose: 'operator-credential', state: { in: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED'] } }, select: { id: true } });
    if (!pending) { await createPendingOperatorCredential(current.hubInstallationId, next); rotated += 1; }
  }
  const expired = await prisma.hubCredentialVersion.updateMany({ where: { purpose: 'operator-credential', state: 'GRACE', graceUntil: { lte: now } }, data: { state: 'REVOKED', revokedAt: now, revokedReason: 'grace_expired' } });
  return { rotated, revoked: expired.count };
}
