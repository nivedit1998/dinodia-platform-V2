import crypto from 'node:crypto';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function targetDigest(targetIds: string[]): string {
  return crypto.createHash('sha256').update(canonical([...new Set(targetIds.map(String))].sort()), 'utf8').digest('hex');
}

export function descriptorBoundValue(value: unknown, descriptorDigests: Record<string, string | null> = {}): unknown {
  const ordered = Object.fromEntries(Object.entries(descriptorDigests).sort(([left], [right]) => left.localeCompare(right)).map(([id, digest]) => [String(id), digest == null ? null : String(digest)]));
  return { requestedValue: value ?? null, descriptorDigests: ordered };
}

export function operationDigest(input: { operationKind?: string; operation?: string; targetIds: string[]; value: unknown; customerAccountId?: string; actorId?: string; trustedDeviceId?: string; customerSessionId?: string; homeId?: string; membershipId?: string; hubInstallationId?: string; hubInstallId?: string }): string {
  return crypto.createHash('sha256').update(canonical({
    actorId: String(input.actorId ?? input.customerAccountId ?? ''),
    trustedDeviceId: String(input.trustedDeviceId ?? ''),
    customerSessionId: String(input.customerSessionId ?? ''),
    homeId: String(input.homeId ?? ''),
    membershipId: String(input.membershipId ?? ''),
    hubInstallId: String(input.hubInstallId ?? input.hubInstallationId ?? ''),
    operationKind: String(input.operationKind ?? input.operation ?? ''),
    targetIds: input.targetIds.map(String).sort(),
    value: input.value,
  }), 'utf8').digest('hex');
}

export const ALLOWED_OPERATIONS = new Set(['trusted_device_remove', 'support_ticket_close', 'support_access_approve', 'alexa_unlink', 'heating_sensitive_command', 'device_sensitive_command']);

function platformPrivateKey(): crypto.KeyObject {
  const pem = String(process.env.DINODIA_APP_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
  if (!pem) throw new Stage1AuthError(503, 'step_up_unconfigured', 'Step-up signing is not configured');
  try { return crypto.createPrivateKey(pem); } catch { throw new Stage1AuthError(503, 'step_up_unconfigured', 'Step-up signing is not configured'); }
}

function encoded(value: unknown): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }

function challengeMessage(input: { challengeId: string; nonce: string; operationDigest: string }): Buffer {
  return Buffer.from(`DINODIA_STEP_UP_CHALLENGE_V1\n${input.challengeId}\n${input.nonce}\n${input.operationDigest}`, 'utf8');
}

export function verifyTrustedDeviceAssertion(input: { publicKey: string; signature: string; nonce: string; challengeId: string; operationDigest: string }): void {
  if (!input.nonce || !input.signature || !input.challengeId || !input.operationDigest) throw new Stage1AuthError(403, 'step_up_assertion_invalid', 'A valid trusted-device confirmation is required');
  try {
    const key = crypto.createPublicKey(input.publicKey);
    if (!crypto.verify(null, challengeMessage(input), key, Buffer.from(input.signature, 'base64url'))) throw new Error('invalid signature');
  } catch { throw new Stage1AuthError(403, 'step_up_assertion_invalid', 'A valid trusted-device confirmation is required'); }
}

export async function issueStepUp(input: { customerAccountId: string; customerSessionId: string; trustedDeviceId: string; trustedDevicePublicKey: string; assertionSignature: string; assertionNonce: string; challengeId: string }) {
  const challenge = await prisma.stepUpChallenge.findUnique({ where: { id: input.challengeId } });
  const now = new Date();
  if (!challenge || challenge.customerAccountId !== input.customerAccountId || challenge.customerSessionId !== input.customerSessionId || challenge.trustedDeviceId !== input.trustedDeviceId || challenge.consumedAt || challenge.cancelledAt || challenge.expiresAt <= now) throw new Stage1AuthError(403, 'step_up_challenge_invalid', 'The trusted-device challenge is invalid or expired');
  if (crypto.createHash('sha256').update(input.assertionNonce, 'utf8').digest('hex') !== challenge.nonceHash) throw new Stage1AuthError(403, 'step_up_challenge_invalid', 'The trusted-device challenge nonce is invalid');
  verifyTrustedDeviceAssertion({ publicKey: input.trustedDevicePublicKey, signature: input.assertionSignature, nonce: input.assertionNonce, challengeId: challenge.id, operationDigest: challenge.normalizedValueDigest });
  const consumed = await prisma.stepUpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, cancelledAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
  if (consumed.count !== 1) throw new Stage1AuthError(403, 'step_up_challenge_replayed', 'The trusted-device challenge has already been consumed');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const unsigned = { jti: crypto.randomUUID(), actorId: input.customerAccountId, trustedDeviceId: input.trustedDeviceId, customerSessionId: input.customerSessionId, homeId: challenge.homeId, membershipId: challenge.membershipId, hubInstallId: challenge.hubInstallationId, operationDigest: challenge.normalizedValueDigest, issuedAt: nowSeconds, expiresAt: nowSeconds + 60 };
  const signingInput = encoded(unsigned);
  const proof = `${signingInput}.${crypto.sign(null, Buffer.from(signingInput, 'utf8'), platformPrivateKey()).toString('base64url')}`;
  const expiresAt = new Date((nowSeconds + 60) * 1000);
  const row = await prisma.stepUpAuthorization.create({ data: { customerAccountId: input.customerAccountId, customerSessionId: input.customerSessionId, trustedDeviceId: input.trustedDeviceId, homeId: challenge.homeId, membershipId: challenge.membershipId, operationKind: challenge.operationKind, targetDigest: challenge.targetDigest, normalizedValueDigest: challenge.normalizedValueDigest, policyRevision: challenge.policyRevision, nonceHash: crypto.createHash('sha256').update(proof).digest('hex'), issuedAt: now, expiresAt }, select: { id: true, expiresAt: true } });
  return { proof, proofId: row.id, expiresAt: row.expiresAt };
}

export async function consumeStepUp(input: { proof: string; customerAccountId: string; customerSessionId?: string; trustedDeviceId?: string; homeId: string; membershipId: string; operationKind: string; targetIds: string[]; value: unknown; policyRevision: number }) {
  const now = new Date();
  const nonceHash = crypto.createHash('sha256').update(input.proof).digest('hex');
  const digest = operationDigest(input);
  const targetDigestValue = targetDigest(input.targetIds);
  const updated = await prisma.stepUpAuthorization.updateMany({ where: { nonceHash, customerAccountId: input.customerAccountId, customerSessionId: input.customerSessionId, trustedDeviceId: input.trustedDeviceId, homeId: input.homeId, membershipId: input.membershipId, operationKind: input.operationKind, targetDigest: targetDigestValue, normalizedValueDigest: digest, policyRevision: input.policyRevision, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
  if (updated.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'The operation confirmation is invalid, expired, replayed or does not match the requested operation');
  return { ok: true };
}
