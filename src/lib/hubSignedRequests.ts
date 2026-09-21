// Stage 1 canonical native hub request contract. It binds the request route,
// body, timestamp and nonce so a valid signature cannot be replayed elsewhere.
import crypto from 'node:crypto';

export function hashRequestBody(body: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? null), 'utf8').digest('hex');
}

export function canonicalHubRequest(input: { method: string; path: string; timestamp: number; nonce: string; bodyHash: string }) {
  return [input.method.toUpperCase(), input.path, String(input.timestamp), input.nonce, input.bodyHash].join('\n');
}

export function verifyHubRequestSignature(input: { method: string; path: string; timestamp: number; nonce: string; bodyHash: string; signature: string; publicKey: crypto.KeyObject; now?: number; maxSkewMs?: number }) {
  const now = input.now ?? Date.now();
  const maxSkewMs = Math.min(Math.max(input.maxSkewMs ?? 300_000, 1_000), 300_000);
  if (!Number.isFinite(input.timestamp) || Math.abs(now - input.timestamp) > maxSkewMs || !input.nonce || !input.signature) return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalHubRequest(input), 'utf8'), input.publicKey, Buffer.from(input.signature, 'base64url'));
  } catch { return false; }
}
