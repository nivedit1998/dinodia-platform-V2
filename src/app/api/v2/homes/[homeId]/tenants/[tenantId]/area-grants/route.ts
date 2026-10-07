import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { consumeStepUpInTransaction } from '@/lib/sensitiveOperationStepUp';
import { validateHomeownerTenantAreaGrantsReceipt, validateHomeownerTenantAreaGrantsRequest } from '@/lib/contracts/dinodiaV1';
import { homeownerIdempotencyIdentity, homeownerRequestHash, runIdempotentHomeMutation } from '@/lib/homeownerIdempotency';
import { NativeAreaAccessError, replaceTenantAreaGrants } from '@/lib/nativeAreaAccess';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PUT(request: Request, context: { params: Promise<{ homeId: string; tenantId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, tenantId } = await context.params;
    const key = request.headers.get('idempotency-key') ?? '';
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!uuid.test(homeId) || !uuid.test(tenantId) || selected.homeId !== homeId
      || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant Area access is unavailable for this Home');
    }
    if (!validateHomeownerTenantAreaGrantsRequest(body)
      || !body.areaIds.every((id) => uuid.test(id))) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current Area selection, revisions and fresh confirmation are required');
    }
    const areaIds = [...body.areaIds as string[]].sort();
    const identity = homeownerIdempotencyIdentity(selected.id, key, 'homeowner-tenant-area-grants:v1');
    const requestHash = homeownerRequestHash({ homeId, membershipId: selected.membershipId, tenantId, areaIds,
      expectedAccessRevision: body.expectedAccessRevision, expectedManagementRevision: body.expectedManagementRevision });
    // A retry may return its saved receipt only while the actor and target still
    // exist under current authority; an idempotency record is never authority.
    const targetIsCurrent = await prisma.homeMembership.findFirst({ where: {
      id: tenantId, homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' },
    }, select: { id: true } });
    if (!targetIsCurrent) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This tenant is no longer linked to the selected Home');

    const receipt = await serializableTransaction((tx) => runIdempotentHomeMutation(tx, {
      ...identity, actorId: selected.id, homeId, requestHash,
      operation: async () => {
        await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${homeId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${selected.membershipId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
        const [actor, target, home, hub] = await Promise.all([
          tx.homeMembership.findFirst({ where: { id: selected.membershipId, customerAccountId: selected.id, homeId, role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE' }, select: { id: true, accessRevision: true } }),
          tx.homeMembership.findFirst({ where: { id: tenantId, homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { id: true, accessRevision: true } }),
          tx.home.findFirst({ where: { id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, managementRevision: true, activeHubInstallationId: true } }),
          tx.hubInstallation.findFirst({ where: { id: selected.hubInstallationId, homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true, accessPolicyRevision: true } }),
        ]);
        if (!actor || !target || !home || !hub || home.activeHubInstallationId !== hub.id) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant Area access is unavailable for this Home');
        const currentPolicyRevision = Math.max(actor.accessRevision, hub.accessPolicyRevision);
        if (currentPolicyRevision !== selected.policyRevision) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Home access policy changed. Refresh and confirm again.');
        await consumeStepUpInTransaction(tx, {
          proof: body.proof as string, customerAccountId: selected.id, customerSessionId: selected.sessionId,
          trustedDeviceId: selected.trustedDeviceId, homeId, membershipId: actor.id, hubInstallationId: hub.id,
          operationKind: 'tenant_area_grants_replace', targetIds: [tenantId],
          value: { areaIds, expectedAccessRevision: body.expectedAccessRevision, expectedManagementRevision: body.expectedManagementRevision },
          policyRevision: currentPolicyRevision,
        });
        try {
          const changed = await replaceTenantAreaGrants(tx, { actorAccountId: selected.id, actorMembershipId: actor.id,
            tenantMembershipId: tenantId, homeId, areaIds,
            expectedManagementRevision: Number(body.expectedManagementRevision), expectedAccessRevision: Number(body.expectedAccessRevision) });
          return { schemaVersion: 'dinodia.v1', ok: true, homeId, tenantMembershipId: tenantId,
            areaIds, ...changed };
        } catch (error) {
          if (error instanceof NativeAreaAccessError) {
            if (error.code === 'MEMBERSHIP_FORBIDDEN' || error.code === 'AREA_FORBIDDEN') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'The tenant or one of the selected Areas is unavailable');
            if (error.code === 'REVISION_CONFLICT') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Tenant access changed. Refresh and try again.');
            throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The Area selection is invalid');
          }
          throw error;
        }
      },
    }));
    if (!validateHomeownerTenantAreaGrantsReceipt(receipt, homeId, tenantId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The tenant Area-access receipt failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
