import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { lockAndValidateAlexaAccountAuthority } from '@/lib/nativeAlexaAccountAuthority';
import { nativeDisplayGroups } from '@/lib/nativeDisplayGroups';
import { serializableTransaction } from '@/lib/serializableTransaction';

export const dynamic = 'force-dynamic';

/** Account-global view: only this account's active tenant relationships are projected. */
export async function GET(request: Request) {
  try {
    const account = await requireCustomerAccountSession(request);
    const { links, memberships, activeAreas, now } = await serializableTransaction(async (tx) => {
      await lockAndValidateAlexaAccountAuthority(tx, account);
      const membershipHints = await tx.homeMembership.findMany({ where: {
        customerAccountId: account.id, role: 'TENANT', status: 'ACTIVE',
        home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' },
      }, select: { id: true, homeId: true }, orderBy: [{ homeId: 'asc' }, { id: 'asc' }] });
      for (const membership of membershipHints) {
        await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${membership.id}::uuid AND "customerAccountId" = ${account.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${membership.id}::uuid AND "homeId" = ${membership.homeId}::uuid ORDER BY "areaId" FOR UPDATE`;
      }
      const [activeLinks, currentMemberships] = await Promise.all([
        tx.alexaNativeLink.findMany({
          where: { customerAccountId: account.id, status: 'ACTIVE', revokedAt: null },
          select: { id: true, revision: true, updatedAt: true, homeScopes: { where: { revokedAt: null }, select: {
            id: true, homeId: true, membershipId: true, exposureGeneration: true,
            areaSelections: { where: { revokedAt: null }, select: { areaId: true, exposureGeneration: true } },
          } } },
        }),
        tx.homeMembership.findMany({
          where: { customerAccountId: account.id, role: 'TENANT', status: 'ACTIVE', home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } },
          orderBy: [{ home: { postcode: 'asc' } }, { id: 'asc' }],
          select: { id: true, homeId: true, accessRevision: true, home: { select: { postcode: true, addressLine1: true, addressLine2: true, city: true, region: true, lifecycle: true, installationStatus: true, activeHubInstallationId: true } },
            tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, orderBy: { areaId: 'asc' }, select: { areaId: true, area: { select: { originalName: true, overrideName: true } } } } },
        }),
      ]);
      const currentAreas = currentMemberships.length ? await tx.area.findMany({ where: {
        homeId: { in: [...new Set(currentMemberships.map((membership) => membership.homeId))] }, status: 'ACTIVE',
      }, orderBy: [{ homeId: 'asc' }, { id: 'asc' }], select: {
        id: true, homeId: true, originalName: true, overrideName: true,
      } }) : [];
      return { links: activeLinks, memberships: currentMemberships, activeAreas: currentAreas, now: new Date() };
    });
    const scopesByMembership = new Map(links.flatMap((link) => link.homeScopes.map((scope) => [scope.membershipId, { linkId: link.id, linkRevision: link.revision, updatedAt: link.updatedAt, scope }] as const)));
    const areasByHome = new Map<string, typeof activeAreas>();
    for (const area of activeAreas) areasByHome.set(area.homeId, [...(areasByHome.get(area.homeId) ?? []), area]);
    const eligibleHomes = memberships.filter((membership) => Boolean(membership.home.activeHubInstallationId)).map((membership) => {
      const current = scopesByMembership.get(membership.id);
      const selected = new Set(current?.scope.areaSelections.map((selection) => selection.areaId) ?? []);
      const grantedAreaIds = new Set(membership.tenantAreaGrants.map((grant) => grant.areaId));
      // A combined option is presentation only, and is disclosed only if the
      // tenant currently holds every active canonical Area in that group.
      // The underlying request remains the exact authorized Area IDs.
      const areaGroups = nativeDisplayGroups(areasByHome.get(membership.homeId) ?? []).groups
        .filter((group) => group.areaIds.every((areaId) => grantedAreaIds.has(areaId)))
        .map((group) => ({ id: group.id, name: group.label, areaIds: group.areaIds }));
      const areas = membership.tenantAreaGrants.map((grant) => ({
        areaId: grant.areaId,
        name: grant.area.overrideName ?? grant.area.originalName,
        state: selected.has(grant.areaId) ? 'LINKED' : 'AVAILABLE',
        ...(current?.scope.areaSelections.find((selection) => selection.areaId === grant.areaId)?.exposureGeneration
          ? { exposureGeneration: current.scope.areaSelections.find((selection) => selection.areaId === grant.areaId)!.exposureGeneration } : {}),
      }));
      return {
        homeId: membership.homeId,
        homeMembershipId: membership.id,
        postcode: membership.home.postcode,
        address: [membership.home.addressLine1, membership.home.addressLine2, membership.home.city, membership.home.region].filter(Boolean).join(', '),
        role: 'TENANT',
        membershipRevision: membership.accessRevision,
        connectionState: current && selected.size > 0 ? 'LINKED' : 'AVAILABLE',
        linkUpdatedAt: current?.updatedAt.toISOString() ?? null,
        linkRevision: current?.linkRevision ?? null,
        scopeRevision: current?.scope.exposureGeneration ?? null,
        connectionId: current?.linkId ?? null,
        areas,
        areaGroups,
      };
    });
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true,
      enabled: process.env.DINODIA_NATIVE_ALEXA_ENABLED === 'true',
      disabledReason: process.env.DINODIA_NATIVE_ALEXA_ENABLED === 'true' ? null : 'NATIVE_ALEXA_NOT_YET_ACTIVATED',
      homes: eligibleHomes,
      checkedAt: now.toISOString(),
    }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const account = await requireCustomerAccountSession(request);
    const raw = await request.json().catch(() => null) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Stage1AuthError(400, 'alexa_intent_invalid', 'The Alexa connection request is invalid');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'areaIds,homeMembershipId' || typeof body.homeMembershipId !== 'string'
      || !Array.isArray(body.areaIds) || body.areaIds.length < 1 || body.areaIds.length > 200
      || body.areaIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      || new Set(body.areaIds).size !== body.areaIds.length) {
      throw new Stage1AuthError(400, 'alexa_intent_invalid', 'The Alexa connection request is invalid');
    }
    if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') throw new Stage1AuthError(503, 'alexa_not_activated', 'Native Alexa linking is not yet activated');
    const membershipHint = await prisma.homeMembership.findFirst({ where: {
      id: body.homeMembershipId, customerAccountId: account.id, role: 'TENANT', status: 'ACTIVE',
    }, select: { id: true, homeId: true } });
    if (!membershipHint) throw new Stage1AuthError(403, 'alexa_tenant_membership_required', 'A current tenant Home membership is required');
    const areaIds = [...body.areaIds as string[]].sort();

    const crypto = await import('node:crypto');
    const rawIntent = crypto.randomBytes(32).toString('base64url');
    const intentHash = crypto.createHash('sha256').update(rawIntent).digest('hex');
    const intent = await serializableTransaction(async (tx) => {
      await lockAndValidateAlexaAccountAuthority(tx, account, membershipHint.homeId);
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${membershipHint.id}::uuid AND "customerAccountId" = ${account.id}::uuid AND "homeId" = ${membershipHint.homeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${membershipHint.id}::uuid AND "homeId" = ${membershipHint.homeId}::uuid ORDER BY "areaId" FOR UPDATE`;
      const currentMembership = await tx.homeMembership.findFirst({ where: {
        id: membershipHint.id, customerAccountId: account.id, homeId: membershipHint.homeId, role: 'TENANT', status: 'ACTIVE',
        customerAccount: { status: 'ACTIVE', emailVerifiedAt: { not: null } },
        home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: { not: null } },
      }, select: { id: true, homeId: true, accessRevision: true, home: { select: { activeHubInstallationId: true } }, tenantAreaGrants: {
        where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true },
      } } });
      if (!currentMembership) throw new Stage1AuthError(409, 'alexa_scope_changed', 'Property access changed. Refresh and review the selected Areas');
      if (currentMembership.home.activeHubInstallationId) await tx.$queryRaw`SELECT "id" FROM "HubInstallation" WHERE "id" = ${currentMembership.home.activeHubInstallationId}::uuid AND "homeId" = ${membershipHint.homeId}::uuid FOR UPDATE`;
      const hub = currentMembership.home.activeHubInstallationId ? await tx.hubInstallation.findFirst({ where: {
        id: currentMembership.home.activeHubInstallationId, homeId: membershipHint.homeId, lifecycleStatus: 'ACTIVE',
      }, select: { id: true } }) : null;
      if (!hub) throw new Stage1AuthError(409, 'alexa_hub_unavailable', 'The selected Home does not currently have an active Dinodia hub');
      const granted = new Set(currentMembership.tenantAreaGrants.map((grant) => grant.areaId));
      if (!areaIds.every((id) => granted.has(id))) throw new Stage1AuthError(403, 'alexa_area_scope_denied', 'One or more selected Areas are not currently available');
      const selectedCount = await tx.tenantAreaGrant.count({ where: { membershipId: membershipHint.id, homeId: membershipHint.homeId, areaId: { in: areaIds }, revokedAt: null, area: { status: 'ACTIVE' } } });
      if (selectedCount !== areaIds.length) throw new Stage1AuthError(409, 'alexa_scope_changed', 'Area access changed. Refresh and review the selected Areas');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
      const row = await tx.alexaNativeConnectIntent.create({ data: {
        customerAccountId: account.id, homeId: membershipHint.homeId, membershipId: membershipHint.id, intentHash, expiresAt,
        areas: { create: areaIds.map((areaId) => ({ areaId })) },
      }, select: { id: true, expiresAt: true } });
      return row;
    });
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, intentId: intent.id, intent: rawIntent, expiresAt: intent.expiresAt.toISOString() }, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
