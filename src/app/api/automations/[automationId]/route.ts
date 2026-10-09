import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { homeownerIdempotencyIdentity, homeownerRequestHash, runIdempotentHomeMutation } from '@/lib/homeownerIdempotency';
import { automationDefinitionChecksum, assertNoNativeAutomationConflict, NativeAutomationError, validateNativeAutomationDefinition } from '@/lib/nativeAutomations/validation';
import { refreshNativeAutomationCloudRevision } from '@/lib/nativeAutomations/delivery';
import { retireNativeAutomations } from '@/lib/nativeAutomations/lifecycle';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ automationId: string }> };

function failure(error: unknown) { return nativeV1ErrorResponse(error); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024) throw new NativeAutomationError(413, 'AUTOMATION_INVALID', 'The automation details are too large');
  try { return JSON.parse(text); } catch { throw new NativeAutomationError(400, 'AUTOMATION_INVALID', 'The automation details are not valid JSON'); }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const principal = await requireCustomerSelectedHome(request);
    if (principal.role !== 'TENANT') throw new Stage1AuthError(403, 'home_membership_forbidden', 'Tenant automation access is limited to the selected tenant membership');
    const { automationId } = await context.params;
    const row = await (await import('@/lib/prisma')).prisma.nativeAutomation.findFirst({ where: { id: automationId, homeId: principal.homeId, createdByMembershipId: principal.membershipId, status: { not: 'RETIRED' } }, select: {
      id: true, name: true, status: true, revision: true, definitionChecksum: true, timezone: true,
      triggers: { take: 1, orderBy: { id: 'asc' }, select: { id: true, kind: true, configuration: true, revision: true } },
      actions: { take: 32, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, deviceId: true, areaId: true, controlId: true, sortOrder: true, descriptorRevision: true, actionValue: true, needsAttention: true } },
    } });
    if (!row) throw new NativeAutomationError(404, 'AUTOMATION_NOT_FOUND', 'This automation is not available');
    return NextResponse.json({ ok: true, automation: row }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const principal = await requireCustomerSelectedHome(request);
    if (principal.role !== 'TENANT') throw new Stage1AuthError(403, 'home_membership_forbidden', 'Only the owning tenant can edit an automation');
    const { automationId } = await context.params;
    const raw = await body(request);
    if (!object(raw) || Object.keys(raw).sort().join(',') !== 'definition,expectedRevision' || !Number.isSafeInteger(raw.expectedRevision) || !object(raw.definition)) throw new NativeAutomationError(400, 'AUTOMATION_INVALID', 'The automation update is incomplete');
    const idempotency = homeownerIdempotencyIdentity(principal.id, request.headers.get('idempotency-key') ?? '', `tenant-automation-update:${principal.homeId}:${automationId}`);
    const result = await serializableTransaction(async (tx) => runIdempotentHomeMutation(tx, {
      namespace: idempotency.namespace, keyHash: idempotency.keyHash, actorId: principal.id, homeId: principal.homeId, requestHash: homeownerRequestHash(raw),
      operation: async () => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-automation-home:${principal.homeId}`}, 0)) IS NULL AS acquired`;
        const [membership, home, current] = await Promise.all([
          tx.homeMembership.findFirst({ where: { id: principal.membershipId, customerAccountId: principal.id, homeId: principal.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { id: true, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } }),
          tx.home.findFirst({ where: { id: principal.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, timezone: true, managementRevision: true, activeHubInstallationId: true } }),
          tx.nativeAutomation.findFirst({ where: { id: automationId, homeId: principal.homeId, createdByMembershipId: principal.membershipId, status: { not: 'RETIRED' } }, select: { id: true, name: true, status: true, revision: true, timezone: true, triggers: { take: 1, orderBy: { id: 'asc' }, select: { id: true, revision: true } }, actions: { select: { id: true, deviceId: true, controlId: true } } } }),
        ]);
        if (!membership || !home || !current) throw new NativeAutomationError(404, 'AUTOMATION_NOT_FOUND', 'This automation is not available');
        if (!home.timezone) throw new NativeAutomationError(409, 'AUTOMATION_TRIGGER_INVALID', 'The Home time zone is not configured');
        if (current.revision !== raw.expectedRevision) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation changed. Reload the latest version before saving');
        const definition = await validateNativeAutomationDefinition(tx, { homeId: home.id, membershipId: membership.id, grantedAreaIds: membership.tenantAreaGrants.map((grant) => grant.areaId), raw: raw.definition });
        if (current.status === 'ACTIVE') await assertNoNativeAutomationConflict(tx, { homeId: home.id, candidate: definition, excludeAutomationId: current.id });
        const revision = current.revision + 1;
        const nextStatus = current.status === 'NEEDS_ATTENTION' ? 'PAUSED' : current.status;
        const definitionChecksum = automationDefinitionChecksum({ name: definition.name, timezone: home.timezone, minuteOfDay: definition.minuteOfDay, weekdays: definition.weekdays,
          actions: definition.actions.map(({ deviceId, areaId, controlId, descriptorRevision, targetValue, sortOrder }) => ({ deviceId, areaId, controlId, descriptorRevision, targetValue, sortOrder })) });
        const changed = await tx.nativeAutomation.updateMany({ where: { id: current.id, homeId: home.id, revision: current.revision, status: { not: 'RETIRED' } }, data: { name: definition.name, timezone: home.timezone ?? current.timezone, status: nextStatus, enabledAt: nextStatus === 'ACTIVE' ? new Date() : null, revision, definitionChecksum,
          propertyImpact: definition.actions.some((action) => action.managementClass === 'PROPERTY_DEVICE') } });
        if (changed.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation changed. Reload the latest version before saving');
        const priorTrigger = current.triggers[0];
        if (priorTrigger) await tx.nativeAutomationTrigger.update({ where: { id: priorTrigger.id }, data: { kind: 'SCHEDULE', configuration: { minuteOfDay: definition.minuteOfDay, weekdays: definition.weekdays } as Prisma.InputJsonValue, revision: { increment: 1 } } });
        else await tx.nativeAutomationTrigger.create({ data: { id: randomUUID(), automationId: current.id, kind: 'SCHEDULE', configuration: { minuteOfDay: definition.minuteOfDay, weekdays: definition.weekdays } as Prisma.InputJsonValue, revision: 1 } });
        const remaining = new Map(current.actions.map((action) => [`${action.deviceId}:${action.controlId}`, action]));
        for (const action of definition.actions) {
          const key = `${action.deviceId}:${action.controlId}`;
          const prior = remaining.get(key); remaining.delete(key);
          const data = { homeId: home.id, areaId: action.areaId, sortOrder: action.sortOrder, descriptorRevision: action.descriptorRevision, actionValue: action.targetValue as Prisma.InputJsonValue, needsAttention: false, lastValidatedAt: new Date() };
          if (prior) await tx.nativeAutomationAction.update({ where: { id: prior.id }, data });
          else await tx.nativeAutomationAction.create({ data: { id: randomUUID(), automationId: current.id, deviceId: action.deviceId, controlId: action.controlId, ...data } });
        }
        if (remaining.size) await tx.nativeAutomationAction.deleteMany({ where: { id: { in: [...remaining.values()].map((action) => action.id) }, automationId: current.id, homeId: home.id } });
        const revisionWrite = await tx.home.updateMany({ where: { id: home.id, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
        if (revisionWrite.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'The Home changed while saving this automation');
        if (!home.activeHubInstallationId) throw new NativeAutomationError(409, 'HUB_UNAVAILABLE', 'The selected Home has no current hub');
        const delivery = await refreshNativeAutomationCloudRevision(tx, { homeId: home.id, hubInstallationId: home.activeHubInstallationId });
        await tx.auditEvent.create({ data: { homeId: home.id, actorType: 'CUSTOMER', actorId: principal.id, category: 'ACCESS', action: 'tenant_automation_updated', targetType: 'NativeAutomation', targetId: current.id, metadata: { revision, actionCount: definition.actions.length, definitionChecksum }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
        return { ok: true, automationId: current.id, revision, deliveryState: delivery.changed ? 'pending_delivery' : 'waiting_for_activation' };
      },
    }));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const principal = await requireCustomerSelectedHome(request);
    if (principal.role !== 'TENANT') throw new Stage1AuthError(403, 'home_membership_forbidden', 'Only the owning tenant can delete this automation');
    const { automationId } = await context.params;
    const raw = await body(request);
    if (!object(raw) || Object.keys(raw).length !== 1 || !Number.isSafeInteger(raw.expectedRevision)) throw new NativeAutomationError(400, 'AUTOMATION_INVALID', 'The deletion request is incomplete');
    const idempotency = homeownerIdempotencyIdentity(principal.id, request.headers.get('idempotency-key') ?? '', `tenant-automation-delete:${principal.homeId}:${automationId}`);
    const result = await serializableTransaction(async (tx) => runIdempotentHomeMutation(tx, {
      namespace: idempotency.namespace, keyHash: idempotency.keyHash, actorId: principal.id, homeId: principal.homeId, requestHash: homeownerRequestHash(raw),
      operation: async () => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-automation-home:${principal.homeId}`}, 0)) IS NULL AS acquired`;
        const [membership, home, current] = await Promise.all([
          tx.homeMembership.findFirst({ where: { id: principal.membershipId, customerAccountId: principal.id, homeId: principal.homeId, role: 'TENANT', status: 'ACTIVE' }, select: { id: true } }),
          tx.home.findFirst({ where: { id: principal.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, managementRevision: true, activeHubInstallationId: true } }),
          tx.nativeAutomation.findFirst({ where: { id: automationId, homeId: principal.homeId, createdByMembershipId: principal.membershipId, status: { not: 'RETIRED' } }, select: { id: true, revision: true } }),
        ]);
        if (!membership || !home || !current) throw new NativeAutomationError(404, 'AUTOMATION_NOT_FOUND', 'This automation is not available');
        if (current.revision !== raw.expectedRevision) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation changed. Reload the latest version before removing it');
        const revision = current.revision + 1;
        await retireNativeAutomations(tx, { homeId: home.id, automationIds: [current.id], now: new Date(), actorId: principal.id, reason: 'tenant_deleted_automation' });
        const revisionWrite = await tx.home.updateMany({ where: { id: home.id, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
        if (revisionWrite.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'The Home changed while removing this automation');
        if (!home.activeHubInstallationId) throw new NativeAutomationError(409, 'HUB_UNAVAILABLE', 'The selected Home has no current hub');
        await refreshNativeAutomationCloudRevision(tx, { homeId: home.id, hubInstallationId: home.activeHubInstallationId });
        await tx.auditEvent.create({ data: { homeId: home.id, actorType: 'CUSTOMER', actorId: principal.id, category: 'ACCESS', action: 'tenant_automation_deleted', targetType: 'NativeAutomation', targetId: current.id, metadata: { revision, definitionRemoved: true }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
        return { ok: true, automationId: current.id, revision, deliveryState: 'pending_hub_removal' };
      },
    }));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return failure(error); }
}
