import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { sha256 } from '@/lib/stage1Crypto';
import { readTenantDeviceDashboard } from '@/lib/tenantDeviceDashboard';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const NAMESPACE = 'tenant-device-remove:v1';
const OPERATION = 'tenant_device_remove';

function digest(value: unknown) { return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }

export async function POST(request: Request, context: { params: Promise<{ homeId: string; deviceId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, deviceId } = await context.params;
    if (!UUID.test(homeId) || !UUID.test(deviceId) || selected.homeId !== homeId || selected.role !== 'TENANT'
      || selected.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This tenant-owned device is not available to the selected membership');
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 8192) throw new Stage1AuthError(413, 'VALIDATION_FAILED', 'The removal request is too large');
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 8192) throw new Stage1AuthError(413, 'VALIDATION_FAILED', 'The removal request is too large');
    let body: Record<string, unknown> | null = null;
    try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch { /* canonical validation below */ }
    const idempotencyKey = request.headers.get('idempotency-key') ?? '';
    const proof = typeof body?.proof === 'string' ? body.proof : '';
    if (!body || Object.keys(body).sort().join(',') !== 'expectedDescriptorRevision,expectedInventoryRevision,proof'
      || !Number.isSafeInteger(body.expectedInventoryRevision) || Number(body.expectedInventoryRevision) < 1
      || !Number.isSafeInteger(body.expectedDescriptorRevision) || Number(body.expectedDescriptorRevision) < 1
      || proof.length < 32 || proof.length > 8192 || !KEY.test(idempotencyKey)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current device revision, fresh confirmation and idempotency key are required');
    }
    const requestHash = digest({ deviceId, expectedInventoryRevision: body.expectedInventoryRevision,
      expectedDescriptorRevision: body.expectedDescriptorRevision, operation: 'remove_tenant_device' });
    const keyHash = sha256(`${selected.id}\n${idempotencyKey}`);
    const result = await serializableTransaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: NAMESPACE, keyHash } },
        select: { actorId: true, homeId: true, hubInstallationId: true, requestHash: true, responseBody: true, responseStatus: true, expiresAt: true } });
      const now = new Date();
      if (existing) {
        if (existing.actorId !== selected.id || existing.homeId !== homeId || existing.hubInstallationId !== selected.hubInstallationId
          || existing.requestHash !== requestHash || existing.expiresAt <= now || !existing.responseBody || typeof existing.responseBody !== 'object') {
          throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This removal request key is already bound to another operation');
        }
        return { receipt: existing.responseBody as Record<string, unknown>, status: existing.responseStatus };
      }
      const current = await readTenantDeviceDashboard(tx, { accountId: selected.id, sessionId: selected.sessionId,
        trustedDeviceId: selected.trustedDeviceId, tokenHash: selected.tokenHash, credentialKind: 'account_access',
        homeId, membershipId: selected.membershipId, hubInstallationId: selected.hubInstallationId });
      const device = await tx.nativeDevice.findFirst({ where: { id: deviceId, homeId, hubInstallationId: selected.hubInstallationId,
        managementClass: 'TENANT_DEVICE', ownerMembershipId: selected.membershipId, lifecycle: 'INSTALLED',
        descriptorRevision: Number(body.expectedDescriptorRevision), inventoryRevision: Number(body.expectedInventoryRevision),
        assignments: { some: { validUntil: null, areaId: { in: current.areaAccess.map((area) => area.areaId) }, area: { status: 'ACTIVE' } } } },
        select: { id: true, osDeviceId: true, descriptorRevision: true, inventoryRevision: true, assignments: { where: { validUntil: null }, select: { areaId: true } } } });
      if (!device) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The device, ownership, current Area or revision changed. Refresh before removal.');

      const value = { operation: 'remove_tenant_device', descriptorRevision: device.descriptorRevision };
      const normalizedValueDigest = operationDigest({ customerAccountId: selected.id, customerSessionId: selected.sessionId,
        trustedDeviceId: selected.trustedDeviceId, homeId, membershipId: selected.membershipId,
        hubInstallationId: selected.hubInstallationId, operationKind: OPERATION, targetIds: [device.osDeviceId], value });
      const consumed = await tx.stepUpAuthorization.updateMany({ where: { nonceHash: sha256(proof),
        customerAccountId: selected.id, customerSessionId: selected.sessionId, trustedDeviceId: selected.trustedDeviceId,
        homeId, membershipId: selected.membershipId, operationKind: OPERATION,
        targetDigest: targetDigest([device.osDeviceId]), normalizedValueDigest, policyRevision: selected.policyRevision,
        consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw new Stage1AuthError(403, 'step_up_invalid', 'A fresh confirmation for this exact device and removal action is required');

      const changedHome = await tx.home.updateMany({ where: { id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE',
        activeHubInstallationId: selected.hubInstallationId, managementRevision: current.revision.sequence },
        data: { managementRevision: { increment: 1 } } });
      if (changedHome.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The Home changed. Refresh before removing this device.');
      const changedDevice = await tx.nativeDevice.updateMany({ where: { id: device.id, homeId, hubInstallationId: selected.hubInstallationId,
        managementClass: 'TENANT_DEVICE', ownerMembershipId: selected.membershipId, lifecycle: 'INSTALLED',
        descriptorRevision: device.descriptorRevision, inventoryRevision: device.inventoryRevision },
        data: { lifecycle: 'REMOVAL_PENDING', retiredAt: now, overrideName: null, customerLabel: null,
          inventoryRevision: { increment: 1 } } });
      if (changedDevice.count !== 1) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'The device changed before removal could be recorded');
      const [layout, actionRows] = await Promise.all([
        tx.memberPreferenceDocument.findUnique({ where: { membershipId_kind: { membershipId: selected.membershipId, kind: 'DASHBOARD_LAYOUT' } }, select: { revision: true, document: true } }),
        tx.nativeAutomationAction.findMany({ where: { deviceId: device.id, homeId }, select: { automationId: true } }),
      ]);
      if (layout?.document && typeof layout.document === 'object' && !Array.isArray(layout.document)) {
        const doc = layout.document as Record<string, unknown>;
        const tiles = Array.isArray(doc.tiles) ? doc.tiles.filter((tile) => !tile || typeof tile !== 'object' || Array.isArray(tile) || (tile as Record<string, unknown>).deviceId !== device.id) : [];
        if (tiles.length !== (Array.isArray(doc.tiles) ? doc.tiles.length : 0)) await tx.memberPreferenceDocument.update({
          where: { membershipId_kind: { membershipId: selected.membershipId, kind: 'DASHBOARD_LAYOUT' } },
          data: { document: { ...doc, tiles } as Prisma.InputJsonValue, revision: { increment: 1 } },
        });
      }
      if (actionRows.length) {
        const automationIds = [...new Set(actionRows.map((row) => row.automationId))];
        await tx.nativeAutomationAction.deleteMany({ where: { deviceId: device.id, homeId } });
        await tx.nativeAutomation.updateMany({ where: { id: { in: automationIds }, homeId, status: { not: 'RETIRED' } },
          data: { status: 'NEEDS_ATTENTION', revision: { increment: 1 } } });
      }
      await Promise.all([
        tx.nativeDeviceUsageBucket.deleteMany({ where: { deviceId: device.id, homeId } }),
        tx.nativeTemperatureSample.deleteMany({ where: { deviceId: device.id, homeId } }),
        tx.nativeTenantDeviceRecovery.deleteMany({ where: { deviceId: device.id, homeId } }),
      ]);
      const incidentRows = await tx.nativeDeviceOutageIncident.findMany({ where: { deviceId: device.id, homeId }, select: { id: true } });
      if (incidentRows.length) {
        await tx.nativeDeviceOutageIncident.updateMany({ where: { homeId, causedByHubIncidentId: { in: incidentRows.map((row) => row.id) } }, data: { causedByHubIncidentId: null } });
        await tx.nativeDeviceOutageIncident.deleteMany({ where: { deviceId: device.id, homeId } });
      }
      await tx.nativeDeviceSourceAlias.deleteMany({ where: { deviceId: device.id, homeId } });
      await tx.supportTicket.updateMany({ where: { deviceId: device.id, homeId, status: { not: 'CLOSED' } }, data: {
        status: 'CLOSED', closedAt: now, selectedMembershipId: null, description: '[Device removed by its tenant owner]', title: null,
        areaId: null, deviceId: null, safeDiagnostics: Prisma.DbNull, customerResolution: null, revision: { increment: 1 },
      } });

      const receipt = { schemaVersion: 'dinodia.v1', ok: true, homeId, deviceId,
        osDeviceId: device.osDeviceId, state: 'REMOVAL_PENDING', inventoryRevision: device.inventoryRevision + 1,
        hubEnforcement: 'PENDING' };
      await tx.auditEvent.create({ data: { homeId, actorType: 'CUSTOMER', actorId: selected.id,
        category: 'MANAGEMENT', action: 'tenant_device_removal_requested', targetType: 'NativeDevice', targetId: device.id,
        metadata: { managementClass: 'TENANT_DEVICE', ownerMembershipId: selected.membershipId, hubEnforcement: 'PENDING' },
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      await tx.idempotencyRecord.create({ data: { namespace: NAMESPACE, keyHash, actorId: selected.id, homeId,
        hubInstallationId: selected.hubInstallationId, requestHash, responseStatus: 202,
        responseBody: receipt as Prisma.InputJsonValue, responseDigest: digest(receipt), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      return { receipt, status: 202 };
    });
    return NextResponse.json(result.receipt, { status: result.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
