import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';

const inputFile = process.env.MANUFACTURING_ENROLLMENT_FILE;
if (!inputFile) throw new Error('MANUFACTURING_ENROLLMENT_FILE is required');
const environment = String(process.env.V2_ENVIRONMENT || 'local').trim().toLowerCase();
const projectRef = String(process.env.SUPABASE_PROJECT_REF || '').trim();
const productionConfirmation = String(process.env.MANUFACTURING_ENROLLMENT_CONFIRMATION || '').trim();
if (environment === 'production' && (projectRef !== 'fppzzesvukjbsfmxmfxe' || productionConfirmation !== 'DINODIA_NATIVE_V2_PRODUCTION_ENROLL')) {
  throw new Error('Production manufacturing enrollment requires the exact authorised V2 project and explicit confirmation');
}
if (!['local', 'rc', 'production'].includes(environment)) throw new Error('Unsupported manufacturing enrollment environment');
function assertDatabaseTarget() {
  if (!['rc', 'production'].includes(environment)) return;
  if (!projectRef) throw new Error('Remote manufacturing enrollment requires SUPABASE_PROJECT_REF');
  const urls = [process.env.DATABASE_URL, process.env.DIRECT_URL].map((value) => String(value || '').trim());
  if (urls.some((value) => !value)) throw new Error('Remote manufacturing enrollment requires DATABASE_URL and DIRECT_URL');
  let parsed;
  try { parsed = urls.map((value) => new URL(value)); } catch { throw new Error('Remote manufacturing enrollment database URLs are invalid'); }
  if (parsed.some((url) => !url.hostname || !url.hostname.includes(projectRef) && !url.username.includes(projectRef))) throw new Error('Remote manufacturing enrollment database target does not match the authorised V2 project');
  if (environment === 'production' && projectRef !== 'fppzzesvukjbsfmxmfxe') throw new Error('Production manufacturing enrollment target is not the authorised V2 project');
}
assertDatabaseTarget();
const fileStat = fs.lstatSync(inputFile);
if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('MANUFACTURING_ENROLLMENT_FILE must be a regular non-symlink file');
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const roots = String(process.env.MANUFACTURING_ROOT_PUBLIC_KEYS || '').replaceAll('\\n', '\n').match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) || [];
if (!roots.length) throw new Error('MANUFACTURING_ROOT_PUBLIC_KEYS is required');
const serial = String(input.serial || '').trim();
const generation = Number(input.identityGeneration);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(serial) || !Number.isInteger(generation) || generation < 1) throw new Error('Invalid serial or identity generation');
const signing = crypto.createPublicKey(String(input.publicKeyPem || ''));
const encryption = crypto.createPublicKey(String(input.encryptionPublicKeyPem || ''));
if (signing.asymmetricKeyType !== 'ed25519' || encryption.asymmetricKeyType !== 'x25519') throw new Error('The enrollment requires Ed25519 signing and X25519 encryption keys');
const fingerprint = (key) => crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
const signingKeyFingerprint = fingerprint(signing);
const encryptionKeyFingerprint = fingerprint(encryption);
const payload = JSON.stringify({ serial, identityGeneration: generation, publicKeyPem: String(input.publicKeyPem), encryptionPublicKeyPem: String(input.encryptionPublicKeyPem), publicKeyFingerprint: signingKeyFingerprint, encryptionKeyFingerprint });
const signature = Buffer.from(String(input.manufacturingRootSignature || input.manufacturingSignature || ''), 'base64url');
if (!roots.some((pem) => { try { return crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(pem), signature); } catch { return false; } })) throw new Error('Manufacturing root signature rejected');
if (environment === 'production') {
  const operatorKeys = String(process.env.MANUFACTURING_ENROLLMENT_OPERATOR_PUBLIC_KEYS || '').replaceAll('\\n', '\n').match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) || [];
  const operatorSignature = Buffer.from(String(input.operatorSignature || ''), 'base64url');
  const operatorPayload = JSON.stringify({ projectRef, serial, identityGeneration: generation, publicKeyFingerprint: signingKeyFingerprint, encryptionKeyFingerprint });
  if (!operatorKeys.length || !operatorSignature.length || !operatorKeys.some((pem) => { try { return crypto.verify(null, Buffer.from(operatorPayload), crypto.createPublicKey(pem), operatorSignature); } catch { return false; } })) throw new Error('Production manufacturing operator authorisation rejected');
}
const prisma = new PrismaClient();
try {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.hubManufacturingIdentity.findFirst({ where: { serialNumber: serial, identityGeneration: generation } });
    if (existing) {
      if (existing.signingKeyFingerprint !== signingKeyFingerprint || existing.encryptionKeyFingerprint !== encryptionKeyFingerprint) throw new Error('Serial and identity generation already belong to another key pair');
      if (existing.status !== 'ACTIVE') throw new Error('The identity generation is revoked');
      return { id: existing.id, serial, generation, idempotent: true };
    }
    const active = await tx.hubManufacturingIdentity.findMany({ where: { serialNumber: serial, status: 'ACTIVE' }, select: { id: true } });
    if (active.length) await tx.hubManufacturingIdentity.updateMany({ where: { id: { in: active.map((row) => row.id) } }, data: { status: 'REVOKED', revokedAt: new Date() } });
    const created = await tx.hubManufacturingIdentity.create({ data: { serialNumber: serial, identityGeneration: generation, signingPublicKey: String(input.publicKeyPem), encryptionPublicKey: String(input.encryptionPublicKeyPem), signingKeyFingerprint, encryptionKeyFingerprint, certificate: String(input.certificate || '') || null, status: 'ACTIVE' }, select: { id: true } });
    const installation = await tx.hubInstallation.findUnique({ where: { serialNumberSnapshot: serial }, select: { id: true, homeId: true } });
    if (installation) {
      await tx.hubInstallation.update({ where: { id: installation.id }, data: { manufacturingIdentityId: created.id, accessPolicyRevision: { increment: 1 }, updatedAt: new Date() } });
      await tx.homeClaimChallenge.updateMany({ where: { hubInstallationId: installation.id, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditEvent.create({ data: { homeId: installation.homeId, actorType: 'SYSTEM', actorId: null, category: 'SECURITY', action: 'hub_identity_generation_enrolled', targetType: 'HubManufacturingIdentity', targetId: created.id, metadata: { serial, generation, outcome: 'active_previous_generation_revoked', previousGenerationCount: active.length }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
    }
    return { id: created.id, serial, generation, idempotent: false };
  });
  console.log(JSON.stringify({ ok: true, ...result, signingKeyFingerprint, encryptionKeyFingerprint }));
} finally { await prisma.$disconnect(); }
