import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { lockAndValidateAlexaAccountAuthority } from '@/lib/nativeAlexaAccountAuthority';
import { consumeStepUpInTransaction } from '@/lib/sensitiveOperationStepUp';
import { serializableTransaction } from '@/lib/serializableTransaction';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Removes only the selected tenant Home; the last Home also revokes the account link. */
export async function POST(request: Request) {
  try {
    const actor = await requireCustomerAccountSession(request);
    const raw = await request.json().catch(() => null) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Stage1AuthError(400, 'alexa_unlink_invalid', 'The Alexa unlink request is invalid');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'connectionId,expectedLinkRevision,expectedScopeRevision,proof'
      || typeof body.connectionId !== 'string' || !uuid.test(body.connectionId)
      || typeof body.proof !== 'string' || body.proof.length < 20 || body.proof.length > 8192
      || !Number.isSafeInteger(body.expectedLinkRevision) || Number(body.expectedLinkRevision) < 1
      || !Number.isSafeInteger(body.expectedScopeRevision) || Number(body.expectedScopeRevision) < 1) {
      throw new Stage1AuthError(400, 'alexa_unlink_invalid', 'The Alexa unlink request is invalid');
    }
    const connectionId = body.connectionId as string;
    const expectedLinkRevision = body.expectedLinkRevision as number;
    const expectedScopeRevision = body.expectedScopeRevision as number;
    const proof = body.proof as string;
    if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') throw new Stage1AuthError(503, 'alexa_not_activated', 'Native Alexa management is not active in this release');
    const homeId = request.headers.get('x-dinodia-home-id')?.trim() ?? '';
    if (!uuid.test(homeId)) throw new Stage1AuthError(400, 'selected_home_required', 'Select the tenant Home to unlink');
    const membershipHint = await prisma.homeMembership.findFirst({ where: { customerAccountId: actor.id, homeId, role: 'TENANT', status: 'ACTIVE' },
      select: { id: true, accessRevision: true, home: { select: { activeHubInstallationId: true,
        activeHubInstallation: { select: { id: true, accessPolicyRevision: true } } } } } });
    if (!membershipHint?.home.activeHubInstallationId || !membershipHint.home.activeHubInstallation
      || membershipHint.home.activeHubInstallation.id !== membershipHint.home.activeHubInstallationId) {
      throw new Stage1AuthError(403, 'alexa_tenant_membership_required', 'A current tenant membership is required');
    }
    const proofValue = { homeMembershipId: membershipHint.id, expectedLinkRevision,
      expectedScopeRevision };
    const result = await serializableTransaction(async (tx) => {
      await lockAndValidateAlexaAccountAuthority(tx, actor, homeId);
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${membershipHint.id}::uuid AND "customerAccountId" = ${actor.id}::uuid AND "homeId" = ${homeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${membershipHint.id}::uuid AND "homeId" = ${homeId}::uuid ORDER BY "areaId" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${body.connectionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeHomeScope" WHERE "linkId" = ${body.connectionId}::uuid AND "membershipId" = ${membershipHint.id}::uuid FOR UPDATE`;
      const [membership, link, scope] = await Promise.all([
        tx.homeMembership.findFirst({ where: { id: membershipHint.id, customerAccountId: actor.id, homeId, role: 'TENANT', status: 'ACTIVE',
          home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: membershipHint.home.activeHubInstallationId } },
          select: { id: true, accessRevision: true, home: { select: { activeHubInstallationId: true,
            activeHubInstallation: { select: { id: true, accessPolicyRevision: true } } } } } }),
        tx.alexaNativeLink.findFirst({ where: { id: connectionId, customerAccountId: actor.id, status: 'ACTIVE', revokedAt: null }, select: { id: true, revision: true } }),
        tx.alexaNativeHomeScope.findUnique({ where: { linkId_membershipId: { linkId: connectionId, membershipId: membershipHint.id } },
          select: { id: true, homeId: true, membershipId: true, exposureGeneration: true, revokedAt: true } }),
      ]);
      const now = new Date();
      if (!membership || !link || !scope || scope.revokedAt || scope.homeId !== homeId
        || link.revision !== expectedLinkRevision || scope.exposureGeneration !== expectedScopeRevision
        || !membership.home.activeHubInstallation || membership.home.activeHubInstallation.id !== membership.home.activeHubInstallationId) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Alexa access changed. Refresh before unlinking');
      }
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeAreaSelection" WHERE "homeScopeId" = ${scope.id}::uuid ORDER BY "areaId", "exposureGeneration" FOR UPDATE`;
      await consumeStepUpInTransaction(tx, { proof, customerAccountId: actor.id, customerSessionId: actor.sessionId,
        trustedDeviceId: actor.trustedDeviceId, homeId, membershipId: membership.id,
        hubInstallationId: membership.home.activeHubInstallation!.id, operationKind: 'alexa_unlink',
        targetIds: [link.id], value: proofValue,
        policyRevision: Math.max(membership.accessRevision, membership.home.activeHubInstallation!.accessPolicyRevision) }, now);
      await tx.alexaNativeAreaSelection.updateMany({ where: { homeScopeId: scope.id, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
      await tx.alexaNativeHomeScope.update({ where: { id: scope.id }, data: { revokedAt: now, updatedAt: now } });
      await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, homeId, membershipId: membership.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
      const otherScopes = await tx.alexaNativeHomeScope.count({ where: { linkId: link.id, revokedAt: null } });
      if (otherScopes === 0) {
        await tx.alexaNativeLink.update({ where: { id: link.id }, data: { status: 'REVOKED', revokedAt: now, revision: { increment: 1 }, updatedAt: now } });
        await tx.alexaOAuthTokenFamily.updateMany({ where: { linkId: link.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'tenant_unlinked' } });
        await tx.alexaOAuthAccessToken.updateMany({ where: { family: { linkId: link.id }, revokedAt: null }, data: { revokedAt: now } });
        await tx.alexaOAuthRefreshToken.updateMany({ where: { family: { linkId: link.id }, revokedAt: null }, data: { revokedAt: now } });
        await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
      } else {
        await tx.alexaNativeLink.update({ where: { id: link.id }, data: { revision: { increment: 1 }, updatedAt: now } });
      }
      return { schemaVersion: 'dinodia.v1', ok: true, homeId, homeMembershipId: membership.id,
        state: 'UNLINKED', remainingHomes: otherScopes, accountLinkRevoked: otherScopes === 0 };
    }, 2);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
