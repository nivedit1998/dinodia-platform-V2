import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { lockAndValidateAlexaAccountAuthority } from '@/lib/nativeAlexaAccountAuthority';
import { serializableTransaction } from '@/lib/serializableTransaction';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Explicit online tenant confirmation for the selected Home's Area scope. */
export async function POST(request: Request) {
  try {
    const actor = await requireCustomerAccountSession(request);
    const raw = await request.json().catch(() => null) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Stage1AuthError(400, 'alexa_scope_invalid', 'The Alexa Area selection is invalid');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'areaIds,expectedLinkRevision,expectedScopeRevision,homeMembershipId'
      || typeof body.homeMembershipId !== 'string' || !uuid.test(body.homeMembershipId)
      || !Array.isArray(body.areaIds) || body.areaIds.length > 200
      || body.areaIds.some((id) => typeof id !== 'string' || !uuid.test(id))
      || new Set(body.areaIds).size !== body.areaIds.length
      || !Number.isSafeInteger(body.expectedLinkRevision) || Number(body.expectedLinkRevision) < 1
      || !Number.isSafeInteger(body.expectedScopeRevision) || Number(body.expectedScopeRevision) < 1) {
      throw new Stage1AuthError(400, 'alexa_scope_invalid', 'The Alexa Area selection is invalid');
    }
    if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') throw new Stage1AuthError(503, 'alexa_not_activated', 'Native Alexa management is not active in this release');
    const selectedHome = request.headers.get('x-dinodia-home-id')?.trim() ?? '';
    if (!uuid.test(selectedHome)) throw new Stage1AuthError(400, 'selected_home_required', 'Select a tenant Home before changing Alexa access');
    const membershipHint = await prisma.homeMembership.findFirst({ where: {
      id: body.homeMembershipId, customerAccountId: actor.id, homeId: selectedHome, role: 'TENANT', status: 'ACTIVE',
    }, select: { id: true, homeId: true } });
    if (!membershipHint) throw new Stage1AuthError(403, 'alexa_tenant_membership_required', 'A current tenant membership for the selected Home is required');
    const areaIds = [...body.areaIds as string[]].sort();

    const result = await serializableTransaction(async (tx) => {
      await lockAndValidateAlexaAccountAuthority(tx, actor, selectedHome);
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${membershipHint.id}::uuid AND "customerAccountId" = ${actor.id}::uuid AND "homeId" = ${selectedHome}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${membershipHint.id}::uuid AND "homeId" = ${selectedHome}::uuid ORDER BY "areaId" FOR UPDATE`;
      const membership = await tx.homeMembership.findFirst({ where: {
        id: membershipHint.id, customerAccountId: actor.id, homeId: selectedHome, role: 'TENANT', status: 'ACTIVE',
        customerAccount: { status: 'ACTIVE', emailVerifiedAt: { not: null } },
        home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: { not: null } },
      }, select: { id: true, homeId: true, accessRevision: true, home: { select: { activeHubInstallationId: true } },
        tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } });
      if (!membership) throw new Stage1AuthError(409, 'alexa_scope_changed', 'Home access changed. Refresh before saving');
      if (membership.home.activeHubInstallationId) await tx.$queryRaw`SELECT "id" FROM "HubInstallation" WHERE "id" = ${membership.home.activeHubInstallationId}::uuid AND "homeId" = ${selectedHome}::uuid FOR UPDATE`;
      const hub = membership.home.activeHubInstallationId ? await tx.hubInstallation.findFirst({ where: {
        id: membership.home.activeHubInstallationId, homeId: selectedHome, lifecycleStatus: 'ACTIVE',
      }, select: { id: true } }) : null;
      if (!hub) throw new Stage1AuthError(409, 'alexa_hub_unavailable', 'The selected Home has no active Dinodia hub');
      const allowedAreas = new Set(membership.tenantAreaGrants.map((grant) => grant.areaId));
      if (areaIds.some((id) => !allowedAreas.has(id))) throw new Stage1AuthError(403, 'alexa_area_scope_denied', 'One or more selected Areas are not currently available');

      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "customerAccountId" = ${actor.id}::uuid AND "status" = 'ACTIVE' AND "revokedAt" IS NULL FOR UPDATE`;
      const link = await tx.alexaNativeLink.findFirst({ where: { customerAccountId: actor.id, status: 'ACTIVE', revokedAt: null },
        select: { id: true, revision: true, updatedAt: true } });
      if (!link) throw new Stage1AuthError(409, 'alexa_link_required', 'Connect this tenant account to the existing Dinodia Smart Living Alexa skill first');
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeHomeScope" WHERE "linkId" = ${link.id}::uuid AND "membershipId" = ${membership.id}::uuid FOR UPDATE`;
      const scope = await tx.alexaNativeHomeScope.findUnique({ where: { linkId_membershipId: { linkId: link.id, membershipId: membership.id } },
        select: { id: true, homeId: true, membershipId: true, exposureGeneration: true, revokedAt: true } });
      if (!scope || scope.revokedAt || scope.homeId !== selectedHome
        || link.revision !== body.expectedLinkRevision || scope.exposureGeneration !== body.expectedScopeRevision) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Alexa access changed. Refresh and review the current Area selection');
      }
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeAreaSelection" WHERE "homeScopeId" = ${scope.id}::uuid ORDER BY "areaId", "exposureGeneration" FOR UPDATE`;
      const current = await tx.alexaNativeAreaSelection.findMany({ where: { homeScopeId: scope.id, revokedAt: null }, select: { areaId: true } });
      const currentIds = new Set(current.map((row) => row.areaId));
      const desired = new Set(areaIds);
      const removed = [...currentIds].filter((id) => !desired.has(id));
      const added = areaIds.filter((id) => !currentIds.has(id));
      const now = new Date();
      if (removed.length) {
        await tx.alexaNativeAreaSelection.updateMany({ where: { homeScopeId: scope.id, areaId: { in: removed }, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
        await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, membershipId: membership.id, homeId: selectedHome, areaId: { in: removed }, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
      }
      for (const areaId of added) {
        const maximum = await tx.alexaNativeAreaSelection.aggregate({ where: { homeScopeId: scope.id, areaId }, _max: { exposureGeneration: true } });
        await tx.alexaNativeAreaSelection.create({ data: { homeScopeId: scope.id, areaId, exposureGeneration: Math.max(0, maximum._max.exposureGeneration ?? 0) + 1 } });
      }
      const changed = removed.length > 0 || added.length > 0;
      const nextScope = changed ? await tx.alexaNativeHomeScope.update({ where: { id: scope.id }, data: {
        exposureGeneration: { increment: 1 }, updatedAt: now,
      }, select: { exposureGeneration: true } }) : { exposureGeneration: scope.exposureGeneration };
      const nextLink = changed ? await tx.alexaNativeLink.update({ where: { id: link.id }, data: { revision: { increment: 1 }, updatedAt: now }, select: { revision: true } }) : { revision: link.revision };
      return { ok: true as const, schemaVersion: 'dinodia.v1' as const, homeId: selectedHome, homeMembershipId: membership.id,
        linkRevision: nextLink.revision, scopeRevision: nextScope.exposureGeneration, selectedAreaIds: areaIds, changed };
    }, 2);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
