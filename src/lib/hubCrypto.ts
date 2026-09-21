// Architecture: Shared platform helper src/lib/hubCrypto.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import crypto from 'crypto';

const HMAC_MAX_SKEW_SECONDS = Number(process.env.HUB_HMAC_MAX_SKEW_SECONDS || 300);

function getKey(): Buffer {
  const raw = process.env.HUB_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('HUB_TOKEN_ENCRYPTION_KEY is not configured');
  const buf = Buffer.from(raw, raw.length === 44 ? 'base64' : 'utf8');
  if (buf.length !== 32) {
    throw new Error('HUB_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64 recommended)');
  }
  return buf;
}

export function hashSha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateRandomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(ciphertextB64: string): string {
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

export type HmacPayload = { serial: string; ts: number; nonce: string; sig: string };

export function verifyHmac(payload: HmacPayload, secret: string): void {
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(payload.ts - nowSec) > HMAC_MAX_SKEW_SECONDS) {
    throw new Error('Request timestamp outside allowed window');
  }
  const data = `${payload.serial}.${payload.ts}.${payload.nonce}`;
  const expected = crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(payload.sig))) {
    throw new Error('Invalid signature');
  }
}

export function jitterMs(baseMinutes: number): number {
  const ms = baseMinutes * 60 * 1000;
  const jitter = Math.floor(Math.random() * 60 * 1000);
  return ms + jitter;
}

export function getHmacMaxSkewSeconds(): number {
  return HMAC_MAX_SKEW_SECONDS;
}
