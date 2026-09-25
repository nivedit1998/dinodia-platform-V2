import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { completeClaimSetup, recordQualifyingClaimMutation, redeemClaimContract, releaseExpiredClaim } from '@/lib/stage1ClaimContract';
import { canonicalHubRequest, constantTimeEqual, sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

function gate(request: Request) {
  if (String(process.env.V2_ENVIRONMENT ?? '') === 'production') throw new Stage1AuthError(404, 'stage1_contract_not_public', 'The Stage 1 contract harness is not a public customer route');
  const expected = String(process.env.STAGE1_CONTRACT_SECRET ?? '');
  if (!expected || !constantTimeEqual(request.headers.get('x-stage1-contract-secret') ?? '', expected)) throw new Stage1AuthError(401, 'stage1_contract_unauthorized', 'The contract harness is restricted');
}

function resolverProof(body: Record<string, unknown>): { version: 1; serial: string; identityGeneration: number; challengeId: string; challenge: string; resolverGeneration: number; expiresAt: string } {
  const proof = {
    version: 1 as const,
    serial: String(body.serial ?? '').trim(),
    identityGeneration: Number(body.identityGeneration),
    challengeId: String(body.challengeId ?? '').trim(),
    challenge: String(body.challenge ?? '').trim(),
    resolverGeneration: Number(body.resolverGeneration),
    expiresAt: String(body.expiresAt ?? ''),
  };
  if (!proof.serial || !Number.isInteger(proof.identityGeneration) || proof.identityGeneration < 1 || !proof.challengeId || !proof.challenge || !Number.isInteger(proof.resolverGeneration) || proof.resolverGeneration < 1 || !proof.expiresAt) throw new Stage1AuthError(400, 'resolver_proof_invalid', 'The resolver proof is incomplete');
  return proof;
}

async function consumeResolverProof(body: Record<string, unknown>) {
  const proof = resolverProof(body);
  const timestamp = String(body.timestamp ?? '');
  const nonce = String(body.nonce ?? '');
  const bodyHash = String(body.bodyHash ?? '').toLowerCase();
  const signature = String(body.hubSignature ?? '');
  if (!/^\d{10,16}$/.test(timestamp) || !nonce || !/^[a-f0-9]{64}$/.test(bodyHash) || !signature || bodyHash !== sha256(JSON.stringify(proof)) || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) throw new Stage1AuthError(401, 'resolver_proof_invalid', 'The resolver proof is invalid or expired');
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const identity = await tx.hubManufacturingIdentity.findFirst({ where: { serialNumber: proof.serial, identityGeneration: proof.identityGeneration, status: 'ACTIVE' }, select: { id: true, signingPublicKey: true } });
    const installation = await tx.hubInstallation.findUnique({ where: { serialNumberSnapshot: proof.serial }, select: { id: true, permanentResolverHash: true, permanentResolverGeneration: true, permanentResolverStatus: true } });
    if (!identity || !installation || installation.permanentResolverStatus !== 'ACTIVE' || installation.permanentResolverGeneration !== proof.resolverGeneration) throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The claim resolver is unavailable');
    let publicKey: crypto.KeyObject;
    try { publicKey = crypto.createPublicKey(identity.signingPublicKey); } catch { throw new Stage1AuthError(401, 'resolver_identity_invalid', 'The resolver identity is invalid'); }
    const canonical = canonicalHubRequest({ method: 'POST', path: '/api/hub-agent/v2/claim/resolver/challenge', timestamp, nonce, bodyHash });
    try { if (!crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(signature, 'base64url'))) throw new Error('invalid'); } catch { throw new Stage1AuthError(401, 'resolver_signature_invalid', 'The resolver proof signature is invalid'); }
    const challenge = await tx.homeClaimChallenge.findUnique({ where: { id: proof.challengeId }, select: { id: true, claimReferenceId: true, hubInstallationId: true, resolverGeneration: true, nonceHash: true, expiresAt: true, consumedAt: true, revokedAt: true, claimReference: { select: { homeId: true, hubInstallationId: true, companyQrReferenceHash: true, resolverGeneration: true, state: true } } } });
    const currentClaim = challenge?.claimReference;
    if (!challenge || !currentClaim || challenge.hubInstallationId !== installation.id || currentClaim.hubInstallationId !== installation.id || challenge.resolverGeneration !== proof.resolverGeneration || currentClaim.resolverGeneration !== proof.resolverGeneration || challenge.nonceHash !== sha256(proof.challenge) || challenge.consumedAt || challenge.revokedAt || challenge.expiresAt <= now || !['AVAILABLE', 'RESERVED'].includes(currentClaim.state) || currentClaim.companyQrReferenceHash !== installation.permanentResolverHash) throw new Stage1AuthError(401, 'resolver_challenge_invalid', 'The resolver challenge is invalid or expired');
    const consumed = await tx.homeClaimChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now, signedResponseDigest: sha256(signature) } });
    if (consumed.count !== 1) throw new Stage1AuthError(409, 'resolver_challenge_replayed', 'The resolver challenge has already been consumed');
    return { challengeId: challenge.id, homeId: currentClaim.homeId, resolverGeneration: proof.resolverGeneration, consumedAt: now };
  });
}

export async function POST(request: Request) {
  try {
    gate(request);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? '').trim();
    if (action === 'resolve') return NextResponse.json({ ok: true, ...(await consumeResolverProof(body)) }, { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'redeem') {
      const accountId = String(body.customerAccountId ?? '');
      const account = await prisma.customerAccount.findUnique({ where: { id: accountId }, select: { id: true, emailVerifiedAt: true } });
      if (!account) throw new Stage1AuthError(404, 'contract_account_missing', 'The contract account does not exist');
      return NextResponse.json({ ok: true, ...(await redeemClaimContract({ reference: String(body.reference ?? ''), customerAccountId: account.id, emailVerified: Boolean(account.emailVerifiedAt) })) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'mutate') return NextResponse.json({ ok: true, ...(await recordQualifyingClaimMutation(String(body.reservationId ?? ''), String(body.customerAccountId ?? ''), String(body.step ?? ''), body.mutation && typeof body.mutation === 'object' ? body.mutation as Record<string, unknown> : {})) }, { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'complete') return NextResponse.json(await completeClaimSetup(String(body.reservationId ?? ''), String(body.customerAccountId ?? '')), { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'release') {
      const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
      return NextResponse.json({ ok: true, ...(await releaseExpiredClaim(String(body.reservationId ?? ''), { employeeId: employee.id, reason: String(body.reason ?? '').trim().slice(0, 500) })) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    throw new Stage1AuthError(400, 'contract_action_invalid', 'The contract action is invalid');
  } catch (error) { return authErrorResponse(error); }
}
