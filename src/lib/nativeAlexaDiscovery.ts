import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { sha256 } from '@/lib/stage1Crypto';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { projectAlexaLinkEndpoints } from '@/lib/alexa/projection';
import { ensureAutoScopes, markAnnounced } from '@/lib/alexa/syncAlexa';

export { projectSupportedAlexaControl } from '@/lib/alexa/projection';

type AlexaActor = { accountId: string; linkId: string; tokenHash: string };
function nativeAlexaEnabled(): boolean {
  return process.env.DINODIA_NATIVE_ALEXA_ENABLED === 'true';
}

function readBearer(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer (dno-alexa-access-[A-Za-z0-9_-]{40,128})$/.exec(authorization);
  if (!match) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
  return match[1];
}

async function currentAlexaActor(tx: Prisma.TransactionClient, tokenHash: string, now: Date): Promise<AlexaActor> {
  const token = await tx.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: {
    tokenHash: true, expiresAt: true, revokedAt: true,
    family: { select: {
      id: true, linkId: true, absoluteExpiresAt: true, inactivityExpiresAt: true, revokedAt: true,
      link: { select: { id: true, customerAccountId: true, status: true, revokedAt: true,
        customerAccount: { select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true } } } },
    } },
  } });
  if (!token || token.revokedAt || token.expiresAt <= now || token.tokenHash !== tokenHash
    || token.family.revokedAt || token.family.absoluteExpiresAt <= now || token.family.inactivityExpiresAt <= now
    || token.family.link.status !== 'ACTIVE' || token.family.link.revokedAt
    || token.family.link.customerAccount.id !== token.family.link.customerAccountId
    || token.family.link.customerAccount.status !== 'ACTIVE' || !token.family.link.customerAccount.emailVerifiedAt
    || token.family.link.customerAccount.mustChangePassword || token.family.link.customerAccount.usernameSelectionRequired) {
    throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
  }
  const policy = currentCustomerPolicy();
  if (!policy) throw new Stage1AuthError(503, 'customer_policy_unavailable', 'Customer access is unavailable until the current policy is configured');
  const accepted = await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
    customerAccountId: token.family.link.customerAccount.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
  } }, select: { id: true } });
  if (!accepted) throw new Stage1AuthError(403, 'customer_policy_acceptance_required', 'Review and accept the current Dinodia policy before continuing');
  return { accountId: token.family.link.customerAccountId, linkId: token.family.linkId, tokenHash };
}

/** Re-authorized, multi-property Alexa discovery from current Platform-owned inventory. */
export async function discoverNativeAlexa(request: Request) {
  if (!nativeAlexaEnabled()) throw new Stage1AuthError(501, 'NATIVE_FEATURE_NOT_ENABLED', 'Native Alexa is not yet activated');
  const token = readBearer(request);
  const tokenHash = sha256(token);
  return serializableTransaction(async (tx) => {
    const now = new Date();
    const initial = await currentAlexaActor(tx, tokenHash, now);
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${initial.accountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${initial.linkId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthTokenFamily" WHERE "linkId" = ${initial.linkId}::uuid ORDER BY "id" FOR UPDATE`;
    const actor = await currentAlexaActor(tx, tokenHash, new Date());
    if (actor.accountId !== initial.accountId || actor.linkId !== initial.linkId) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');

    const link = await tx.alexaNativeLink.findUnique({ where: { id: actor.linkId }, select: { id: true, customerAccountId: true, autoScope: true } });
    if (!link) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
    if (link.autoScope) await ensureAutoScopes(tx, link, now);
    const projection = await projectAlexaLinkEndpoints(tx, link, now);
    // Discovery tells Alexa everything it needs: remember that, so later changes are announced as differences.
    await markAnnounced(tx, link.id, now);
    return { schemaVersion: 'dinodia.v1', properties: projection.properties, endpoints: projection.endpoints };
  }, 3);
}
