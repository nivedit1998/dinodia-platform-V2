import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { homeownerIdempotencyIdentity, homeownerRequestHash, runIdempotentHomeMutation } from '@/lib/homeownerIdempotency';
import { automationDefinitionChecksum, assertNoNativeAutomationConflict, NativeAutomationError, validateNativeAutomationDefinition } from '@/lib/nativeAutomations/validation';
import { listTenantAutomationSummaries } from '@/lib/nativeAutomations/summaries';
import { refreshNativeAutomationCloudRevision } from '@/lib/nativeAutomations/delivery';

export const dynamic = 'force-dynamic';

function requestFailure(error: unknown) {
  if (error instanceof NativeAutomationError) return nativeV1ErrorResponse(Object.assign(error, { status: error.status }));
  return nativeV1ErrorResponse(error);
}

export async function GET(request: Request) {
  try {
    const principal = await requireCustomerSelectedHome(request);
    if (principal.role !== 'TENANT') throw new Stage1AuthError(403, 'home_membership_forbidden', 'Tenant automation access is limited to the selected tenant membership');
    const projection = await listTenantAutomationSummaries({ homeId: principal.homeId, membershipId: principal.membershipId });
    return NextResponse.json(projection, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return requestFailure(error); }
}

async function boundedJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024) throw new NativeAutomationError(413, 'AUTOMATION_INVALID', 'The automation details are too large');
  try { return JSON.parse(text); } catch { throw new NativeAutomationError(400, 'AUTOMATION_INVALID', 'The automation details are not valid JSON'); }
}

export async function POST(request: Request) {
  try {
    const principal = await requireCustomerSelectedHome(request);
    if (principal.role !== 'TENANT') throw new Stage1AuthError(403, 'home_membership_forbidden', 'Only the selected tenant can create a tenant automation');
    const raw = await boundedJson(request);
    const key = request.headers.get('idempotency-key') ?? '';
    const identity = homeownerIdempotencyIdentity(principal.id, key, `tenant-automation-create:${principal.homeId}`);
    const response = await serializableTransaction(async (tx) => runIdempotentHomeMutation(tx, {
      namespace: identity.namespace, keyHash: identity.keyHash, actorId: principal.id, homeId: principal.homeId,
      requestHash: homeownerRequestHash(raw),
      operation: async () => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-automation-home:${principal.homeId}`}, 0)) IS NULL AS acquired`;
        const [membership, home] = await Promise.all([
          tx.homeMembership.findFirst({ where: { id: principal.membershipId, customerAccountId: principal.id, homeId: principal.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { id: true, accessRevision: true, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } }),
          tx.home.findFirst({ where: { id: principal.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, timezone: true, managementRevision: true, activeHubInstallationId: true } }),
        ]);
        if (!membership || !home || !home.activeHubInstallationId) throw new Stage1AuthError(404, 'home_membership_forbidden', 'The selected Home is not currently available');
        if (!home.timezone) throw new NativeAutomationError(409, 'AUTOMATION_TRIGGER_INVALID', 'The Home time zone is not configured');
        try { new Intl.DateTimeFormat('en', { timeZone: home.timezone }); } catch { throw new NativeAutomationError(409, 'AUTOMATION_TRIGGER_INVALID', 'The Home time zone is not valid'); }
        const count = await tx.nativeAutomation.count({ where: { homeId: home.id, status: { not: 'RETIRED' } } });
        if (count >= 100) throw new NativeAutomationError(409, 'AUTOMATION_ACTIONS_INVALID', 'This Home has reached its automation limit');
        const definition = await validateNativeAutomationDefinition(tx, { homeId: home.id, membershipId: membership.id, grantedAreaIds: membership.tenantAreaGrants.map((grant) => grant.areaId), raw });
        await assertNoNativeAutomationConflict(tx, { homeId: home.id, candidate: definition });
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const normalized = { name: definition.name, timezone: home.timezone, minuteOfDay: definition.minuteOfDay, weekdays: definition.weekdays,
          actions: definition.actions.map(({ deviceId, areaId, controlId, descriptorRevision, targetValue, sortOrder }) => ({ deviceId, areaId, controlId, descriptorRevision, targetValue, sortOrder })) };
        const definitionChecksum = automationDefinitionChecksum(normalized);
        const nextManagementRevision = home.managementRevision + 1;
        const updatedHome = await tx.home.updateMany({ where: { id: home.id, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
        if (updatedHome.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'The Home changed while this automation was being saved');
        const created = await tx.nativeAutomation.create({ data: {
          id: automationId, homeId: home.id, createdByMembershipId: membership.id, name: definition.name, status: 'ACTIVE', revision: 1,
          propertyImpact: definition.actions.some((action) => action.managementClass === 'PROPERTY_DEVICE'),
          definitionChecksum, timezone: home.timezone, enabledAt: new Date(), triggers: { create: { id: triggerId, kind: 'SCHEDULE', configuration: { minuteOfDay: definition.minuteOfDay, weekdays: definition.weekdays } as Prisma.InputJsonValue, revision: 1 } },
          actions: { create: definition.actions.map((action) => ({ homeId: home.id, deviceId: action.deviceId, areaId: action.areaId, controlId: action.controlId, sortOrder: action.sortOrder, descriptorRevision: action.descriptorRevision, actionValue: action.targetValue as Prisma.InputJsonValue, needsAttention: false, lastValidatedAt: new Date() })) },
        }, select: { id: true, revision: true } });
        if (!home.activeHubInstallationId) throw new NativeAutomationError(409, 'HUB_UNAVAILABLE', 'The selected Home has no current hub');
        const delivery = await refreshNativeAutomationCloudRevision(tx, { homeId: home.id, hubInstallationId: home.activeHubInstallationId });
        await tx.auditEvent.create({ data: { homeId: home.id, actorType: 'CUSTOMER', actorId: principal.id, category: 'ACCESS', action: 'tenant_automation_created', targetType: 'NativeAutomation', targetId: created.id,
          metadata: { revision: created.revision, actionCount: definition.actions.length, managementRevision: nextManagementRevision, definitionChecksum }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
        return { ok: true, automationId: created.id, revision: created.revision, managementRevision: nextManagementRevision, deliveryState: delivery.changed ? 'pending_delivery' : 'waiting_for_activation' };
      },
    }));
    return NextResponse.json(response, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return requestFailure(error); }
}
