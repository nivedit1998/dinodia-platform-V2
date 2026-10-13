import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { sha256 } from '@/lib/stage1Crypto';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { EMPLOYEE_SESSION_SECONDS, OPERATOR_SESSION_SECONDS } from '@/lib/stage1SessionPolicy';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMESPACE = 'native-property-device-analytics-category:v1';
const CATEGORIES = new Set(['NONE', 'LIGHT', 'BOILER', 'RADIATOR']);
type AnalyticsCategory = 'NONE' | 'LIGHT' | 'BOILER' | 'RADIATOR';
type Body = Record<string, unknown>;

function fail(status: number, code: string, message: string): never { throw new Stage1AuthError(status, code, message); }
function exactKeys(value: Body, keys: string[]) { return Object.keys(value).sort().join('|') === [...keys].sort().join('|'); }

async function currentAssignedStaff(tx: Prisma.TransactionClient, input: Body, hub: Awaited<ReturnType<typeof authenticateHub>>) {
  const employeeId = String(input.employeeId || '');
  const employeeSessionId = String(input.employeeSessionId || '');
  const handoffId = String(input.operatorHandoffId || '');
  const workItemId = String(input.workItemId || '');
  const workRevision = Number(input.workRevision);
  const identityGeneration = Number(input.identityGeneration);
  const operatorJti = String(input.operatorJti || '');
  const accessScope = String(input.accessScope || '');
  const requestId = String(input.requestId || '');
  if (![employeeId, employeeSessionId, handoffId, workItemId].every((value) => UUID.test(value))
    || !Number.isSafeInteger(workRevision) || workRevision < 1 || identityGeneration !== hub.identity.identityGeneration
    || !/^[A-Za-z0-9_-]{16,128}$/.test(operatorJti) || !['os:admin', 'os:permanent-installation'].includes(accessScope)) {
    fail(403, 'analytics_category_authority_denied', 'Current assigned staff authority is required');
  }
  const now = new Date();
  const [employee, employeeSession, handoff, work, home] = await Promise.all([
    tx.companyEmployeeAccount.findFirst({ where: { id: employeeId, status: 'ACTIVE', role: { in: ['INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'CXO'] } }, select: { id: true, role: true } }),
    tx.employeeSession.findFirst({ where: { id: employeeSessionId, employeeId, status: 'ACTIVE', revokedAt: null }, select: { id: true, employeeId: true, status: true, createdAt: true, expiresAt: true } }),
    tx.operatorHandoff.findFirst({ where: { id: handoffId, employeeId, workflowId: workItemId, homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, consumedAt: { not: null }, revokedAt: null }, select: { id: true, createdAt: true, scope: true } }),
    tx.companyOperationalWorkItem.findFirst({ where: { id: workItemId, homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, assignedEmployeeId: employeeId,
      state: accessScope === 'os:permanent-installation' ? 'IN_PROGRESS' : { in: ['ASSIGNED', 'IN_PROGRESS', 'REOPENED'] }, workRevision, certifiedSerialNumber: hub.identity.serialNumber },
    select: { id: true, homeId: true, hubInstallationId: true, assignedEmployeeId: true, state: true, workRevision: true, permanentInstallationRequestId: true } }),
    tx.home.findFirst({ where: { id: hub.installation.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: hub.installation.id }, select: { id: true, managementRevision: true } }),
  ]);
  const scope = handoff?.scope && typeof handoff.scope === 'object' && !Array.isArray(handoff.scope) ? handoff.scope as Record<string, unknown> : {};
  const scopes = Array.isArray(scope.scopes) ? scope.scopes.map(String) : [];
  const issuedAt = Number(scope.operatorIssuedAt);
  const expiresAt = Number(scope.operatorExpiresAt);
  if (!employee || !employeeSession || !handoff || !work || !home
    || employeeSession.expiresAt.getTime() - employeeSession.createdAt.getTime() > EMPLOYEE_SESSION_SECONDS * 1000
    || handoff.createdAt >= employeeSession.expiresAt || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || issuedAt < handoff.createdAt.getTime() - 1000 || expiresAt <= now.getTime() || expiresAt - issuedAt !== OPERATOR_SESSION_SECONDS * 1000
    || String(scope.employeeSessionId || '') !== employeeSession.id || String(scope.operatorJti || '') !== operatorJti
    || Number(scope.workRevision) !== workRevision || Number(scope.identityGeneration) !== identityGeneration
    || String(scope.serialNumber || '') !== hub.identity.serialNumber || !scopes.includes(accessScope)) {
    fail(403, 'analytics_category_authority_denied', 'The assigned work or operator session has expired or changed');
  }
  if (accessScope === 'os:permanent-installation') {
    if (!UUID.test(requestId) || requestId !== work.permanentInstallationRequestId) fail(403, 'analytics_category_authority_denied', 'The assigned installation request is no longer current');
    const request = await tx.permanentDeviceInstallationRequest.findFirst({ where: { id: requestId, homeId: home.id, status: 'IN_PROGRESS', workItem: { is: { id: work.id, assignedEmployeeId: employeeId, workRevision } } }, select: { id: true } });
    if (!request) fail(403, 'analytics_category_authority_denied', 'The assigned installation request is no longer current');
  } else if (Object.hasOwn(input, 'requestId')) {
    fail(400, 'analytics_category_request_invalid', 'A full-Home update must not claim installation-only request authority');
  }
  return { employee, employeeSession, handoff, work, home, actorId: employee.id, accessScope };
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { maxBodyBytes: 16 * 1024 });
    const body = { ...hub.body };
    delete body.serial;
    const accessScope = String(body.accessScope || '');
    const required = ['accessScope', 'homeId', 'hubInstallationId', 'identityGeneration', 'employeeId', 'employeeSessionId', 'operatorHandoffId',
      'operatorJti', 'workItemId', 'workRevision', 'osDeviceId', 'expectedManagementRevision', 'expectedAnalyticsCategory', 'analyticsCategory', 'operationId'];
    if (accessScope === 'os:permanent-installation') required.push('requestId');
    const allowed = [...required, ...(Object.hasOwn(body, 'expectedInventoryRevision') ? ['expectedInventoryRevision'] : [])];
    if (!exactKeys(body, allowed) || body.homeId !== hub.installation.homeId || body.hubInstallationId !== hub.installation.id
      || !UUID.test(String(body.operationId || '')) || !/^[A-Za-z0-9:_-]{1,160}$/.test(String(body.osDeviceId || ''))
      || !CATEGORIES.has(String(body.expectedAnalyticsCategory)) || !CATEGORIES.has(String(body.analyticsCategory))
      || !Number.isSafeInteger(body.expectedManagementRevision) || Number(body.expectedManagementRevision) < 1
      || Object.hasOwn(body, 'expectedInventoryRevision') && (!Number.isSafeInteger(body.expectedInventoryRevision) || Number(body.expectedInventoryRevision) < 1)) {
      fail(400, 'analytics_category_request_invalid', 'The permanent-device analytics category request is invalid');
    }

    return await prisma.$transaction(async (tx) => {
      const authority = await currentAssignedStaff(tx, body, hub);
      const device = await tx.nativeDevice.findFirst({ where: { homeId: authority.home.id, hubInstallationId: hub.installation.id, osDeviceId: String(body.osDeviceId),
        managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] }, retiredAt: null },
      select: { id: true, osDeviceId: true, analyticsCategory: true, inventoryRevision: true, assignments: { where: { validUntil: null, area: { homeId: authority.home.id, status: 'ACTIVE' } }, select: { areaId: true }, take: 8 } } });
      if (!device || device.assignments.length === 0) fail(404, 'analytics_category_device_unavailable', 'Only an active permanent property device in a current Home Area can be updated');
      const requestHash = sha256(JSON.stringify({ homeId: authority.home.id, hubInstallationId: hub.installation.id, employeeId: authority.employee.id,
        workItemId: authority.work.id, workRevision: authority.work.workRevision, osDeviceId: device.osDeviceId,
        expectedManagementRevision: Number(body.expectedManagementRevision), expectedInventoryRevision: body.expectedInventoryRevision ?? null,
        expectedAnalyticsCategory: body.expectedAnalyticsCategory, analyticsCategory: body.analyticsCategory }));
      const keyHash = sha256(String(body.operationId));
      const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: NAMESPACE, keyHash } }, select: { actorId: true, homeId: true, hubInstallationId: true, requestHash: true, responseBody: true } });
      if (prior) {
        if (prior.actorId !== authority.actorId || prior.homeId !== authority.home.id || prior.hubInstallationId !== hub.installation.id || prior.requestHash !== requestHash
          || !prior.responseBody || typeof prior.responseBody !== 'object') fail(409, 'analytics_category_idempotency_conflict', 'This update key is already bound to different permanent-device details');
        return NextResponse.json({ ...(prior.responseBody as Record<string, unknown>), idempotentReplay: true }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (device.analyticsCategory !== body.expectedAnalyticsCategory) fail(409, 'analytics_category_revision_conflict', 'The device category changed; refresh the signed device policy before retrying');
      if (Object.hasOwn(body, 'expectedInventoryRevision') && device.inventoryRevision !== body.expectedInventoryRevision) fail(409, 'analytics_category_revision_conflict', 'The permanent device changed; refresh the signed device policy before retrying');
      // Category edits are device-scoped. A different, unrelated Home update
      // may advance the global management revision after the staff dashboard
      // loaded; the exact category and device inventory revision above remain
      // the compare-and-swap guards for this mutation. Reject only a revision
      // from the future (which cannot have come from the current signed view).
      if (Number(body.expectedManagementRevision) > authority.home.managementRevision) fail(409, 'analytics_category_revision_conflict', 'The signed Home configuration is newer than the current Home; refresh before changing this category');

      const changedHome = await tx.home.updateMany({ where: { id: authority.home.id, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: hub.installation.id,
        managementRevision: authority.home.managementRevision }, data: { managementRevision: { increment: body.analyticsCategory === body.expectedAnalyticsCategory ? 0 : 1 } } });
      if (changedHome.count !== 1) fail(409, 'analytics_category_revision_conflict', 'The Home configuration changed; refresh the dashboard before changing this category');
      const changedDevice = body.analyticsCategory === body.expectedAnalyticsCategory ? { count: 1 } : await tx.nativeDevice.updateMany({ where: {
        id: device.id, homeId: authority.home.id, hubInstallationId: hub.installation.id, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null,
        lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] }, analyticsCategory: body.expectedAnalyticsCategory as AnalyticsCategory,
        ...(Object.hasOwn(body, 'expectedInventoryRevision') ? { inventoryRevision: body.expectedInventoryRevision as number } : {}),
      }, data: { analyticsCategory: body.analyticsCategory as AnalyticsCategory, inventoryRevision: { increment: 1 } } });
      if (changedDevice.count !== 1) fail(409, 'analytics_category_revision_conflict', 'The permanent device changed; refresh the dashboard before retrying');
      const managementRevision = authority.home.managementRevision + (body.analyticsCategory === body.expectedAnalyticsCategory ? 0 : 1);
      const inventoryRevision = device.inventoryRevision + (body.analyticsCategory === body.expectedAnalyticsCategory ? 0 : 1);
      const responseBody = { ok: true, homeId: authority.home.id, osDeviceId: device.osDeviceId, analyticsCategory: String(body.analyticsCategory),
        managementRevision, inventoryRevision, configurationSync: 'PENDING', idempotentReplay: false };
      if (body.analyticsCategory !== body.expectedAnalyticsCategory) {
        await tx.auditEvent.create({ data: { homeId: authority.home.id, actorType: 'EMPLOYEE', actorId: authority.actorId, category: 'INSTALLATION',
          action: 'permanent_device_analytics_category_changed', targetType: 'NativeDevice', targetId: device.id,
          metadata: { from: String(body.expectedAnalyticsCategory), to: String(body.analyticsCategory), managementRevision, workItemId: authority.work.id, accessScope: authority.accessScope },
          purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
      }
      await tx.idempotencyRecord.create({ data: { namespace: NAMESPACE, keyHash, actorId: authority.actorId, homeId: authority.home.id,
        hubInstallationId: hub.installation.id, requestHash, responseStatus: 200, responseBody, responseDigest: sha256(JSON.stringify(responseBody)),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
      return NextResponse.json(responseBody, { headers: { 'Cache-Control': 'no-store' } });
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 12000 });
  } catch (error) {
    const status = error instanceof Stage1AuthError ? error.status : 503;
    const code = error instanceof Stage1AuthError ? error.code : 'analytics_category_unavailable';
    return NextResponse.json({ error: { code, message: error instanceof Stage1AuthError ? error.message : 'The permanent-device category service is temporarily unavailable' } }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
