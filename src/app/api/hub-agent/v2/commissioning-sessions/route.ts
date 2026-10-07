import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { sha256 } from '@/lib/stage1Crypto';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
const HASH = /^[a-f0-9]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_NAMESPACE = 'native-commissioning-session:v1';
const COMPLETE_NAMESPACE = 'native-commissioning-complete:v1';
type Body = Record<string, unknown>;

function fail(status: number, code: string, message: string): never { throw new Stage1AuthError(status, code, message); }
function exactKeys(value: Body, keys: string[]) { return Object.keys(value).sort().join('|') === [...keys].sort().join('|'); }
function protocolValue(value: unknown) { return value === 'zigbee' ? 'ZIGBEE' : value === 'matter' ? 'MATTER_THREAD' : null; }
function assertCommissioningProtocolEnabled(hub: Awaited<ReturnType<typeof authenticateHub>>, protocol: 'ZIGBEE'|'MATTER_THREAD') {
  const summary = hub.installation.capabilitySummary && typeof hub.installation.capabilitySummary === 'object' && !Array.isArray(hub.installation.capabilitySummary)
    ? hub.installation.capabilitySummary as Record<string, unknown> : {};
  const flag = protocol === 'ZIGBEE' ? 'nativeZigbeeCommissioningV1' : 'nativeMatterCommissioningV1';
  if (summary[flag] !== true || summary.nativeCommissioningCatalogueVersion !== 'DINODIA-NATIVE-COMMISSIONING-V1') {
    fail(503, 'commissioning_protocol_disabled', 'This commissioning protocol is not enabled for the enrolled hub');
  }
}
function safeControlSummary(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const controls = (value as Record<string, unknown>).controls;
  if (!Array.isArray(controls) || controls.length > 64) return null;
  const normalized = [];
  for (const control of controls) {
    if (!control || typeof control !== 'object' || Array.isArray(control)) return null;
    const row = control as Record<string, unknown>;
    if (!exactKeys(row, ['controlId','kind','readable','writable','domain']) || typeof row.controlId !== 'string' || !row.controlId || row.controlId.length > 120
      || typeof row.kind !== 'string' || row.kind.length > 40 || typeof row.domain !== 'string' || row.domain.length > 40
      || typeof row.readable !== 'boolean' || typeof row.writable !== 'boolean') return null;
    normalized.push({ controlId: row.controlId, kind: row.kind, readable: row.readable, writable: row.writable, domain: row.domain });
  }
  return { controls: normalized };
}

async function currentTenantAuthority(tx: Prisma.TransactionClient, input: Body, hub: Awaited<ReturnType<typeof authenticateHub>>) {
  const accountId = String(input.accountId || '');
  const membershipId = String(input.membershipId || '');
  const customerSessionId = String(input.customerSessionId || '');
  const trustedDeviceId = String(input.trustedDeviceId || '');
  const accessTokenHash = String(input.accessTokenHash || '');
  const generation = Number(input.identityGeneration);
  if (![accountId, membershipId, customerSessionId, trustedDeviceId].every((value) => UUID.test(value)) || !HASH.test(accessTokenHash)
    || !Number.isInteger(generation) || generation !== hub.identity.identityGeneration) fail(403, 'commissioning_authority_denied', 'Current selected-tenant authority is required');
  const now = new Date();
  const [account, session, device, membership, home] = await Promise.all([
    tx.customerAccount.findUnique({ where: { id: accountId }, select: { id: true, status: true, securityVersion: true } }),
    tx.customerSession.findFirst({ where: { id: customerSessionId, customerAccountId: accountId, trustedDeviceId, accessTokenHash, revokedAt: null }, select: { id: true, customerAccountId: true, trustedDeviceId: true, securityVersion: true, trustedDeviceSessionVersion: true, accessTokenExpiresAt: true, expiresAt: true, absoluteExpiresAt: true, lastUsedAt: true, revokedAt: true } }),
    tx.trustedDevice.findFirst({ where: { id: trustedDeviceId, customerAccountId: accountId, revokedAt: null }, select: { id: true, customerAccountId: true, sessionVersion: true } }),
    tx.homeMembership.findFirst({ where: { id: membershipId, customerAccountId: accountId, homeId: hub.installation.homeId, status: 'ACTIVE', role: 'TENANT' }, select: { id: true, customerAccountId: true, homeId: true, role: true, status: true, accessRevision: true } }),
    tx.home.findUnique({ where: { id: hub.installation.homeId }, select: { id: true, lifecycle: true, installationStatus: true, activeHubInstallationId: true } }),
  ]);
  if (!account || account.status !== 'ACTIVE' || !session || !device || !membership || !home
    || session.customerAccountId !== account.id || session.trustedDeviceId !== device.id
    || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== device.sessionVersion
    || session.expiresAt <= now || session.absoluteExpiresAt <= now || !session.accessTokenExpiresAt || session.accessTokenExpiresAt <= now
    || now.getTime() - session.lastUsedAt.getTime() > 30 * 24 * 60 * 60 * 1000
    || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE' || home.activeHubInstallationId !== hub.installation.id
    || hub.installation.state !== 'ACTIVE' || hub.installation.homeId !== membership.homeId) fail(403, 'commissioning_authority_denied', 'Current selected-tenant authority is required');
  const grants = await tx.tenantAreaGrant.findMany({ where: { membershipId, homeId: home.id, revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } });
  return { actorType: 'TENANT' as const, account, session, device, membership, employee: null, employeeSession: null, handoff: null, work: null, request: null,
    actorId: account.id, managementClass: 'TENANT_DEVICE' as const, ownerMembershipId: membership.id,
    home, areaIds: new Set(grants.map((row) => row.areaId)) };
}

async function currentStaffAuthority(tx: Prisma.TransactionClient, input: Body, hub: Awaited<ReturnType<typeof authenticateHub>>) {
  const employeeId = String(input.employeeId || '');
  const employeeSessionId = String(input.employeeSessionId || '');
  const handoffId = String(input.operatorHandoffId || '');
  const workItemId = String(input.workItemId || '');
  const requestId = String(input.requestId || '');
  const revision = Number(input.workRevision);
  const generation = Number(input.identityGeneration);
  const operatorJti = String(input.operatorJti || '');
  if (![employeeId, employeeSessionId, handoffId, workItemId, requestId].every((value) => UUID.test(value))
    || !Number.isSafeInteger(revision) || revision < 1 || !Number.isInteger(generation) || generation !== hub.identity.identityGeneration
    || !/^[A-Za-z0-9_-]{16,128}$/.test(operatorJti)) fail(403, 'commissioning_staff_authority_denied', 'A current assigned installation work session is required');
  const now = new Date();
  const [employee, employeeSession, handoff, work, request, home] = await Promise.all([
    tx.companyEmployeeAccount.findFirst({ where: { id: employeeId, status: 'ACTIVE', role: { in: ['INSTALLER','SENIOR_OPERATIONS_MANAGER','CXO'] } }, select: { id: true, role: true, status: true } }),
    tx.employeeSession.findFirst({ where: { id: employeeSessionId, employeeId, status: 'ACTIVE', revokedAt: null, expiresAt: { gt: now } }, select: { id: true, employeeId: true, status: true, revokedAt: true, expiresAt: true } }),
    tx.operatorHandoff.findFirst({ where: { id: handoffId, employeeId, workflowId: workItemId, homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, consumedAt: { not: null }, revokedAt: null }, select: { id: true, scope: true } }),
    tx.companyOperationalWorkItem.findFirst({ where: { id: workItemId, kind: 'PERMANENT_DEVICE_INSTALLATION', homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, assignedEmployeeId: employeeId, state: 'IN_PROGRESS', workRevision: revision, certifiedSerialNumber: hub.identity.serialNumber }, select: { id: true, homeId: true, hubInstallationId: true, assignedEmployeeId: true, state: true, workRevision: true, permanentInstallationRequestId: true } }),
    tx.permanentDeviceInstallationRequest.findFirst({ where: { id: requestId, homeId: hub.installation.homeId, status: 'IN_PROGRESS', workItem: { is: { id: workItemId, assignedEmployeeId: employeeId, state: 'IN_PROGRESS', workRevision: revision } } }, select: { id: true, homeId: true, status: true, requestedAreaId: true, revision: true } }),
    tx.home.findFirst({ where: { id: hub.installation.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: hub.installation.id }, select: { id: true, lifecycle: true, installationStatus: true, activeHubInstallationId: true } }),
  ]);
  const handoffScope = handoff?.scope && typeof handoff.scope === 'object' && !Array.isArray(handoff.scope) ? handoff.scope as Record<string, unknown> : {};
  const scopes = Array.isArray(handoffScope.scopes) ? handoffScope.scopes.map(String) : [];
  if (!employee || !employeeSession || !handoff || !work || !request || !home
    || work.permanentInstallationRequestId !== request.id
    || String(handoffScope.employeeSessionId || '') !== employeeSession.id
    || String(handoffScope.operatorJti || '') !== operatorJti
    || Number(handoffScope.workRevision) !== revision
    || String(handoffScope.requestId || '') !== request.id
    || Number(handoffScope.identityGeneration) !== generation
    || !scopes.includes('os:permanent-installation')) fail(403, 'commissioning_staff_authority_denied', 'The assigned installation authority has expired or changed');
  const areas = await tx.area.findMany({ where: { homeId: home.id, status: 'ACTIVE', ...(request.requestedAreaId ? { id: request.requestedAreaId } : {}) }, select: { id: true } });
  if (request.requestedAreaId && areas.length !== 1) fail(409, 'commissioning_area_unavailable', 'The requested original Area is no longer active');
  return { actorType: 'STAFF_INSTALLER' as const, account: null, session: null, device: null, membership: null, employee, employeeSession, handoff, work, request,
    actorId: employee.id, managementClass: 'PROPERTY_DEVICE' as const, ownerMembershipId: null,
    home, areaIds: new Set(areas.map((row) => row.id)) };
}

async function currentAuthority(tx: Prisma.TransactionClient, input: Body, hub: Awaited<ReturnType<typeof authenticateHub>>) {
  return input.actorType === 'STAFF_INSTALLER' ? currentStaffAuthority(tx, input, hub) : currentTenantAuthority(tx, input, hub);
}

function sessionBinding(namespace: string, session: { id: string }) { return sha256(`${namespace}\n${session.id}`); }

export async function POST(request: Request) {
  const raw = await request.text();
  try {
    const hub = await authenticateHub(request, raw, { maxBodyBytes: 48 * 1024 });
    const body = hub.body;
    const action = String(body.action || '');
    if (!UUID.test(String(body.sessionId || '')) || body.homeId !== hub.installation.homeId || body.hubInstallationId && body.hubInstallationId !== hub.installation.id
      || !['create','transition','finalize'].includes(action)) fail(400, 'commissioning_request_invalid', 'The commissioning request is invalid');
    const protocol = protocolValue(body.protocol);
      if (!protocol) fail(400, 'commissioning_request_invalid', 'The commissioning protocol is unsupported');
    return await prisma.$transaction(async (tx) => {
      const authority = await currentAuthority(tx, body, hub);
      const isStaff = authority.actorType === 'STAFF_INSTALLER';
      const actorKeys = isStaff
        ? ['actorType','employeeId','employeeSessionId','operatorHandoffId','operatorJti','workItemId','workRevision','requestId']
        : ['membershipId','accountId','customerSessionId','trustedDeviceId','accessTokenHash'];
      const actorWhere = isStaff
        ? { requestingMembershipId: null, requestingEmployeeId: authority.employee!.id, permanentInstallationRequestId: authority.request!.id, workItemId: authority.work!.id, employeeSessionId: authority.employeeSession!.id, operatorHandoffId: authority.handoff!.id, workRevision: authority.work!.workRevision }
        : { requestingMembershipId: authority.membership!.id, requestingEmployeeId: null };
      const sessionId = String(body.sessionId);
      if (action === 'create') {
        const allowed = ['action','sessionId','homeId','hubInstallationId','identityGeneration','protocol','expiresAt','expectedRevision','idempotencyHash','requestHash', ...actorKeys];
        if (!exactKeys(body, allowed) || !HASH.test(String(body.idempotencyHash || '')) || !HASH.test(String(body.requestHash || ''))
          || Number(body.expectedRevision) !== 1) fail(400, 'commissioning_request_invalid', 'The commissioning request is invalid');
        assertCommissioningProtocolEnabled(hub, protocol);
        const expectedRequestHash = sha256(JSON.stringify({ protocol: protocol === 'ZIGBEE' ? 'zigbee' : 'matter' }));
        if (String(body.requestHash) !== expectedRequestHash) fail(409, 'commissioning_idempotency_conflict', 'This commissioning operation key is already bound to another request');
        const requestedExpiry = new Date(String(body.expiresAt || ''));
        const now = new Date();
        if (!Number.isFinite(requestedExpiry.getTime()) || requestedExpiry <= now || requestedExpiry.getTime() - now.getTime() > 15 * 60 * 1000 + 30_000) fail(400, 'commissioning_expiry_invalid', 'The commissioning session expiry is invalid');
        const prior = await tx.nativeCommissioningSession.findFirst({ where: { homeId: hub.installation.homeId, idempotencyKeyHash: String(body.idempotencyHash) } });
        if (prior) {
          if (prior.id !== sessionId || prior.requestingMembershipId !== (authority.membership?.id ?? null)
            || prior.requestingEmployeeId !== (authority.employee?.id ?? null) || prior.workItemId !== (authority.work?.id ?? null)
            || prior.permanentInstallationRequestId !== (authority.request?.id ?? null) || prior.protocol !== protocol || prior.expiresAt <= now) fail(409, 'commissioning_idempotency_conflict', 'This commissioning operation key is already bound');
          return NextResponse.json({ ok: true, sessionId: prior.id, revision: prior.revision, expiresAt: prior.expiresAt.toISOString(), state: prior.state }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const bound = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: SESSION_NAMESPACE, keyHash: String(body.idempotencyHash) } }, select: { actorId: true, homeId: true, hubInstallationId: true, requestHash: true } });
        if (bound) fail(409, 'commissioning_idempotency_conflict', 'This commissioning operation key is already bound');
        const created = await tx.nativeCommissioningSession.create({ data: {
          id: sessionId, homeId: authority.home.id, hubInstallationId: hub.installation.id, ...actorWhere,
          requestedName: 'New device', managementClass: authority.managementClass, protocol, state: 'REQUESTED', revision: 1, expiresAt: requestedExpiry,
          idempotencyKeyHash: String(body.idempotencyHash),
        }, select: { id: true, state: true, revision: true, expiresAt: true } });
        const bindingBody = isStaff
          ? { sessionId: created.id, actorType: authority.actorType, employeeId: authority.employee!.id, employeeSessionId: authority.employeeSession!.id, operatorHandoffId: authority.handoff!.id, workItemId: authority.work!.id, requestId: authority.request!.id, workRevision: authority.work!.workRevision, identityGeneration: hub.identity.identityGeneration }
          : { sessionId: created.id, customerSessionId: authority.session!.id, trustedDeviceId: authority.device!.id, membershipId: authority.membership!.id, identityGeneration: hub.identity.identityGeneration };
        await tx.idempotencyRecord.create({ data: { namespace: SESSION_NAMESPACE, keyHash: String(body.idempotencyHash), actorId: authority.actorId, homeId: authority.home.id,
          hubInstallationId: hub.installation.id, requestHash: expectedRequestHash, responseStatus: 201,
          responseBody: bindingBody, responseDigest: sha256(JSON.stringify(bindingBody)), expiresAt: requestedExpiry } });
        return NextResponse.json({ ok: true, sessionId: created.id, revision: created.revision, expiresAt: created.expiresAt.toISOString(), state: created.state }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
      }

      const row = await tx.nativeCommissioningSession.findFirst({ where: { id: sessionId, homeId: authority.home.id, hubInstallationId: hub.installation.id, ...actorWhere } });
      if (!row) fail(404, 'commissioning_session_unavailable', 'This commissioning session is unavailable');
      const binding = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: SESSION_NAMESPACE, keyHash: row.idempotencyKeyHash } }, select: { actorId: true, homeId: true, hubInstallationId: true, responseBody: true } });
      const owner = binding?.responseBody && typeof binding.responseBody === 'object' ? binding.responseBody as Record<string, unknown> : {};
      const ownerMatches = isStaff
        ? owner.actorType === authority.actorType && owner.employeeId === authority.employee!.id && owner.employeeSessionId === authority.employeeSession!.id
          && owner.operatorHandoffId === authority.handoff!.id && owner.workItemId === authority.work!.id && owner.requestId === authority.request!.id
          && owner.workRevision === authority.work!.workRevision && owner.identityGeneration === hub.identity.identityGeneration
        : owner.customerSessionId === authority.session!.id && owner.trustedDeviceId === authority.device!.id && owner.membershipId === authority.membership!.id && owner.identityGeneration === hub.identity.identityGeneration;
      if (!binding || binding.actorId !== authority.actorId || binding.homeId !== authority.home.id || binding.hubInstallationId !== hub.installation.id || !ownerMatches) fail(403, 'commissioning_authority_denied', 'The commissioning session belongs to another current authority');
      if (!Number.isSafeInteger(body.expectedRevision)) fail(409, 'commissioning_revision_conflict', 'The commissioning session changed; refresh it before continuing');

      if (action === 'transition') {
        const allowed = ['action','sessionId','homeId','hubInstallationId','identityGeneration','protocol','expiresAt','expectedRevision','status','selectedAreaId','candidateRef','osDeviceId','requestedName','customerLabel','catalogueStatus','catalogueRevision','descriptorDigest','result', ...actorKeys];
        const nextStatus = String(body.status || '');
        const state = ({ ADVERTISING: 'ADVERTISING', READY: 'READY', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', FAILED: 'FAILED' } as Record<string,string>)[nextStatus];
        const optional = ['selectedAreaId','candidateRef','osDeviceId','requestedName','customerLabel','catalogueStatus','catalogueRevision','descriptorDigest','result'];
        if (!exactKeys(body, allowed.filter((key) => !optional.includes(key)).concat(optional.filter((key) => Object.hasOwn(body, key)))) || !state) fail(400, 'commissioning_transition_invalid', 'The commissioning state change is invalid');
        if (state === 'READY' && row.state === 'READY' && row.revision === Number(body.expectedRevision) + 1
          && row.requestedAreaId === body.selectedAreaId && row.selectedCandidateRef === body.candidateRef && row.selectedOsDeviceId === body.osDeviceId
          && row.customerLabel === body.customerLabel && row.catalogueStatus === body.catalogueStatus && row.catalogueRevision === body.catalogueRevision
          && row.catalogueDigest === body.descriptorDigest) {
          return NextResponse.json({ ok: true, sessionId: row.id, revision: row.revision, state }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (state === 'COMPLETED' && row.state === 'COMPLETED' && row.finalDisposition === 'REMOVED' && body.result === 'REMOVED'
          && row.revision === Number(body.expectedRevision) + 1) {
          return NextResponse.json({ ok: true, sessionId: row.id, revision: row.revision, state, result: 'REMOVED' }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (Number(body.expectedRevision) !== row.revision) fail(409, 'commissioning_revision_conflict', 'The commissioning session changed; refresh it before continuing');
        if ((row.closedAt || row.expiresAt <= new Date()) && state !== 'EXPIRED') fail(404, 'commissioning_session_unavailable', 'This commissioning session is unavailable');
        const allowedTransitions: Record<string, string[]> = { REQUESTED: ['ADVERTISING','FAILED','CANCELLED','EXPIRED'], ADVERTISING: ['READY','FAILED','CANCELLED','EXPIRED'], READY: ['COMPLETED','CANCELLED','EXPIRED'] };
        if (!allowedTransitions[row.state]?.includes(state)) fail(409, 'commissioning_transition_conflict', 'The commissioning session cannot make that state change');
        if (state === 'READY') {
          assertCommissioningProtocolEnabled(hub, protocol);
          const areaId = String(body.selectedAreaId || '');
          const catalogueStatus = String(body.catalogueStatus || '');
          if (!UUID.test(areaId) || !authority.areaIds.has(areaId) || !await tx.area.findFirst({ where: { id: areaId, homeId: authority.home.id, status: 'ACTIVE' }, select: { id: true } })
            || typeof body.candidateRef !== 'string' || !body.candidateRef || body.candidateRef.length > 80
            || typeof body.osDeviceId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(body.osDeviceId)
            || !(body.requestedName === null || typeof body.requestedName === 'string' && body.requestedName.length <= 80)
            || typeof body.customerLabel !== 'string' || !body.customerLabel.trim() || [...body.customerLabel].length > 40
            || !['ready','no_safe_controls','unsupported'].includes(catalogueStatus)
            || !Number.isSafeInteger(body.catalogueRevision) || Number(body.catalogueRevision) < 1 || !HASH.test(String(body.descriptorDigest || ''))) fail(403, 'commissioning_area_denied', 'The selected device or Area is not currently permitted');
        }
        if (state === 'COMPLETED' && (row.state !== 'READY' || body.result !== 'REMOVED' || Object.keys(body).some((key) => !['action','sessionId','homeId','hubInstallationId','identityGeneration','protocol','expiresAt','expectedRevision','status','result', ...actorKeys].includes(key)))) fail(409, 'commissioning_transition_invalid', 'Only an explicitly removed unsupported device can complete without a device record');
        const transitionNow = new Date();
        const changed = await tx.nativeCommissioningSession.updateMany({ where: { id: row.id, revision: row.revision, state: row.state, ...(state === 'EXPIRED' ? {} : { expiresAt: { gt: transitionNow } }) }, data: { state: state as never,
          ...(state === 'READY' ? { requestedAreaId: String(body.selectedAreaId), selectedCandidateRef: String(body.candidateRef), selectedOsDeviceId: String(body.osDeviceId), requestedName: body.requestedName == null ? '' : String(body.requestedName), customerLabel: String(body.customerLabel), catalogueStatus: String(body.catalogueStatus), catalogueRevision: Number(body.catalogueRevision), catalogueDigest: String(body.descriptorDigest) } : {}),
          ...(state === 'COMPLETED' ? { finalDisposition: 'REMOVED' } : {}), revision: { increment: 1 }, ...(state === 'CANCELLED' || state === 'EXPIRED' || state === 'FAILED' || state === 'COMPLETED' ? { closedAt: transitionNow } : {}) } });
        if (changed.count !== 1) fail(409, 'commissioning_revision_conflict', 'The commissioning session changed; refresh it before continuing');
        return NextResponse.json({ ok: true, sessionId: row.id, revision: row.revision + 1, state }, { headers: { 'Cache-Control': 'no-store' } });
      }

      const allowed = ['action','sessionId','homeId','hubInstallationId','identityGeneration','protocol','expiresAt','expectedRevision','candidateRef','disposition','device', ...actorKeys];
      if (!exactKeys(body, allowed) || !body.device || typeof body.device !== 'object' || Array.isArray(body.device)) fail(409, 'commissioning_finalize_invalid', 'The device is not ready for ownership registration');
      const device = body.device as Record<string, unknown>;
      const keys = ['osDeviceId','originalName','technicalLabel','deviceType','manufacturer','model','protocol','descriptorRevision','descriptorDigest','capabilitySummary','areaId','name','customerLabel','catalogueStatus','usefulReadings'];
      if (!exactKeys(device, keys) || typeof body.candidateRef !== 'string' || body.candidateRef.length > 80 || !['install','view_only'].includes(String(body.disposition))
        || typeof device.osDeviceId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(device.osDeviceId)
        || ![device.originalName,device.technicalLabel,device.deviceType].every((v) => typeof v === 'string' && v.trim().length > 0)
        || (device.name !== null && (typeof device.name !== 'string' || String(device.name).length > 80))
        || String(device.originalName).length > 160 || String(device.technicalLabel).length > 80 || String(device.deviceType).length > 120
        || typeof device.customerLabel !== 'string' || !String(device.customerLabel).trim() || [...String(device.customerLabel)].length > 40
        || (device.manufacturer !== null && (typeof device.manufacturer !== 'string' || String(device.manufacturer).length > 160))
        || (device.model !== null && (typeof device.model !== 'string' || String(device.model).length > 160))
        || device.protocol !== protocol || !Number.isSafeInteger(device.descriptorRevision) || Number(device.descriptorRevision) < 1
        || !HASH.test(String(device.descriptorDigest || '')) || !safeControlSummary(device.capabilitySummary)) fail(400, 'commissioning_finalize_invalid', 'The device projection is invalid');
      assertCommissioningProtocolEnabled(hub, protocol);
      const controls = (device.capabilitySummary as { controls: Array<{ readable: boolean; writable: boolean }> }).controls;
      const hasWritable = controls.some((control) => control.readable && control.writable);
      if (body.disposition === 'install' && (device.catalogueStatus !== 'ready' || !hasWritable)
        || body.disposition === 'view_only' && (!['no_safe_controls','unsupported'].includes(String(device.catalogueStatus)) || device.usefulReadings !== true || hasWritable)) fail(409, 'commissioning_catalogue_invalid', 'The current device catalogue does not support this choice');
      const areaId = String(device.areaId || '');
      if (!authority.areaIds.has(areaId) || !await tx.area.findFirst({ where: { id: areaId, homeId: authority.home.id, status: 'ACTIVE' }, select: { id: true } })) fail(403, 'commissioning_area_denied', 'The selected Area is not currently granted to this tenant');
      const finalHash = sessionBinding(COMPLETE_NAMESPACE, row);
      const finalRequest = sha256(JSON.stringify({ device, candidateRef: body.candidateRef, disposition: body.disposition, actorId: authority.actorId, sessionId: row.id }));
      const existingReceipt = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace: COMPLETE_NAMESPACE, keyHash: finalHash } }, select: { requestHash: true, responseBody: true } });
      if (existingReceipt) {
        if (existingReceipt.requestHash !== finalRequest || !existingReceipt.responseBody || typeof existingReceipt.responseBody !== 'object') fail(409, 'commissioning_idempotency_conflict', 'This device result was already bound to different commissioning details');
        return NextResponse.json(existingReceipt.responseBody, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (row.state !== 'READY' || row.closedAt || row.expiresAt <= new Date() || Number(body.expectedRevision) !== row.revision
        || row.requestedAreaId !== areaId || row.selectedCandidateRef !== body.candidateRef || row.selectedOsDeviceId !== device.osDeviceId
        || row.customerLabel !== device.customerLabel || row.catalogueStatus !== device.catalogueStatus || row.catalogueRevision !== device.descriptorRevision || row.catalogueDigest !== device.descriptorDigest) fail(409, 'commissioning_finalize_invalid', 'The device is not ready for ownership registration');
      const preexisting = await tx.nativeDevice.findUnique({ where: { hubInstallationId_osDeviceId: { hubInstallationId: hub.installation.id, osDeviceId: device.osDeviceId } }, select: { id: true } });
      if (preexisting) fail(409, 'device_identity_conflict', 'This radio identity is already registered; use the existing device recovery flow');
      const now = new Date();
      const safeSummary = safeControlSummary(device.capabilitySummary) as Record<string, unknown>;
      const created = await tx.nativeDevice.create({ data: {
        homeId: authority.home.id, hubInstallationId: hub.installation.id, osDeviceId: String(device.osDeviceId), originalName: String(device.originalName),
        overrideName: device.name == null || !String(device.name).trim() ? null : String(device.name), technicalLabel: String(device.technicalLabel), customerLabel: String(device.customerLabel),
        managementClass: authority.managementClass, ownerMembershipId: authority.ownerMembershipId, deviceType: String(device.deviceType),
        manufacturer: device.manufacturer == null ? null : String(device.manufacturer), model: device.model == null ? null : String(device.model), protocol,
        capabilitySummary: { ...safeSummary, commissioning: { status: String(device.catalogueStatus), usefulReadings: device.usefulReadings === true, catalogueVersion: 'DINODIA-NATIVE-COMMISSIONING-V1', descriptorDigest: String(device.descriptorDigest) } } as never,
        descriptorRevision: Number(device.descriptorRevision), descriptorDigest: String(device.descriptorDigest),
        lifecycle: body.disposition === 'view_only' ? 'VIEW_ONLY' : 'INSTALLED', onlineState: 'UNKNOWN', installedAt: now,
        ...(isStaff ? { installationRequestId: authority.request!.id } : {}),
        assignments: { create: { areaId, homeId: authority.home.id, source: isStaff ? 'NATIVE_STAFF_COMMISSIONING' : 'NATIVE_TENANT_COMMISSIONING' } },
      }, select: { id: true, homeId: true, osDeviceId: true, ownerMembershipId: true, managementClass: true, lifecycle: true, customerLabel: true, descriptorRevision: true } });
      const updated = await tx.nativeCommissioningSession.updateMany({ where: { id: row.id, state: 'READY', revision: row.revision, expiresAt: { gt: now } }, data: { state: 'COMPLETED', closedAt: now, finalDeviceId: created.id, revision: { increment: 1 } } });
      if (updated.count !== 1) fail(409, 'commissioning_revision_conflict', 'The commissioning session changed before ownership could be recorded');
      await tx.nativeDomainOutbox.create({ data: { homeId: authority.home.id, aggregateType: 'NativeDevice', aggregateId: created.id, eventType: isStaff ? 'PROPERTY_DEVICE_COMMISSIONED' : 'TENANT_DEVICE_COMMISSIONED', idempotencyKey: `commissioning:${row.id}:device-created`, payload: { deviceId: created.id, ownerMembershipId: authority.ownerMembershipId, areaId }, expiresAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000) } });
      await tx.auditEvent.create({ data: { homeId: authority.home.id, actorType: isStaff ? 'EMPLOYEE' : 'CUSTOMER', actorId: authority.actorId, category: 'INSTALLATION', action: isStaff ? 'property_device_commissioned_by_assigned_staff' : 'tenant_device_commissioned', targetType: 'NativeDevice', targetId: created.id, metadata: { protocol, areaId, outcome: 'installed', requestId: authority.request?.id || null, workItemId: authority.work?.id || null }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      const response = { ok: true, sessionId: row.id, revision: row.revision + 1, state: 'COMPLETED', device: { id: created.id, osDeviceId: created.osDeviceId, managementClass: created.managementClass, ownerMembershipId: created.ownerMembershipId, lifecycle: created.lifecycle, customerLabel: created.customerLabel, descriptorRevision: created.descriptorRevision } };
      await tx.idempotencyRecord.create({ data: { namespace: COMPLETE_NAMESPACE, keyHash: finalHash, actorId: authority.actorId, homeId: authority.home.id, hubInstallationId: hub.installation.id, requestHash: finalRequest, responseStatus: 200, responseBody: response, responseDigest: sha256(JSON.stringify(response)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 12000 });
  } catch (error) {
    const status = error instanceof Stage1AuthError ? error.status : 503;
    const code = error instanceof Stage1AuthError ? error.code : 'commissioning_unavailable';
    return NextResponse.json({ error: { code, message: error instanceof Stage1AuthError ? error.message : 'The commissioning service is temporarily unavailable' } }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
