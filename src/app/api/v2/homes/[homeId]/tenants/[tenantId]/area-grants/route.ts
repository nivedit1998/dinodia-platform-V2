import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { consumeStepUpInTransaction } from '@/lib/sensitiveOperationStepUp';
import { validateHomeownerTenantAreaGrantsReceipt, validateHomeownerTenantAreaGrantsRequest } from '@/lib/contracts/dinodiaV1';
import { homeownerIdempotencyIdentity, homeownerRequestHash, runIdempotentHomeMutation } from '@/lib/homeownerIdempotency';
import { NativeAreaAccessError, replaceTenantAreaGrants } from '@/lib/nativeAreaAccess';

export const dynamic = 'force-dynamic';
// Covers two bounded serializable attempts, connection acquisition and the
// exact-receipt/retry path without relying on the platform default duration.
export const maxDuration = 40;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PUT(request: Request, context: { params: Promise<{ homeId: string; tenantId: string }> }) {
  const startedAt = Date.now();
  let phase = 'authenticate';
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
    phase = 'transaction';
    const receipt = await serializableTransaction((tx) => runIdempotentHomeMutation(tx, {
      ...identity, actorId: selected.id, homeId, requestHash,
      validateResponse: (value): value is Record<string, unknown> =>
        validateHomeownerTenantAreaGrantsReceipt(value, homeId, tenantId),
      // A submitted exact operation may be reconciled after the target was
      // removed elsewhere. Revalidate current actor/Home authority before
      // looking up its receipt, but do not require the historical target to
      // remain active for a read of this actor's own committed result.
      beforeLookup: async () => {
        phase = 'authority_revalidation';
        await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${homeId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${selected.membershipId}::uuid FOR UPDATE`;
        const [actor, home, hub] = await Promise.all([
          tx.homeMembership.findFirst({ where: { id: selected.membershipId, customerAccountId: selected.id, homeId,
            role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE' }, select: { id: true, accessRevision: true } }),
          tx.home.findFirst({ where: { id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' },
            select: { id: true, activeHubInstallationId: true } }),
          tx.hubInstallation.findFirst({ where: { id: selected.hubInstallationId, homeId, lifecycleStatus: 'ACTIVE' },
            select: { id: true, accessPolicyRevision: true } }),
        ]);
        if (!actor || !home || !hub || home.activeHubInstallationId !== hub.id
          || Math.max(actor.accessRevision, hub.accessPolicyRevision) !== selected.policyRevision) {
          throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant Area access is unavailable for this Home');
        }
      },
      operation: async () => {
        phase = 'lock_and_validate_target';
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
          phase = 'replace_grants_and_cleanup';
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
    }), 2, { maxWaitMs: 1_500, timeoutMs: 14_000 });
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error, { operation: 'tenant_area_grants_replace', phase, startedAt }); }
}
