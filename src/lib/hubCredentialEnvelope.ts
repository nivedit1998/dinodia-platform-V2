import crypto from 'node:crypto';

// The platform never sends an operator/machine credential in plaintext. The
// envelope is encrypted to the hub's factory-registered X25519 public key and
// can only be opened by the private key held in that hub's vault.
export function createHubEncryptedCredentialEnvelope(plaintext: string, hubEncryptionPublicKeyPem: string, version: number, purpose = 'operator-credential') {
  const hubPublicKey = crypto.createPublicKey(hubEncryptionPublicKeyPem);
  if (hubPublicKey.asymmetricKeyType !== 'x25519') throw new Error('Hub encryption identity is invalid');
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: hubPublicKey });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(`dinodia-os-${purpose}`), Buffer.from(String(version)), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    version,
    purpose,
    algorithm: 'x25519-hkdf-sha256/aes-256-gcm',
    ephemeralPublicKeyPem: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
