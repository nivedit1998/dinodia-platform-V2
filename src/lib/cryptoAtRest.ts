// Architecture: Shared platform helper src/lib/cryptoAtRest.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import crypto from 'crypto';

function getKey(): Buffer {
  const raw = process.env.PLATFORM_DATA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('PLATFORM_DATA_ENCRYPTION_KEY is not configured');
  }
  const buf = Buffer.from(raw, raw.length === 44 ? 'base64' : 'utf8');
  if (buf.length !== 32) {
    throw new Error('PLATFORM_DATA_ENCRYPTION_KEY must be 32 bytes (base64 recommended)');
  }
  return buf;
}

export function hasDataEncryptionKey(): boolean {
  return Boolean(process.env.PLATFORM_DATA_ENCRYPTION_KEY);
}

export function encryptAtRest(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptAtRest(ciphertextB64: string): string {
  const key = getKey();
  const buf = Buffer.from(ciphertextB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return plaintext;
}
