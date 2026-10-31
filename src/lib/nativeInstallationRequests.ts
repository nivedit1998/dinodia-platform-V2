import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { sha256 } from './stage1Crypto';
import { Stage1AuthError } from './stage1Auth';
import { NEW_DEVICES_OWNER_FAMILY, optionalFamilyEnabled, queueNewDevicesTenantNotices } from './roomAccessNotices';

const CATEGORIES = new Set(['LIGHTING', 'HEATING', 'SECURITY', 'OTHER']);
const KEY = /^[A-Za-z0-9._:-]{16,160}$/;
const REQUEST_NAMESPACE = 'native-installation-request:v1';
const START_NAMESPACE = 'native-installation-start:v1';
const COMPLETE_NAMESPACE = 'native-installation-complete:v1';

export function validateInstallationRequestInput(value: unknown): { category: 'LIGHTING'|'HEATING'|'SECURITY'|'OTHER'; notes: string; areaId: string|null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The installation request is invalid');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join('|') !== ['areaId','category','notes'].sort().join('|')) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The installation request contains unsupported fields');
  const category = String(body.category || '');
  const notes = typeof body.notes === 'string' ? body.notes.normalize('NFC').trim() : '';
  const areaId = body.areaId == null || body.areaId === '' ? null : String(body.areaId);
  if (!CATEGORIES.has(category) || notes.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(notes)
    || areaId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(areaId)) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The installation request is invalid');
  }
  return { category: category as 'LIGHTING'|'HEATING'|'SECURITY'|'OTHER', notes, areaId };
}

function validKey(key: string): string {
  if (!KEY.test(key)) throw new Stage1AuthError(400, 'IDEMPOTENCY_KEY_INVALID', 'A valid request key is required');
  return key;
}
function reference(): string { return `DIN-${randomBytes(6).toString('hex').toUpperCase()}`; }
function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(work, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 12000 });
}

export async function createInstallationRequest(input: {
  accountId: string; membershipId: string; homeId: string; idempotencyKey: string;
  category: 'LIGHTING'|'HEATING'|'SECURITY'|'OTHER'; notes: string; areaId: string|null;
}, now = new Date()) {
  const key = validKey(input.idempotencyKey);
  const namespace = REQUEST_NAMESPACE;
  const keyHash = sha256(`${input.accountId}:${key}`);
  const requestHash = sha256(JSON.stringify({ ...input, idempotencyKey: undefined }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await serializable(async (tx) => {
        const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
        if (prior) {
          if (prior.actorId !== input.accountId || prior.homeId !== input.homeId || prior.requestHash !== requestHash || prior.expiresAt <= now || !prior.responseBody || typeof prior.responseBody !== 'object') throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used');
          return prior.responseBody as Record<string, unknown>;
        }
        const membership = await tx.homeMembership.findFirst({ where: { id: input.membershipId, homeId: input.homeId, customerAccountId: input.accountId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] } }, select: { id: true, role: true } });
        const home = await tx.home.findFirst({ where: { id: input.homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' }, select: { id: true } });
        if (!membership || !home) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Installation requests are not available for this selected Home');
        if (input.areaId) {
          const area = await tx.area.findFirst({ where: { id: input.areaId, homeId: input.homeId, status: 'ACTIVE' }, select: { id: true } });
          if (!area) throw new Stage1AuthError(400, 'AREA_INVALID', 'Choose an active Area in this Home, or leave Area blank for whole-property work');
        }
        let customerReference = '';
        for (let n = 0; n < 4 && !customerReference; n += 1) {
          const candidate = reference();
          if (!await tx.permanentDeviceInstallationRequest.findUnique({ where: { customerReference: candidate }, select: { id: true } })) customerReference = candidate;
        }
        if (!customerReference) throw new Stage1AuthError(503, 'REQUEST_REFERENCE_UNAVAILABLE', 'The request could not be created safely; retry once');
        const requestId = randomUUID();
        const request = await tx.permanentDeviceInstallationRequest.create({ data: {
          id: requestId,
          customerReference, homeId: input.homeId, requestedAreaId: input.areaId,
          requesterMembershipId: input.membershipId, requesterAccountId: input.accountId,
          category: input.category, customerNotes: input.notes || null,
          operationsEmailKey: `installation-request:${requestId}:operations-email`,
        }, select: { id: true, customerReference: true, status: true, revision: true, createdAt: true } });
        await tx.nativeDomainOutbox.create({ data: {
          homeId: input.homeId, aggregateType: 'PermanentDeviceInstallationRequest', aggregateId: request.id,
          eventType: 'INSTALLATION_REQUEST_EMAIL', idempotencyKey: `installation-request:${request.id}:operations-email`,
          // NativeDomainOutbox has a reviewed 30-day maximum lifetime check.
          // Leave a full-day margin so database transaction timestamps and
          // client clocks cannot make a valid enqueue exceed that ceiling.
          payload: { requestId: request.id }, expiresAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000),
        } });
        const response = { schemaVersion: 'dinodia.v1', request: { id: request.id, reference: request.customerReference, status: request.status, revision: request.revision, createdAt: request.createdAt.toISOString(), canCancel: true } };
        await tx.idempotencyRecord.create({ data: { namespace, keyHash, actorId: input.accountId, homeId: input.homeId, requestHash, responseStatus: 201, responseBody: response as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(response)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
        await tx.auditEvent.create({ data: { homeId: input.homeId, actorType: 'CUSTOMER', actorId: input.accountId, category: 'INSTALLATION', action: 'permanent_installation_requested', targetType: 'PermanentDeviceInstallationRequest', targetId: request.id, metadata: { category: input.category, areaRequested: Boolean(input.areaId), outcome: 'submitted' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        return response;
      });
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (['P2002', 'P2034'].includes(code) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Stage1AuthError(503, 'REQUEST_RETRY_EXHAUSTED', 'The request could not be created safely; retry once');
}

export async function listStaffInstallationRequests(employee: { id: string; role: string }) {
  const staffQueueWhere: Prisma.PermanentDeviceInstallationRequestWhereInput = employee.role === 'INSTALLER'
    ? { OR: [
      { status: 'SUBMITTED', workItem: null },
      { status: 'IN_PROGRESS', workItem: { is: { assignedEmployeeId: employee.id } } },
    ] }
    : {};
  const rows = await prisma.permanentDeviceInstallationRequest.findMany({ where: { status: { in: ['SUBMITTED', 'IN_PROGRESS'] }, ...staffQueueWhere }, orderBy: { createdAt: 'asc' }, take: 100, select: {
    id: true, customerReference: true, homeId: true, requestedAreaId: true, requesterMembershipId: true, category: true,
    customerNotes: true, status: true, revision: true, workStartedAt: true, createdAt: true,
    home: { select: { addressLine1: true, city: true, postcode: true, activeHubInstallationId: true } },
    area: { select: { originalName: true, status: true } },
    workItem: { select: { id: true, assignedEmployeeId: true, state: true, workRevision: true } },
  } });
  return rows.map((row) => ({ requestId: row.id, reference: row.customerReference, homeId: row.homeId,
    address: [row.home.addressLine1, row.home.city, row.home.postcode].filter(Boolean).join(', '),
    hubInstallationId: row.home.activeHubInstallationId, requestedAreaId: row.requestedAreaId,
    areaName: row.area?.status === 'ACTIVE' ? row.area.originalName : null, category: row.category,
    notes: row.customerNotes, status: row.status, revision: row.revision,
    workStartedAt: row.workStartedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    work: row.workItem ? { workflowId: row.workItem.id, assignedEmployeeId: row.workItem.assignedEmployeeId, state: row.workItem.state, revision: row.workItem.workRevision } : null,
  }));
}

export async function startInstallationRequest(input: { requestId: string; employeeId: string; employeeRole: string; assignedEmployeeId?: string; expectedRevision: number; idempotencyKey: string }, now = new Date()) {
  const key = validKey(input.idempotencyKey); const namespace = START_NAMESPACE;
  const keyHash = sha256(`${input.employeeId}:${key}`); const requestHash = sha256(JSON.stringify(input));
  return serializable(async (tx) => {
    const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } }, select: { actorId: true, requestHash: true, responseBody: true } });
    if (prior) {
      if (prior.actorId !== input.employeeId || prior.requestHash !== requestHash || !prior.responseBody || typeof prior.responseBody !== 'object') throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This start key was already used');
      return prior.responseBody as Record<string, unknown>;
    }
    const request = await tx.permanentDeviceInstallationRequest.findUnique({ where: { id: input.requestId }, select: { id: true, homeId: true, status: true, revision: true, customerReference: true, category: true, customerNotes: true, createdAt: true, home: { select: { activeHubInstallationId: true, lifecycle: true, installationStatus: true } }, workItem: { select: { id: true, assignedEmployeeId: true, state: true } } } });
    if (!request) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'The installation request is unavailable');
    const employee = await tx.companyEmployeeAccount.findFirst({ where: { id: input.employeeId, status: 'ACTIVE', role: { in: ['INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'CXO'] } }, select: { id: true, role: true } });
    if (!employee) throw new Stage1AuthError(403, 'ROLE_DENIED', 'This staff account cannot start permanent installation work');
    if (request.status === 'IN_PROGRESS' && request.workItem?.assignedEmployeeId === employee.id) {
      if (request.workItem.state === 'IN_PROGRESS') return { ok: true, requestId: request.id, workflowId: request.workItem.id, revision: request.revision, state: 'IN_PROGRESS', replayed: true };
      if (request.workItem.state === 'ASSIGNED' && request.revision === input.expectedRevision) {
        const startedWork = await tx.companyOperationalWorkItem.updateMany({ where: { id: request.workItem.id, assignedEmployeeId: employee.id, state: 'ASSIGNED' }, data: { state: 'IN_PROGRESS', startedAt: now, workRevision: { increment: 1 } } });
        const startedRequest = await tx.permanentDeviceInstallationRequest.updateMany({ where: { id: request.id, status: 'IN_PROGRESS', revision: input.expectedRevision }, data: { revision: { increment: 1 } } });
        if (startedWork.count !== 1 || startedRequest.count !== 1) throw new Stage1AuthError(409, 'REQUEST_STATE_CONFLICT', 'This assignment changed before work could start');
        const response = { ok: true, requestId: request.id, workflowId: request.workItem.id, revision: input.expectedRevision + 1, state: 'IN_PROGRESS', replayed: false };
        await tx.idempotencyRecord.create({ data: { namespace, keyHash, actorId: employee.id, homeId: request.homeId, requestHash, responseStatus: 200, responseBody: response as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(response)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
        await tx.auditEvent.create({ data: { homeId: request.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'INSTALLATION', action: 'permanent_installation_work_started', targetType: 'PermanentDeviceInstallationRequest', targetId: request.id, metadata: { workItemId: request.workItem.id, outcome: 'started' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        return response;
      }
    }
    if (request.status !== 'SUBMITTED' || request.revision !== input.expectedRevision || !request.home.activeHubInstallationId || request.home.lifecycle !== 'ACTIVE' || request.home.installationStatus !== 'COMPLETE') throw new Stage1AuthError(409, 'REQUEST_STATE_CONFLICT', 'This request or Home changed; refresh the queue');
    const hub = await tx.hubInstallation.findFirst({ where: { id: request.home.activeHubInstallationId, homeId: request.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true, serialNumberSnapshot: true } });
    if (!hub) throw new Stage1AuthError(409, 'HUB_UNAVAILABLE', 'The Home has no current enrolled hub for installation work');
    if (request.workItem) throw new Stage1AuthError(409, 'REQUEST_STATE_CONFLICT', 'This request is already assigned to an installation employee');
    const targetId = input.assignedEmployeeId || employee.id;
    if (targetId !== employee.id && !['CXO', 'SENIOR_OPERATIONS_MANAGER'].includes(employee.role)) throw new Stage1AuthError(403, 'ROLE_DENIED', 'Only an operations manager may assign this request to another employee');
    const assignee = targetId === employee.id ? employee : await tx.companyEmployeeAccount.findFirst({ where: { id: targetId, status: 'ACTIVE', role: 'INSTALLER' }, select: { id: true, role: true } });
    if (!assignee) throw new Stage1AuthError(403, 'ASSIGNEE_INVALID', 'Choose an active installation employee');
    const startsNow = assignee.id === employee.id;
    const work = await tx.companyOperationalWorkItem.create({ data: {
      publicReference: request.customerReference, kind: 'PERMANENT_DEVICE_INSTALLATION', state: startsNow ? 'IN_PROGRESS' : 'ASSIGNED',
      homeId: request.homeId, hubInstallationId: hub.id, certifiedSerialNumber: hub.serialNumberSnapshot,
      permanentInstallationRequestId: request.id, assignedEmployeeId: assignee.id, createdByEmployeeId: employee.id,
      reason: `Permanent device installation ${request.customerReference}`, notes: request.customerNotes,
      workRevision: 1, ...(startsNow ? { startedAt: now } : {}),
    }, select: { id: true, publicReference: true, state: true } });
    const changed = await tx.permanentDeviceInstallationRequest.updateMany({ where: { id: request.id, status: 'SUBMITTED', revision: input.expectedRevision }, data: { status: 'IN_PROGRESS', workStartedAt: now, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Stage1AuthError(409, 'REQUEST_STATE_CONFLICT', 'Another staff member already started this request');
    const response = { ok: true, requestId: request.id, workflowId: work.id, publicReference: work.publicReference, status: 'IN_PROGRESS', state: work.state, assignedEmployeeId: assignee.id, revision: input.expectedRevision + 1, replayed: false };
    await tx.idempotencyRecord.create({ data: { namespace, keyHash, actorId: employee.id, homeId: request.homeId, hubInstallationId: hub.id, requestHash, responseStatus: 200, responseBody: response as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(response)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
    await tx.auditEvent.create({ data: { homeId: request.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'INSTALLATION', action: startsNow ? 'permanent_installation_work_started' : 'permanent_installation_work_assigned', targetType: 'PermanentDeviceInstallationRequest', targetId: request.id, metadata: { workItemId: work.id, assignedEmployeeId: assignee.id, outcome: startsNow ? 'in_progress' : 'assigned' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return response;
  });
}

export async function completeInstallationRequest(input: { requestId: string; employeeId: string; expectedRevision: number; idempotencyKey: string }, now = new Date()) {
  const key = validKey(input.idempotencyKey); const namespace = COMPLETE_NAMESPACE;
  const keyHash = sha256(`${input.employeeId}:${key}`); const requestHash = sha256(JSON.stringify(input));
  return serializable(async (tx) => {
    const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } }, select: { actorId: true, requestHash: true, responseBody: true } });
    if (prior) {
      if (prior.actorId !== input.employeeId || prior.requestHash !== requestHash || !prior.responseBody || typeof prior.responseBody !== 'object') throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This completion key was already used');
      return prior.responseBody as Record<string, unknown>;
    }
    const request = await tx.permanentDeviceInstallationRequest.findUnique({ where: { id: input.requestId }, select: { id: true, homeId: true, status: true, revision: true, customerReference: true, requesterAccountId: true, requesterMembershipId: true, workItem: { select: { id: true, assignedEmployeeId: true, state: true, hubInstallationId: true } } } });
    if (!request || request.status !== 'IN_PROGRESS' || request.revision !== input.expectedRevision || !request.workItem || request.workItem.assignedEmployeeId !== input.employeeId || request.workItem.state !== 'IN_PROGRESS') throw new Stage1AuthError(409, 'REQUEST_STATE_CONFLICT', 'This request is not assigned and ready to complete');
    if (!request.workItem.hubInstallationId) throw new Stage1AuthError(409, 'HUB_UNAVAILABLE', 'The assigned installation work no longer has a current hub');
    const device = await tx.nativeDevice.findFirst({ where: { installationRequestId: request.id, homeId: request.homeId, hubInstallationId: request.workItem.hubInstallationId, managementClass: 'PROPERTY_DEVICE', lifecycle: { in: ['INSTALLED', 'VIEW_ONLY'] } }, select: { id: true } });
    if (!device) throw new Stage1AuthError(409, 'DEVICE_RESULT_REQUIRED', 'Record and sync at least one successfully installed permanent device before completing this work');
    // Completion is a Home-bound notice to the current homeowner and, only
    // while still entitled, the member who requested the work. Do not fan out
    // private request activity to every manager in the Home.
    const permittedRecipientMemberships = [
      { role: 'OWNER' as const },
      ...(request.requesterMembershipId && request.requesterAccountId
        ? [{ id: request.requesterMembershipId, customerAccountId: request.requesterAccountId, role: 'PROPERTY_MANAGER' as const }]
        : []),
    ];
    const entitledRecipients = await tx.homeMembership.findMany({
      where: {
        homeId: request.homeId, status: 'ACTIVE',
        OR: permittedRecipientMemberships,
        customerAccount: { is: { status: 'ACTIVE', emailVerifiedAt: { not: null } } },
      },
      select: { id: true, customerAccountId: true, role: true, customerAccount: { select: { email: true } } },
    });
    const recipientsByAccount = new Map<string, (typeof entitledRecipients)[number]>();
    for (const recipient of entitledRecipients) {
      const current = recipientsByAccount.get(recipient.customerAccountId);
      if (!current || recipient.role === 'OWNER') recipientsByAccount.set(recipient.customerAccountId, recipient);
    }
    // The homeowner can switch this optional notice off; a manager who asked for the work always hears it is finished.
    const deduplicatedRecipients: Array<(typeof entitledRecipients)[number]> = [];
    for (const recipient of recipientsByAccount.values()) {
      if (recipient.role !== 'OWNER' || await optionalFamilyEnabled(tx, recipient.id, NEW_DEVICES_OWNER_FAMILY)) deduplicatedRecipients.push(recipient);
    }
    const currentDevices = deduplicatedRecipients.length ? await tx.trustedDevice.findMany({ where: {
      customerAccountId: { in: deduplicatedRecipients.map((recipient) => recipient.customerAccountId) },
      revokedAt: null, apnsTokenCiphertext: { not: null }, apnsTokenDigest: { not: null },
      apnsEnvironment: { not: null }, apnsKeyVersion: 1,
    }, select: { id: true, customerAccountId: true } }) : [];
    const updated = await tx.permanentDeviceInstallationRequest.updateMany({ where: { id: request.id, status: 'IN_PROGRESS', revision: input.expectedRevision }, data: { status: 'COMPLETED', completedAt: now, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new Stage1AuthError(409, 'REQUEST_STATE_CONFLICT', 'This request changed before completion');
    await tx.companyOperationalWorkItem.updateMany({ where: { id: request.workItem.id, state: 'IN_PROGRESS', assignedEmployeeId: input.employeeId }, data: { state: 'COMPLETED', completedAt: now, workRevision: { increment: 1 } } });
    await tx.nativeDomainOutbox.create({ data: { homeId: request.homeId, aggregateType: 'PermanentDeviceInstallationRequest', aggregateId: request.id, eventType: 'INSTALLATION_REQUEST_COMPLETED', idempotencyKey: `installation-request:${request.id}:completion`, payload: { requestId: request.id }, expiresAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000) } });
    if (deduplicatedRecipients.length) {
      const expiresAt = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000);
      await tx.nativeNotificationDeliveryReceipt.createMany({
        data: [
          ...deduplicatedRecipients.filter((recipient) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.customerAccount.email)).map((recipient) => ({
          customerAccountId: recipient.customerAccountId,
          membershipId: recipient.id,
          homeId: request.homeId,
          family: 'OWNER_INSTALLATION_UPDATE' as const,
          channel: 'EMAIL' as const,
          idempotencyKey: `installation-request:${request.id}:completion:email:${recipient.customerAccountId}`,
          deliverAfter: now,
          expiresAt,
          status: 'PENDING' as const,
          })),
          ...currentDevices.flatMap((device) => {
            const recipient = deduplicatedRecipients.find((candidate) => candidate.customerAccountId === device.customerAccountId);
            return recipient ? [{
              customerAccountId: recipient.customerAccountId,
              trustedDeviceId: device.id,
              membershipId: recipient.id,
              homeId: request.homeId,
              family: 'OWNER_INSTALLATION_UPDATE' as const,
              channel: 'PUSH' as const,
              idempotencyKey: `installation-request:${request.id}:completion:push:${recipient.customerAccountId}:${device.id}`,
              deliverAfter: now,
              expiresAt,
              status: 'PENDING' as const,
            }] : [];
          }),
        ],
        skipDuplicates: true,
      });
    }
    // Tenants hear about the new devices in the rooms they can use (never devices another tenant added themselves).
    await queueNewDevicesTenantNotices(tx, { homeId: request.homeId, requestId: request.id, reference: request.customerReference, now });
    const response = { ok: true, requestId: request.id, reference: request.customerReference, status: 'COMPLETED', revision: input.expectedRevision + 1, deviceId: device.id };
    await tx.idempotencyRecord.create({ data: { namespace, keyHash, actorId: input.employeeId, homeId: request.homeId, hubInstallationId: request.workItem.hubInstallationId, requestHash, responseStatus: 200, responseBody: response as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(response)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
    await tx.auditEvent.create({ data: { homeId: request.homeId, actorType: 'EMPLOYEE', actorId: input.employeeId, category: 'INSTALLATION', action: 'permanent_installation_work_completed', targetType: 'PermanentDeviceInstallationRequest', targetId: request.id, metadata: { workItemId: request.workItem.id, deviceId: device.id, outcome: 'completed' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
    return response;
  });
}

export async function listCustomerInstallationRequests(homeId: string, membershipId: string) {
  const membership = await prisma.homeMembership.findFirst({ where: { id: membershipId, homeId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] } }, select: { id: true } });
  if (!membership) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Installation requests are unavailable for this selected Home');
  const rows = await prisma.permanentDeviceInstallationRequest.findMany({ where: { homeId, status: { in: ['SUBMITTED', 'IN_PROGRESS'] } }, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, customerReference: true, status: true, revision: true, createdAt: true } });
  return { schemaVersion: 'dinodia.v1', requests: rows.map((row) => ({ id: row.id, reference: row.customerReference, status: row.status, revision: row.revision, createdAt: row.createdAt.toISOString(), canCancel: row.status === 'SUBMITTED' })) };
}

export async function cancelCustomerInstallationRequest(input: { accountId: string; membershipId: string; homeId: string; requestId: string; expectedRevision: number; idempotencyKey: string }, now = new Date()) {
  const key = validKey(input.idempotencyKey); const namespace = 'native-installation-cancel:v1';
  const keyHash = sha256(`${input.accountId}:${key}`); const requestHash = sha256(JSON.stringify(input));
  return serializable(async (tx) => {
    const membership = await tx.homeMembership.findFirst({ where: { id: input.membershipId, customerAccountId: input.accountId, homeId: input.homeId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] } }, select: { id: true } });
    if (!membership) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Installation requests are unavailable for this selected Home');
    const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } }, select: { actorId: true, homeId: true, requestHash: true, responseBody: true } });
    if (prior) {
      if (prior.actorId !== input.accountId || prior.homeId !== input.homeId || prior.requestHash !== requestHash || !prior.responseBody || typeof prior.responseBody !== 'object') throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used');
      return prior.responseBody as Record<string, unknown>;
    }
    const row = await tx.permanentDeviceInstallationRequest.findFirst({ where: { id: input.requestId, homeId: input.homeId }, select: { id: true, status: true, revision: true, customerReference: true, createdAt: true } });
    if (!row) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This request is not available for the selected Home');
    if (row.status !== 'SUBMITTED' || row.revision !== input.expectedRevision) throw new Stage1AuthError(409, 'REQUEST_ALREADY_STARTED', 'This request can no longer be cancelled');
    const changed = await tx.permanentDeviceInstallationRequest.updateMany({ where: { id: row.id, homeId: input.homeId, status: 'SUBMITTED', revision: input.expectedRevision }, data: { status: 'CANCELLED', cancelledAt: now, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Stage1AuthError(409, 'REQUEST_ALREADY_STARTED', 'This request can no longer be cancelled');
    const response = { schemaVersion: 'dinodia.v1', ok: true, request: { id: row.id, reference: row.customerReference, status: 'CANCELLED', revision: row.revision + 1, createdAt: row.createdAt.toISOString(), canCancel: false } };
    await tx.idempotencyRecord.create({ data: { namespace, keyHash, actorId: input.accountId, homeId: input.homeId, requestHash, responseStatus: 200, responseBody: response as Prisma.InputJsonValue, responseDigest: sha256(JSON.stringify(response)), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
    await tx.nativeDomainOutbox.updateMany({ where: { aggregateType: 'PermanentDeviceInstallationRequest', aggregateId: row.id, eventType: 'INSTALLATION_REQUEST_EMAIL', state: 'PENDING' }, data: { state: 'CANCELLED' } });
    return response;
  });
}
