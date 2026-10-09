import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { homeownerIdempotencyIdentity, homeownerRequestHash, runIdempotentHomeMutation } from '@/lib/homeownerIdempotency';
import { automationDefinitionChecksum, assertNoNativeAutomationConflict, NativeAutomationError, validateNativeAutomationDefinition } from '@/lib/nativeAutomations/validation';
import { refreshNativeAutomationCloudRevision } from '@/lib/nativeAutomations/delivery';
import { lockAndValidateTenantAutomationAuthority } from '@/lib/nativeAutomations/tenantAuthority';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ automationId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const principal = await requireCustomerSelectedHome(request);
    if (principal.role !== 'TENANT') throw new Stage1AuthError(403, 'home_membership_forbidden', 'Only the owning tenant can change this automation');
    const { automationId } = await context.params;
    const raw = await request.json() as Record<string, unknown>;
    if (!raw || Object.keys(raw).sort().join(',') !== 'enabled,expectedRevision' || typeof raw.enabled !== 'boolean' || !Number.isSafeInteger(raw.expectedRevision)) throw new NativeAutomationError(400, 'AUTOMATION_INVALID', 'The enable request is incomplete');
    const identity = homeownerIdempotencyIdentity(principal.id, request.headers.get('idempotency-key') ?? '', `tenant-automation-enabled:${principal.homeId}:${automationId}`);
    const result = await serializableTransaction(async (tx) => runIdempotentHomeMutation(tx, {
      namespace: identity.namespace, keyHash: identity.keyHash, actorId: principal.id, homeId: principal.homeId, requestHash: homeownerRequestHash(raw),
      beforeLookup: async () => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-automation-home:${principal.homeId}`}, 0)) IS NULL AS acquired`;
        await lockAndValidateTenantAutomationAuthority(tx, principal);
      },
      operation: async () => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-automation-home:${principal.homeId}`}, 0)) IS NULL AS acquired`;
        const [membership, home, hub, row] = await Promise.all([
          tx.homeMembership.findFirst({ where: { id: principal.membershipId, customerAccountId: principal.id, homeId: principal.homeId, role: 'TENANT', status: 'ACTIVE', customerAccount: { status: 'ACTIVE' } }, select: { id: true, tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } }),
          tx.home.findFirst({ where: { id: principal.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true, timezone: true, managementRevision: true, activeHubInstallationId: true } }),
          tx.hubInstallation.findFirst({ where: { id: principal.hubInstallationId, homeId: principal.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true, cloudConfigurationRevision: true, acknowledgedCloudRevision: true } }),
          tx.nativeAutomation.findFirst({ where: { id: automationId, homeId: principal.homeId, createdByMembershipId: principal.membershipId, status: { not: 'RETIRED' } }, select: { id: true, name: true, status: true, revision: true, timezone: true, triggers: { take: 1, select: { id: true, configuration: true } }, actions: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, deviceId: true, areaId: true, controlId: true, sortOrder: true, descriptorRevision: true, actionValue: true } } } }),
        ]);
        if (!membership || !home || !hub || home.activeHubInstallationId !== hub.id || !row) throw new NativeAutomationError(404, 'AUTOMATION_NOT_FOUND', 'This automation is not available');
        if (Number(raw.expectedRevision) !== row.revision) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation changed. Reload it before continuing');
        const enabled = raw.enabled as boolean;
        let validatedDefinition: Awaited<ReturnType<typeof validateNativeAutomationDefinition>> | null = null;
        if (enabled) {
          if (hub.acknowledgedCloudRevision < hub.cloudConfigurationRevision) throw new NativeAutomationError(409, 'AUTOMATION_DELIVERY_PENDING', 'Wait for the hub to confirm the previous change before enabling this automation');
          const trigger = row.triggers[0]?.configuration;
          if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new NativeAutomationError(409, 'AUTOMATION_TRIGGER_INVALID', 'This automation needs attention before it can be enabled');
          validatedDefinition = await validateNativeAutomationDefinition(tx, { homeId: home.id, membershipId: membership.id, grantedAreaIds: membership.tenantAreaGrants.map((grant) => grant.areaId), raw: {
            name: row.name, trigger, actions: row.actions.map((action) => ({ deviceId: action.deviceId, areaId: action.areaId, controlId: action.controlId, targetValue: action.actionValue })),
          } });
          await assertNoNativeAutomationConflict(tx, { homeId: home.id, candidate: validatedDefinition, excludeAutomationId: row.id });
          const currentActions = new Map(row.actions.map((action) => [`${action.deviceId}:${action.controlId}`, action]));
          const validatedAt = new Date();
          for (const action of validatedDefinition.actions) {
            const current = currentActions.get(`${action.deviceId}:${action.controlId}`);
            if (!current) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation target changed. Edit and save the rule before enabling it');
            const updatedAction = await tx.nativeAutomationAction.updateMany({ where: { id: current.id, automationId: row.id, homeId: home.id },
              data: { areaId: action.areaId, sortOrder: action.sortOrder, descriptorRevision: action.descriptorRevision,
                actionValue: action.targetValue as Prisma.InputJsonValue, needsAttention: false, lastValidatedAt: validatedAt } });
            if (updatedAction.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'An automation target changed during validation');
          }
        }
        const revision = row.revision + 1;
        const status = enabled ? 'ACTIVE' : 'PAUSED';
        const definitionChecksum = enabled && validatedDefinition
          ? automationDefinitionChecksum({ name: validatedDefinition.name, timezone: home.timezone, minuteOfDay: validatedDefinition.minuteOfDay,
            weekdays: validatedDefinition.weekdays, actions: validatedDefinition.actions.map(({ deviceId, areaId, controlId, descriptorRevision, targetValue, sortOrder }) =>
              ({ deviceId, areaId, controlId, descriptorRevision, targetValue, sortOrder })) })
          : automationDefinitionChecksum({ id: row.id, revision, name: row.name, status, timezone: home.timezone ?? row.timezone,
            trigger: row.triggers[0]?.configuration ?? null, actions: row.actions.map((action) => ({ id: action.id, deviceId: action.deviceId, areaId: action.areaId, controlId: action.controlId, targetValue: action.actionValue })) });
        const updated = await tx.nativeAutomation.updateMany({ where: { id: row.id, revision: row.revision, status: { not: 'RETIRED' } }, data: { status, revision, enabledAt: enabled ? new Date() : null, definitionChecksum, timezone: home.timezone ?? row.timezone } });
        if (updated.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'This automation changed. Reload it before continuing');
        const homeUpdated = await tx.home.updateMany({ where: { id: home.id, managementRevision: home.managementRevision }, data: { managementRevision: { increment: 1 } } });
        if (homeUpdated.count !== 1) throw new NativeAutomationError(409, 'AUTOMATION_REVISION_CONFLICT', 'The Home changed while updating this automation');
        await refreshNativeAutomationCloudRevision(tx, { homeId: home.id, hubInstallationId: hub.id });
        await tx.auditEvent.create({ data: { homeId: home.id, actorType: 'CUSTOMER', actorId: principal.id, category: 'ACCESS', action: enabled ? 'tenant_automation_enabled' : 'tenant_automation_disabled', targetType: 'NativeAutomation', targetId: row.id, metadata: { revision, status }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
        return { ok: true, automationId: row.id, revision, status: enabled ? 'waiting_for_hub' : 'disabled_waiting_for_hub' };
      },
    }));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
