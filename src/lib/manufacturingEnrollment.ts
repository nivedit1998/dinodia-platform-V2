import crypto from 'node:crypto';
import { Stage1AuthError } from './stage1Auth';
import { parsePublicKeys, sha256 } from './stage1Crypto';

export type ManufacturingIdentityEnvelope = {
  serial: string;
  identityGeneration: number;
  publicKeyPem: string;
  encryptionPublicKeyPem: string;
  publicKeyFingerprint: string;
  encryptionKeyFingerprint: string;
  manufacturingRootSignature?: string;
  manufacturingSignature?: string;
};

/**
 * Canonical factory certificate payload.  Only stable manufacturing identity
 * material is signed by the offline manufacturing root.  Provisioning
 * attempt, BaseURL and expiry fields are deliberately excluded and are
 * authenticated separately by the hub for each attempt.
 */
export function stableManufacturingIdentityPayload(input: ManufacturingIdentityEnvelope): string {
  return JSON.stringify({
    serial: String(input.serial),
    identityGeneration: Number(input.identityGeneration),
    publicKeyPem: String(input.publicKeyPem),
    encryptionPublicKeyPem: String(input.encryptionPublicKeyPem),
    publicKeyFingerprint: String(input.publicKeyFingerprint),
    encryptionKeyFingerprint: String(input.encryptionKeyFingerprint),
  });
}

export function manufacturingIdentityPayload(input: ManufacturingIdentityEnvelope & Record<string, unknown>): string {
  return stableManufacturingIdentityPayload(input);
}

export function keyFingerprint(pem: string): string {
  return crypto.createHash('sha256').update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex');
}

export function validateManufacturingIdentity(input: ManufacturingIdentityEnvelope, rootPems = parsePublicKeys(process.env.MANUFACTURING_ROOT_PUBLIC_KEYS)): { serial: string; generation: number; signingKeyFingerprint: string; encryptionKeyFingerprint: string } {
  const serial = String(input.serial ?? '').trim();
  const generation = Number(input.identityGeneration);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(serial) || !Number.isInteger(generation) || generation < 1 || generation > 2 ** 31 - 1) throw new Stage1AuthError(400, 'manufacturing_identity_invalid', 'The manufacturing identity fields are invalid');
  if (!String(input.manufacturingRootSignature ?? input.manufacturingSignature ?? '') || rootPems.length === 0) throw new Stage1AuthError(503, 'manufacturing_root_unconfigured', 'The manufacturing trust root is not configured');
  let signing: crypto.KeyObject;
  let encryption: crypto.KeyObject;
  try {
    signing = crypto.createPublicKey(String(input.publicKeyPem));
    encryption = crypto.createPublicKey(String(input.encryptionPublicKeyPem));
  } catch { throw new Stage1AuthError(401, 'manufacturing_key_invalid', 'The manufacturing public keys are invalid'); }
  if (signing.asymmetricKeyType !== 'ed25519' || encryption.asymmetricKeyType !== 'x25519') throw new Stage1AuthError(401, 'manufacturing_key_type_invalid', 'The manufacturing identity must contain separate Ed25519 and X25519 keys');
  const signingKeyFingerprint = keyFingerprint(String(input.publicKeyPem));
  const encryptionKeyFingerprint = keyFingerprint(String(input.encryptionPublicKeyPem));
  if (String(input.publicKeyFingerprint) !== signingKeyFingerprint || String(input.encryptionKeyFingerprint) !== encryptionKeyFingerprint) throw new Stage1AuthError(401, 'manufacturing_fingerprint_invalid', 'The manufacturing key fingerprints do not match');
  const signature = Buffer.from(String(input.manufacturingRootSignature ?? input.manufacturingSignature), 'base64url');
  const payload = Buffer.from(manufacturingIdentityPayload(input), 'utf8');
  if (!rootPems.some((key) => { try { return crypto.verify(null, payload, key, signature); } catch { return false; } })) throw new Stage1AuthError(401, 'manufacturing_root_signature_invalid', 'The manufacturing identity is not signed by Dinodia manufacturing trust');
  return { serial, generation, signingKeyFingerprint, encryptionKeyFingerprint };
}

export function enrollmentFingerprint(input: ManufacturingIdentityEnvelope): string {
  return sha256(`${String(input.serial)}:${Number(input.identityGeneration)}:${String(input.publicKeyFingerprint)}:${String(input.encryptionKeyFingerprint)}`);
}
