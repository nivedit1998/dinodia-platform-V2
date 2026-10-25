import crypto from 'node:crypto';

/** The OS verifies the decoded canonical JSON bytes, not the JWT payload text. */
export function signStepUpPayload(payload: Record<string, unknown>, privateKey: crypto.KeyObject): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${bytes.toString('base64url')}.${crypto.sign(null, bytes, privateKey).toString('base64url')}`;
}
