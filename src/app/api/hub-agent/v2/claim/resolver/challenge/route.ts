import { NextResponse } from 'next/server';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { hashClaimReference } from '@/lib/stage1ClaimContract';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { serializableTransaction } from '@/lib/serializableTransaction';

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
    const challenge = await serializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "HubInstallation" WHERE "id" = ${hub.installation.id}::uuid FOR UPDATE`;
      const installation = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: { homeId: true, permanentResolverHash: true, permanentResolverGeneration: true, permanentResolverStatus: true, lifecycleStatus: true } });
      const home = installation ? await tx.home.findUnique({ where: { id: installation.homeId }, select: { activeHubInstallationId: true, lifecycle: true } }) : null;
      if (!installation || !home || home.activeHubInstallationId !== hub.installation.id || installation.lifecycleStatus !== 'ACTIVE'
        || installation.permanentResolverStatus !== 'ACTIVE' || installation.permanentResolverHash !== referenceHash) {
        throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The claim resolver is unavailable');
      }
      const claims = await tx.homeClaimReference.findMany({ where: {
        hubInstallationId: hub.installation.id,
        purpose: { in: ['INITIAL_OWNER', 'OWNERSHIP_TRANSFER'] },
        resolverGeneration: installation.permanentResolverGeneration,
        state: { in: ['AVAILABLE', 'RESERVED'] },
        cancelledAt: null, revokedAt: null, invalidatedAt: null,
      }, select: { id: true, resolverGeneration: true, purpose: true, state: true, companyQrReferenceHash: true }, take: 2 });
      if (claims.length !== 1 || (claims[0].purpose === 'INITIAL_OWNER' && claims[0].companyQrReferenceHash !== referenceHash)) {
        throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The claim resolver is unavailable');
      }
      const claim = claims[0];
      const now = new Date();
      const nonce = randomSecret(32);
      const challengeDigest = sha256(JSON.stringify({ version: 1, hubInstallationId: hub.installation.id, claimReferenceId: claim.id, resolverGeneration: claim.resolverGeneration, nonce, issuedAt: now.toISOString() }));
      const created = await tx.homeClaimChallenge.create({ data: { claimReferenceId: claim.id, hubInstallationId: hub.installation.id, resolverGeneration: claim.resolverGeneration, nonceHash: sha256(nonce), challengeDigest, issuedAt: now, expiresAt: new Date(now.getTime() + 5 * 60 * 1000) }, select: { id: true, resolverGeneration: true, expiresAt: true } });
      return { challengeId: created.id, resolverGeneration: created.resolverGeneration, challenge: nonce, expiresAt: created.expiresAt };
    });
    return NextResponse.json({ ok: true, ...challenge }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
