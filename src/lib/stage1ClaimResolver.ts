import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { canonicalHubRequest, sha256 } from '@/lib/stage1Crypto';

export type SignedResolverProof = {
  version: 1; serial: string; identityGeneration: number; challengeId: string; challenge: string;
  resolverGeneration: number; expiresAt: string; timestamp: string; nonce: string; bodyHash: string; hubSignature: string;
};

export type ConsumedResolverClaim = {
  challengeId: string; claimReferenceId: string; homeId: string; hubInstallationId: string;
  purpose: string; resolverGeneration: number; consumedAt: Date;
};

function parseProof(body: Record<string, unknown>): SignedResolverProof {
  const fields = ['bodyHash', 'challenge', 'challengeId', 'expiresAt', 'hubSignature', 'identityGeneration', 'nonce', 'resolverGeneration', 'serial', 'timestamp', 'version'];
  if (Object.keys(body).some((key) => key !== 'action' && !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(body, key))) {
    throw new Stage1AuthError(401, 'resolver_proof_invalid', 'The resolver proof is invalid or expired');
  }
  const proof: SignedResolverProof = {
    version: 1,
    serial: String(body.serial ?? '').trim(),
    identityGeneration: Number(body.identityGeneration),
    challengeId: String(body.challengeId ?? '').trim(),
    challenge: String(body.challenge ?? '').trim(),
    resolverGeneration: Number(body.resolverGeneration),
    expiresAt: String(body.expiresAt ?? ''),
    timestamp: String(body.timestamp ?? ''),
    nonce: String(body.nonce ?? ''),
    bodyHash: String(body.bodyHash ?? '').toLowerCase(),
    hubSignature: String(body.hubSignature ?? ''),
  };
  if (body.version !== 1 || !proof.serial || proof.serial.length > 160 || !Number.isSafeInteger(proof.identityGeneration) || proof.identityGeneration < 1
    || !/^[0-9a-f-]{36}$/i.test(proof.challengeId) || !/^[A-Za-z0-9_-]{20,128}$/.test(proof.challenge)
    || !Number.isSafeInteger(proof.resolverGeneration) || proof.resolverGeneration < 1
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(proof.expiresAt)
    || !/^\d{10,16}$/.test(proof.timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(proof.nonce)
    || !/^[a-f0-9]{64}$/.test(proof.bodyHash) || !/^[A-Za-z0-9_-]{40,2048}$/.test(proof.hubSignature)) {
    throw new Stage1AuthError(401, 'resolver_proof_invalid', 'The resolver proof is invalid or expired');
  }
  const signedPayload = {
    version: proof.version,
    serial: proof.serial,
    identityGeneration: proof.identityGeneration,
    challengeId: proof.challengeId,
    challenge: proof.challenge,
    resolverGeneration: proof.resolverGeneration,
    expiresAt: proof.expiresAt,
  };
  if (proof.bodyHash !== sha256(JSON.stringify(signedPayload)) || Math.abs(Date.now() - Number(proof.timestamp)) > 5 * 60 * 1000) {
    throw new Stage1AuthError(401, 'resolver_proof_invalid', 'The resolver proof is invalid or expired');
  }
  return proof;
}

/**
 * Verifies and consumes the same machine-signed LAN challenge used by the
 * guarded initial-claim harness. When called from transfer redemption it
 * runs in that same serializable transaction as membership activation.
 */
export async function consumeSignedClaimResolverProof(tx: Prisma.TransactionClient, body: Record<string, unknown>, expected?: {
  purpose?: 'INITIAL_OWNER' | 'OWNERSHIP_TRANSFER';
  recipientEmailHash?: string;
}): Promise<ConsumedResolverClaim> {
  const proof = parseProof(body);
  const now = new Date();
  const firstRead = await tx.homeClaimChallenge.findUnique({ where: { id: proof.challengeId }, select: { claimReferenceId: true } });
  if (!firstRead) throw new Stage1AuthError(401, 'resolver_challenge_invalid', 'The resolver challenge is invalid or expired');
  await tx.$queryRaw`SELECT "id" FROM "HomeClaimReference" WHERE "id" = ${firstRead.claimReferenceId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "HomeClaimChallenge" WHERE "id" = ${proof.challengeId}::uuid FOR UPDATE`;
  const challenge = await tx.homeClaimChallenge.findUnique({ where: { id: proof.challengeId }, select: {
    id: true, claimReferenceId: true, hubInstallationId: true, resolverGeneration: true, nonceHash: true,
    challengeDigest: true, issuedAt: true, expiresAt: true, consumedAt: true, revokedAt: true,
    claimReference: { select: { id: true, homeId: true, hubInstallationId: true, purpose: true,
      companyQrReferenceHash: true, transferRecipientEmailHash: true, resolverGeneration: true, state: true } },
  } });
  const claim = challenge?.claimReference;
  if (!challenge || !claim || challenge.claimReferenceId !== firstRead.claimReferenceId
    || challenge.hubInstallationId !== claim.hubInstallationId || challenge.resolverGeneration !== proof.resolverGeneration
    || challenge.nonceHash !== sha256(proof.challenge) || challenge.consumedAt || challenge.revokedAt
    || challenge.expiresAt <= now || challenge.expiresAt.toISOString() !== proof.expiresAt
    || !['AVAILABLE', 'RESERVED'].includes(claim.state) || claim.resolverGeneration !== proof.resolverGeneration
    || (expected?.purpose && claim.purpose !== expected.purpose)
    || (expected?.recipientEmailHash && claim.transferRecipientEmailHash !== expected.recipientEmailHash)) {
    // A signed permanent label is only a presentation of a recipient-bound
    // transfer claim. Keep wrong-account attempts indistinguishable from an
    // unavailable transfer and, critically, reject before consuming the
    // one-use LAN challenge so the intended recipient can still redeem it.
    if (expected?.purpose === 'OWNERSHIP_TRANSFER'
      && challenge?.claimReference?.purpose === 'OWNERSHIP_TRANSFER'
      && expected.recipientEmailHash
      && challenge.claimReference.transferRecipientEmailHash !== expected.recipientEmailHash) {
      throw new Stage1AuthError(404, 'transfer_unavailable', 'This ownership transfer is not available to this verified account');
    }
    throw new Stage1AuthError(401, 'resolver_challenge_invalid', 'The resolver challenge is invalid or expired');
  }
  const expectedChallengeDigest = sha256(JSON.stringify({
    version: 1,
    hubInstallationId: challenge.hubInstallationId,
    claimReferenceId: claim.id,
    resolverGeneration: challenge.resolverGeneration,
    nonce: proof.challenge,
    issuedAt: challenge.issuedAt.toISOString(),
  }));
  if (challenge.challengeDigest !== expectedChallengeDigest) throw new Stage1AuthError(401, 'resolver_challenge_invalid', 'The resolver challenge is invalid or expired');

  await tx.$queryRaw`SELECT "id" FROM "HubInstallation" WHERE "id" = ${challenge.hubInstallationId}::uuid FOR UPDATE`;
  const installation = await tx.hubInstallation.findUnique({ where: { id: challenge.hubInstallationId }, select: {
    id: true, homeId: true, serialNumberSnapshot: true, permanentResolverHash: true,
    permanentResolverGeneration: true, permanentResolverStatus: true, lifecycleStatus: true,
    manufacturingIdentity: { select: { serialNumber: true, identityGeneration: true, signingPublicKey: true, status: true } },
  } });
  const currentClaim = await tx.homeClaimReference.findUnique({ where: { id: claim.id }, select: {
    id: true, homeId: true, hubInstallationId: true, purpose: true, state: true,
    companyQrReferenceHash: true, transferRecipientEmailHash: true, resolverGeneration: true,
  } });
  if (!installation || !currentClaim || installation.lifecycleStatus !== 'ACTIVE'
    || installation.permanentResolverStatus !== 'ACTIVE' || !installation.permanentResolverHash
    || installation.permanentResolverGeneration !== proof.resolverGeneration
    || installation.serialNumberSnapshot !== proof.serial || installation.manufacturingIdentity.serialNumber !== proof.serial
    || installation.manufacturingIdentity.identityGeneration !== proof.identityGeneration || installation.manufacturingIdentity.status !== 'ACTIVE'
    || currentClaim.hubInstallationId !== installation.id || currentClaim.homeId !== installation.homeId
    || currentClaim.state !== claim.state || currentClaim.resolverGeneration !== installation.permanentResolverGeneration
    || !['INITIAL_OWNER', 'OWNERSHIP_TRANSFER'].includes(currentClaim.purpose)
    || (currentClaim.purpose === 'INITIAL_OWNER' && currentClaim.companyQrReferenceHash !== installation.permanentResolverHash)
    || (expected?.purpose && currentClaim.purpose !== expected.purpose)
    || (expected?.recipientEmailHash && currentClaim.transferRecipientEmailHash !== expected.recipientEmailHash)) {
    throw new Stage1AuthError(401, 'resolver_challenge_invalid', 'The resolver challenge is invalid or expired');
  }
  const home = await tx.home.findUnique({ where: { id: currentClaim.homeId }, select: { activeHubInstallationId: true } });
  if (!home || home.activeHubInstallationId !== installation.id) throw new Stage1AuthError(401, 'resolver_challenge_invalid', 'The resolver challenge is invalid or expired');
  let publicKey: crypto.KeyObject;
  try { publicKey = crypto.createPublicKey(installation.manufacturingIdentity.signingPublicKey); }
  catch { throw new Stage1AuthError(401, 'resolver_identity_invalid', 'The resolver identity is invalid'); }
  const signedRequest = canonicalHubRequest({ method: 'POST', path: '/api/hub-agent/v2/claim/resolver/challenge',
    timestamp: proof.timestamp, nonce: proof.nonce, bodyHash: proof.bodyHash });
  let signatureValid = false;
  try { signatureValid = crypto.verify(null, Buffer.from(signedRequest, 'utf8'), publicKey, Buffer.from(proof.hubSignature, 'base64url')); }
  catch { signatureValid = false; }
  if (!signatureValid) throw new Stage1AuthError(401, 'resolver_signature_invalid', 'The resolver proof signature is invalid');
  const consumed = await tx.homeClaimChallenge.updateMany({ where: {
    id: challenge.id, claimReferenceId: currentClaim.id, hubInstallationId: installation.id,
    resolverGeneration: proof.resolverGeneration, nonceHash: sha256(proof.challenge),
    consumedAt: null, revokedAt: null, expiresAt: { gt: now },
  }, data: { consumedAt: now, signedResponseDigest: sha256(proof.hubSignature) } });
  if (consumed.count !== 1) throw new Stage1AuthError(409, 'resolver_challenge_replayed', 'The resolver challenge has already been consumed');
  return { challengeId: challenge.id, claimReferenceId: currentClaim.id, homeId: currentClaim.homeId,
    hubInstallationId: installation.id, purpose: currentClaim.purpose, resolverGeneration: proof.resolverGeneration, consumedAt: now };
}
