import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { hashClaimReference } from '@/lib/stage1ClaimContract';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

/**
 * Stage 1 contract endpoint for the permanent hub label.
 *
 * This is deliberately hub-agent-only. It returns an opaque, short-lived
 * challenge and no address, user, area, device or membership information.
 * The local Dinodia OS endpoint is the only customer-facing presentation of
 * this contract and adds the correct-LAN boundary plus a fresh hub signature.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const reference = String(hub.body.reference ?? '').trim();
    if (!reference || reference.length > 512) throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The claim resolver is unavailable');
    const referenceHash = hashClaimReference(reference);
    const now = new Date();
    const challenge = await prisma.$transaction(async (tx) => {
      const installation = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: { permanentResolverHash: true, permanentResolverGeneration: true, permanentResolverStatus: true } });
      if (!installation || installation.permanentResolverStatus !== 'ACTIVE' || installation.permanentResolverHash !== referenceHash) throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The claim resolver is unavailable');
      const claim = await tx.homeClaimReference.findFirst({ where: { hubInstallationId: hub.installation.id, companyQrReferenceHash: referenceHash, resolverGeneration: installation.permanentResolverGeneration, state: { in: ['AVAILABLE', 'RESERVED'] } }, select: { id: true, resolverGeneration: true } });
      if (!claim) throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The claim resolver is unavailable');
      const nonce = randomSecret(32);
      const challengeDigest = sha256(JSON.stringify({ version: 1, hubInstallationId: hub.installation.id, claimReferenceId: claim.id, resolverGeneration: claim.resolverGeneration, nonce, issuedAt: now.toISOString() }));
      const created = await tx.homeClaimChallenge.create({ data: { claimReferenceId: claim.id, hubInstallationId: hub.installation.id, resolverGeneration: claim.resolverGeneration, nonceHash: sha256(nonce), challengeDigest, expiresAt: new Date(now.getTime() + 5 * 60 * 1000) }, select: { id: true, resolverGeneration: true, expiresAt: true } });
      return { challengeId: created.id, resolverGeneration: created.resolverGeneration, challenge: nonce, expiresAt: created.expiresAt };
    });
    return NextResponse.json({ ok: true, ...challenge }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
