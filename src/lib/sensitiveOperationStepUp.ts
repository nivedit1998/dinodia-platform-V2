import crypto from 'node:crypto';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { signStepUpPayload } from './stepUpProofCodec';

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

export const ALLOWED_OPERATIONS = new Set(['trusted_device_remove', 'customer_password_change', 'customer_profile_change', 'customer_email_change', 'tenant_membership_remove', 'support_ticket_close', 'support_access_approve', 'support_access_revoke', 'alexa_unlink', 'heating_sensitive_command', 'device_sensitive_command']);

function platformPrivateKey(): crypto.KeyObject {
  const pem = String(process.env.DINODIA_APP_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
  if (!pem) throw new Stage1AuthError(503, 'step_up_unconfigured', 'Step-up signing is not configured');
  try { return crypto.createPrivateKey(pem); } catch { throw new Stage1AuthError(503, 'step_up_unconfigured', 'Step-up signing is not configured'); }
}

function challengeMessage(input: { challengeId: string; nonce: string; operationDigest: string }): Buffer {
  return Buffer.from(`DINODIA_STEP_UP_CHALLENGE_V1\n${input.challengeId}\n${input.nonce}\n${input.operationDigest}`, 'utf8');
}

export function verifyTrustedDeviceAssertion(input: { publicKey: string; signature: string; nonce: string; challengeId: string; operationDigest: string }): void {
  if (!input.nonce || !input.signature || !input.challengeId || !input.operationDigest) throw new Stage1AuthError(403, 'step_up_assertion_invalid', 'A valid trusted-device confirmation is required');
  try {
    const key = crypto.createPublicKey(input.publicKey);
    const signature = Buffer.from(input.signature, 'base64url');
    const valid = key.asymmetricKeyType === 'ed25519'
      ? crypto.verify(null, challengeMessage(input), key, signature)
      : key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
        ? crypto.verify('sha256', challengeMessage(input), key, signature)
        : false;
    if (!valid) throw new Error('invalid signature');
  } catch { throw new Stage1AuthError(403, 'step_up_assertion_invalid', 'A valid trusted-device confirmation is required'); }
}

export async function issueStepUp(input: { customerAccountId: string; customerSessionId: string; trustedDeviceId: string; trustedDevicePublicKey: string; expectedSecurityVersion?: number; expectedDeviceSessionVersion?: number; expectedRefreshTokenHash?: string; assertionSignature: string; assertionNonce: string; challengeId: string }) {
  const challenge = await prisma.stepUpChallenge.findUnique({ where: { id: input.challengeId } });
  const now = new Date();
  if (!challenge || challenge.customerAccountId !== input.customerAccountId || challenge.customerSessionId !== input.customerSessionId || challenge.trustedDeviceId !== input.trustedDeviceId || challenge.consumedAt || challenge.cancelledAt || challenge.expiresAt <= now) throw new Stage1AuthError(403, 'step_up_challenge_invalid', 'The trusted-device challenge is invalid or expired');
  if (crypto.createHash('sha256').update(input.assertionNonce, 'utf8').digest('hex') !== challenge.nonceHash) throw new Stage1AuthError(403, 'step_up_challenge_invalid', 'The trusted-device challenge nonce is invalid');
  verifyTrustedDeviceAssertion({ publicKey: input.trustedDevicePublicKey, signature: input.assertionSignature, nonce: input.assertionNonce, challengeId: challenge.id, operationDigest: challenge.normalizedValueDigest });
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${input.customerAccountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${input.customerSessionId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${input.trustedDeviceId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StepUpChallenge" WHERE "id" = ${challenge.id}::uuid FOR UPDATE`;
    const [current, account, session, device] = await Promise.all([
      tx.stepUpChallenge.findUnique({ where: { id: challenge.id } }),
      tx.customerAccount.findUnique({ where: { id: input.customerAccountId }, select: { status: true, securityVersion: true } }),
      tx.customerSession.findUnique({ where: { id: input.customerSessionId }, select: { customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
      tx.trustedDevice.findUnique({ where: { id: input.trustedDeviceId }, select: { customerAccountId: true, publicKey: true, sessionVersion: true, revokedAt: true } }),
    ]);
    const lockedAt = new Date();
    if (!account || account.status !== 'ACTIVE' || (input.expectedSecurityVersion !== undefined && account.securityVersion !== input.expectedSecurityVersion)
      || !session || session.customerAccountId !== input.customerAccountId || session.trustedDeviceId !== input.trustedDeviceId
      || (input.expectedRefreshTokenHash !== undefined && session.refreshTokenHash !== input.expectedRefreshTokenHash)
      || (input.expectedSecurityVersion !== undefined && session.securityVersion !== input.expectedSecurityVersion)
      || session.trustedDeviceSessionVersion !== device?.sessionVersion || (input.expectedDeviceSessionVersion !== undefined && session.trustedDeviceSessionVersion !== input.expectedDeviceSessionVersion) || session.revokedAt
      || session.expiresAt <= lockedAt || session.absoluteExpiresAt <= lockedAt
      || !device || device.customerAccountId !== input.customerAccountId || device.publicKey !== input.trustedDevicePublicKey
      || (input.expectedDeviceSessionVersion !== undefined && device.sessionVersion !== input.expectedDeviceSessionVersion) || device.revokedAt
      || !current || current.customerAccountId !== input.customerAccountId || current.customerSessionId !== input.customerSessionId
      || current.trustedDeviceId !== input.trustedDeviceId || current.operationKind !== challenge.operationKind
      || current.normalizedValueDigest !== challenge.normalizedValueDigest || current.targetDigest !== challenge.targetDigest
      || current.policyRevision !== challenge.policyRevision || current.consumedAt || current.cancelledAt || current.expiresAt <= lockedAt) {
      throw new Stage1AuthError(403, 'step_up_challenge_invalid', 'The trusted-device challenge is invalid, expired or no longer current');
    }
    const consumed = await tx.stepUpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, cancelledAt: null, expiresAt: { gt: lockedAt } }, data: { consumedAt: lockedAt } });
    if (consumed.count !== 1) throw new Stage1AuthError(403, 'step_up_challenge_replayed', 'The trusted-device challenge has already been consumed');
    const nowSeconds = Math.floor(lockedAt.getTime() / 1000);
    const unsigned = { jti: crypto.randomUUID(), actorId: input.customerAccountId, trustedDeviceId: input.trustedDeviceId, customerSessionId: input.customerSessionId, homeId: current.homeId, membershipId: current.membershipId, hubInstallId: current.hubInstallationId, operationDigest: current.normalizedValueDigest, issuedAt: nowSeconds, expiresAt: nowSeconds + 60 };
    const proof = signStepUpPayload(unsigned, platformPrivateKey());
    const authorizationExpiresAt = new Date(lockedAt.getTime() + 60_000);
    const row = await tx.stepUpAuthorization.create({ data: { customerAccountId: input.customerAccountId, customerSessionId: input.customerSessionId, trustedDeviceId: input.trustedDeviceId, homeId: challenge.homeId, membershipId: challenge.membershipId, operationKind: challenge.operationKind, targetDigest: challenge.targetDigest, normalizedValueDigest: challenge.normalizedValueDigest, policyRevision: challenge.policyRevision, nonceHash: crypto.createHash('sha256').update(proof).digest('hex'), issuedAt: lockedAt, expiresAt: authorizationExpiresAt }, select: { id: true, expiresAt: true } });
    return { proof, proofId: row.id, operationId: unsigned.jti, expiresAt: row.expiresAt };
  }, { isolationLevel: 'Serializable' });
  return result;
}

export async function consumeStepUp(input: { proof: string; customerAccountId: string; customerSessionId?: string; trustedDeviceId?: string; homeId: string; membershipId: string; hubInstallationId: string; operationKind: string; targetIds: string[]; value: unknown; policyRevision: number }) {
  const now = new Date();
  const nonceHash = crypto.createHash('sha256').update(input.proof).digest('hex');
  const digest = operationDigest(input);
  const targetDigestValue = targetDigest(input.targetIds);
  const updated = await prisma.stepUpAuthorization.updateMany({ where: { nonceHash, customerAccountId: input.customerAccountId, customerSessionId: input.customerSessionId, trustedDeviceId: input.trustedDeviceId, homeId: input.homeId, membershipId: input.membershipId, operationKind: input.operationKind, targetDigest: targetDigestValue, normalizedValueDigest: digest, policyRevision: input.policyRevision, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
  if (updated.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'The operation confirmation is invalid, expired, replayed or does not match the requested operation');
  return { ok: true };
}
