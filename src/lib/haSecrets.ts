// Architecture: Shared platform helper src/lib/haSecrets.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import crypto from 'crypto';
import { decryptAtRest, encryptAtRest } from './cryptoAtRest';

type HasHaSecrets = {
  haUsername?: string | null;
  haUsernameCiphertext?: string | null;
  haPassword?: string | null;
  haPasswordCiphertext?: string | null;
  longLivedToken?: string | null;
  longLivedTokenCiphertext?: string | null;
};

export function resolveHaLongLivedToken(record: HasHaSecrets): { longLivedToken: string } {
  const longLivedToken =
    (record.longLivedTokenCiphertext
      ? decryptAtRest(record.longLivedTokenCiphertext)
      : record.longLivedToken) ?? null;

  if (!longLivedToken) {
    throw new Error('Home Assistant long-lived token is missing.');
  }

  return { longLivedToken };
}

export function resolveHaUiCredentials(record: HasHaSecrets): {
  haUsername: string;
  haPassword: string;
} {
  const haUsername =
    (record.haUsernameCiphertext
      ? decryptAtRest(record.haUsernameCiphertext)
      : record.haUsername) ?? null;
  const haPassword =
    (record.haPasswordCiphertext
      ? decryptAtRest(record.haPasswordCiphertext)
      : record.haPassword) ?? null;

  if (!haUsername || !haPassword) {
    throw new Error('Home Assistant UI credentials are missing or incomplete.');
  }

  return { haUsername, haPassword };
}

export function buildEncryptedHaSecrets(input: {
  haUsername?: string;
  haPassword?: string;
  longLivedToken?: string;
}) {
  const data: {
    haUsername?: string | null;
    haUsernameCiphertext?: string | null;
    haPassword?: string | null;
    haPasswordCiphertext?: string | null;
    longLivedToken?: string | null;
    longLivedTokenCiphertext?: string | null;
  } = {};

  if (input.haUsername !== undefined) {
    data.haUsername = null;
    data.haUsernameCiphertext = input.haUsername ? encryptAtRest(input.haUsername) : null;
  }
  if (input.haPassword !== undefined) {
    data.haPassword = null;
    data.haPasswordCiphertext = input.haPassword ? encryptAtRest(input.haPassword) : null;
  }
  if (input.longLivedToken !== undefined) {
    data.longLivedToken = null;
    data.longLivedTokenCiphertext = input.longLivedToken
      ? encryptAtRest(input.longLivedToken)
      : null;
  }

  return data;
}

export function hashSecretForLookup(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}
