import type { Prisma } from '@prisma/client';

/**
 * Keeps an auto-scope Alexa link in step with the tenant's real access: every ACTIVE tenant membership of the account
 * is exposed in every currently granted ACTIVE room, and nothing else. The existing scope/selection rows (which discovery
 * and directive execution already authorise against) are the single mechanism, so no authorisation code changes meaning.
 * Callers hold the account and link locks.
 */
export async function ensureAutoScopes(tx: Prisma.TransactionClient, link: { id: string; customerAccountId: string }, now: Date): Promise<{ changed: boolean }> {
  const memberships = await tx.homeMembership.findMany({ where: {
    customerAccountId: link.customerAccountId, role: 'TENANT', status: 'ACTIVE',
    home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: { not: null } },
    customerAccount: { status: 'ACTIVE', emailVerifiedAt: { not: null } },
  }, select: { id: true, homeId: true, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } });
  const scopes = await tx.alexaNativeHomeScope.findMany({ where: { linkId: link.id }, select: {
    id: true, membershipId: true, homeId: true, revokedAt: true,
    areaSelections: { where: { revokedAt: null }, select: { areaId: true } },
  } });
  const byMembership = new Map(scopes.map((scope) => [scope.membershipId, scope]));
  const eligible = new Set(memberships.map((membership) => membership.id));
  let changed = false;

  for (const membership of memberships) {
    const desired = new Set(membership.tenantAreaGrants.map((grant) => grant.areaId));
    const scope = byMembership.get(membership.id);
    if (desired.size === 0) {
      // No granted rooms: expose nothing, but keep the scope row (a closed scope can never be reopened by the database guard).
      if (scope && !scope.revokedAt && scope.areaSelections.length > 0) {
        await tx.alexaNativeAreaSelection.updateMany({ where: { homeScopeId: scope.id, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
        await tx.alexaNativeHomeScope.update({ where: { id: scope.id }, data: { exposureGeneration: { increment: 1 }, updatedAt: now } });
        await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, membershipId: membership.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
        changed = true;
      }
      continue;
    }
    let scopeId: string;
    let activeAreas = new Set<string>();
    if (!scope) {
      const created = await tx.alexaNativeHomeScope.create({ data: {
        linkId: link.id, homeId: membership.homeId, membershipId: membership.id,
        // Legacy non-null compatibility cache; authority is the selection rows.
        areaIds: [] as Prisma.InputJsonValue, exposureGeneration: 1,
      }, select: { id: true } });
      scopeId = created.id;
      changed = true;
    } else {
      scopeId = scope.id;
      // A scope closed because the membership ended cannot be reopened; a new membership gets a new scope.
      if (scope.revokedAt) continue;
      activeAreas = new Set(scope.areaSelections.map((selection) => selection.areaId));
    }
    const removed = [...activeAreas].filter((areaId) => !desired.has(areaId));
    const added = [...desired].filter((areaId) => !activeAreas.has(areaId));
    if (removed.length) {
      await tx.alexaNativeAreaSelection.updateMany({ where: { homeScopeId: scopeId, areaId: { in: removed }, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
      await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, areaId: { in: removed }, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
    }
    for (const areaId of added) {
      const maximum = await tx.alexaNativeAreaSelection.aggregate({ where: { homeScopeId: scopeId, areaId }, _max: { exposureGeneration: true } });
      await tx.alexaNativeAreaSelection.create({ data: { homeScopeId: scopeId, areaId, exposureGeneration: Math.max(0, maximum._max.exposureGeneration ?? 0) + 1 } });
    }
    if (removed.length || added.length) {
      await tx.alexaNativeHomeScope.update({ where: { id: scopeId }, data: { exposureGeneration: { increment: 1 }, updatedAt: now } });
      changed = true;
    }
  }

  // A scope whose tenant membership, Home or hub is no longer eligible is closed.
  for (const scope of scopes) {
    if (eligible.has(scope.membershipId) || scope.revokedAt) continue;
    // Close the scope for good only when the tenant relationship itself has ended; a Home that is merely unavailable for a
    // while (installation or hub change) just stops exposing rooms and comes back by itself.
    const relationship = await tx.homeMembership.findUnique({ where: { id: scope.membershipId }, select: { customerAccountId: true, role: true, status: true } });
    const ended = !relationship || relationship.customerAccountId !== link.customerAccountId || relationship.role !== 'TENANT' || relationship.status !== 'ACTIVE';
    await tx.alexaNativeAreaSelection.updateMany({ where: { homeScopeId: scope.id, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
    if (ended) await tx.alexaNativeHomeScope.update({ where: { id: scope.id }, data: { revokedAt: now, exposureGeneration: { increment: 1 }, updatedAt: now } });
    await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, membershipId: scope.membershipId, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
    changed = true;
  }
  return { changed };
}

/** Discovery tells Alexa about every active endpoint: remember that, so later removals can be reported whichever way they happen. */
export async function markAnnounced(tx: Prisma.TransactionClient, linkId: string, now: Date, endpointIds?: string[]): Promise<void> {
  if (endpointIds && endpointIds.length === 0) return;
  if (endpointIds) await tx.$executeRaw`UPDATE "AlexaNativeEndpointProjection" SET "announcedHash" = "payloadHash", "announcedAt" = ${now} WHERE "linkId" = ${linkId}::uuid AND "status" = 'ACTIVE' AND "payloadHash" IS NOT NULL AND "endpointId" = ANY(${endpointIds}::text[])`;
  else await tx.$executeRaw`UPDATE "AlexaNativeEndpointProjection" SET "announcedHash" = "payloadHash", "announcedAt" = ${now} WHERE "linkId" = ${linkId}::uuid AND "status" = 'ACTIVE' AND "payloadHash" IS NOT NULL`;
  const active = await tx.alexaNativeEndpointProjection.findMany({ where: { linkId, status: 'ACTIVE', ...(endpointIds ? { endpointId: { in: endpointIds } } : {}) }, select: { endpointId: true } });
  if (active.length === 0) return;
  const link = await tx.alexaNativeLink.findUnique({ where: { id: linkId }, select: { announcedEndpointIds: true } });
  const known = Array.isArray(link?.announcedEndpointIds) ? link.announcedEndpointIds.filter((item): item is string => typeof item === 'string') : [];
  const merged = [...new Set([...known, ...active.map((row) => row.endpointId)])].slice(-5000);
  if (merged.length !== known.length) await tx.alexaNativeLink.update({ where: { id: linkId }, data: { announcedEndpointIds: merged } });
}
