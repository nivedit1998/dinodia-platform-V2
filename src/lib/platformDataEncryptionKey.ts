import crypto from 'node:crypto';

export type PlatformDataEncryptionKeyFailureCode =
  | 'PLATFORM_ENCRYPTION_KEY_MISSING'
  | 'PLATFORM_ENCRYPTION_KEY_INVALID_ENCODING'
  | 'PLATFORM_ENCRYPTION_KEY_INVALID_SIZE';

/** A bounded, secret-free configuration failure for shared Platform crypto. */
export class PlatformDataEncryptionKeyError extends Error {
  readonly status = 503;
  readonly code = 'INTERNAL_ERROR';
  readonly failureCode: PlatformDataEncryptionKeyFailureCode;

  constructor(failureCode: PlatformDataEncryptionKeyFailureCode) {
    super('Secure Platform operations are temporarily unavailable');
    this.name = 'PlatformDataEncryptionKeyError';
    this.failureCode = failureCode;
  }
}

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode the single supported representation: canonical standard base64 for exactly 32 bytes. */
export function getPlatformDataEncryptionKey(configured: unknown = process.env.PLATFORM_DATA_ENCRYPTION_KEY): Buffer {
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new PlatformDataEncryptionKeyError('PLATFORM_ENCRYPTION_KEY_MISSING');
  }
  if (!CANONICAL_BASE64.test(configured)) {
    throw new PlatformDataEncryptionKeyError('PLATFORM_ENCRYPTION_KEY_INVALID_ENCODING');
  }
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32 || key.toString('base64') !== configured) {
    throw new PlatformDataEncryptionKeyError('PLATFORM_ENCRYPTION_KEY_INVALID_SIZE');
  }
  return key;
}

/** Stable, domain-separated APNs token lookup digest using the envelope key bytes. */
export function platformDataEncryptionTokenDigest(token: string): string {
  return crypto.createHmac('sha256', getPlatformDataEncryptionKey())
    .update('dinodia-v2-apns-token-v1\0').update(token).digest('hex');
}
