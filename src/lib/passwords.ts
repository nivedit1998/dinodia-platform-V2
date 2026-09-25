import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function hashPassword(password: string): string {
  if (!password || password.length < 12) throw new Error('Password must contain at least 12 characters');
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 32 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = String(encoded ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every(Number.isSafeInteger) || n < 1024 || n > 262144 || r < 1 || r > 32 || p < 1 || p > 8) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
