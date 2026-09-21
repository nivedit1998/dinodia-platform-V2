// Stage 1 manufacturing trust verifier. The private manufacturing root key
// stays outside the application; only the configured public-key set is read.
import crypto from 'node:crypto';

export type ManufacturingPairingEnvelope = {
  version: 1;
  serial: string;
  identityGeneration: number;
  attemptId: string;
  publicKeyPem: string;
  encryptionPublicKeyPem: string;
  publicKeyFingerprint: string;
  baseUrl: string;
  issuedAt: number;
  expiresAt: number;
  hubSignature: string;
  manufacturingSignature: string;
};

function canonicalEnvelope(input: Omit<ManufacturingPairingEnvelope, 'manufacturingSignature'>) {
  return JSON.stringify({
    version: input.version,
    serial: input.serial,
    identityGeneration: input.identityGeneration,
    attemptId: input.attemptId,
    publicKeyPem: input.publicKeyPem,
    encryptionPublicKeyPem: input.encryptionPublicKeyPem,
    publicKeyFingerprint: input.publicKeyFingerprint,
    baseUrl: input.baseUrl,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    hubSignature: input.hubSignature,
  });
}

function canonicalHubEnvelope(input: ManufacturingPairingEnvelope) {
  return JSON.stringify({
    version: input.version,
    serial: input.serial,
    attemptId: input.attemptId,
    publicKeyPem: input.publicKeyPem,
    encryptionPublicKeyPem: input.encryptionPublicKeyPem,
    publicKeyFingerprint: input.publicKeyFingerprint,
    baseUrl: input.baseUrl,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
}

export function verifyManufacturingEnvelope(envelope: ManufacturingPairingEnvelope, roots: crypto.KeyObject[], now = Date.now()) {
  if (envelope.version !== 1 || !envelope.serial || !envelope.attemptId || !Number.isInteger(envelope.identityGeneration) || envelope.identityGeneration < 1 || !envelope.publicKeyPem || !envelope.encryptionPublicKeyPem || !envelope.hubSignature || !envelope.manufacturingSignature) return false;
  if (!/^DINODIA-[A-Z0-9-]{4,64}$/i.test(String(envelope.serial)) || !/^https?:\/\//i.test(String(envelope.baseUrl || ''))) return false;
  try {
    const base = new URL(envelope.baseUrl);
    if (base.protocol !== 'http:' || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(base.hostname)) return false;
  } catch { return false; }
  if (envelope.issuedAt > now + 5_000) return false;
  if (!Number.isFinite(envelope.issuedAt) || !Number.isFinite(envelope.expiresAt) || envelope.expiresAt <= now || envelope.expiresAt - envelope.issuedAt > 15 * 60_000) return false;
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(envelope.publicKeyPem);
    const encryptionKey = crypto.createPublicKey(envelope.encryptionPublicKeyPem);
    if (encryptionKey.asymmetricKeyType !== 'x25519') return false;
  } catch { return false; }
  const fingerprint = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (fingerprint !== envelope.publicKeyFingerprint) return false;
  const payload = Buffer.from(canonicalEnvelope(envelope), 'utf8');
  let hubVerified = false;
  try { hubVerified = crypto.verify(null, Buffer.from(canonicalHubEnvelope(envelope), 'utf8'), publicKey, Buffer.from(envelope.hubSignature, 'base64url')); } catch { hubVerified = false; }
  if (!hubVerified) return false;
  return roots.some((root) => {
    try { return crypto.verify(null, payload, root, Buffer.from(envelope.manufacturingSignature, 'base64url')); } catch { return false; }
  });
}

export function parseManufacturingRoots(value = process.env.DINODIA_MANUFACTURING_ROOT_PUBLIC_KEYS || '') {
  const source = String(value || '').replaceAll('\\n', '\n').trim();
  const entries = source.includes('-----BEGIN')
    ? (source.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) || [])
    : source.split(/\n+|\s*,\s*/);
  return entries.map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    try { return crypto.createPublicKey(entry); } catch { return null; }
  }).filter((key): key is crypto.KeyObject => Boolean(key));
}
