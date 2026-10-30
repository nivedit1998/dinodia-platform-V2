import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { sha256 } from '@/lib/stage1Crypto';
import { buildAlexaEndpoint, type AlexaEndpoint } from '@/lib/alexa/endpointBuilder';
import { chooseFriendlyNames } from '@/lib/alexa/friendlyName';

const ALLOWED_WRITABLE_ROLES = new Set(['power', 'brightness', 'target_temperature', 'opening_percentage', 'position']);
const ALLOWED_READ_ROLES = new Set(['ambient_temperature']);
const FORBIDDEN_ROLES = new Set(['security_lock', 'lock_state']);

export type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function projectSupportedAlexaControl(raw: unknown, deviceId: string, descriptorRevision: number, osDeviceId?: string): JsonObject | null {
  const control = object(raw);
  if (!control || control.schemaVersion !== 1 || (control.deviceId !== deviceId && (!osDeviceId || control.deviceId !== osDeviceId))
    || typeof control.controlId !== 'string' || !control.controlId || control.controlId.length > 160
    || !Number.isInteger(control.catalogRevision) || control.catalogRevision !== descriptorRevision
    || typeof control.readable !== 'boolean' || control.readable !== true
    || typeof control.observable !== 'boolean' || typeof control.writable !== 'boolean'
    || typeof control.automatable !== 'boolean' || typeof control.semanticRole !== 'string'
    || FORBIDDEN_ROLES.has(control.semanticRole) || control.unsupportedReason != null
    || control.stepUpPolicy === 'required' || control.riskLevel === 'sensitive' || control.riskLevel === 'critical'
    || control.interactionKind === 'momentary_action'
    || !['boolean', 'number', 'option'].includes(String(control.valueType))) return null;

  const writableRole = ALLOWED_WRITABLE_ROLES.has(control.semanticRole);
  const readableRole = ALLOWED_READ_ROLES.has(control.semanticRole);
  if (writableRole && (!control.writable || !control.automatable || control.idempotency !== 'set_value')) return null;
  if (readableRole && (control.writable || control.automatable || !control.observable)) return null;
  if (!writableRole && !readableRole) return null;
  if (control.semanticRole === 'power' && control.valueType !== 'boolean') return null;
  if (['brightness', 'target_temperature', 'opening_percentage', 'position', 'ambient_temperature'].includes(String(control.semanticRole)) && control.valueType !== 'number') return null;

  const allowed = ['schemaVersion', 'deviceId', 'surfaceId', 'controlId', 'label', 'group', 'sortOrder', 'valueType', 'interactionKind', 'semanticRole', 'readable', 'writable', 'automatable', 'observable', 'idempotency', 'confirmationPolicy', 'riskLevel', 'stepUpPolicy', 'catalogRevision', 'expectedReportingIntervalSeconds', 'maxStateValiditySeconds', 'constraints', 'unsupportedReason'];
  const projected: JsonObject = {};
  for (const key of allowed) if (Object.hasOwn(control, key)) projected[key] = control[key];
  return projected;
}

export function endpointIdentity(linkId: string, deviceId: string, exposureGeneration: number, salt = ''): string {
  const digest = crypto.createHash('sha256').update(`dinodia-native-alexa-v1\0${linkId}\0${deviceId}\0${exposureGeneration}${salt ? `\0${salt}` : ''}`).digest('base64url');
  return `dos_${digest}`;
}

export function deviceName(device: { overrideName: string | null; originalName: string; customerLabel: string | null; managementClass: string }): string {
  const candidate = device.overrideName || (device.managementClass === 'TENANT_DEVICE' ? device.customerLabel : null) || device.originalName;
  const clean = candidate.trim().replace(/\s+/g, ' ');
  return clean.slice(0, 160) || 'Dinodia device';
}


export type LinkProjection = {
  /** The legacy per-Home view the Lambda used to convert itself (kept for compatibility). */
  properties: JsonObject[];
  /** Alexa-ready endpoints, with their final spoken names. */
  endpoints: AlexaEndpoint[];
};

/**
 * Recomputes, for one link, which devices Alexa may see and how: every ACTIVE tenant scope's currently granted and
 * selected rooms, installed shared devices and the tenant's own, supported controls only. Creates, updates and revokes
 * the endpoint projections in the caller's transaction, so what Alexa is told and what a directive is allowed to do
 * both come from the same rows. Callers hold the account and link locks.
 */
export async function projectAlexaLinkEndpoints(tx: Prisma.TransactionClient, link: { id: string; customerAccountId: string }, now: Date): Promise<LinkProjection> {
  const scopes = await tx.alexaNativeHomeScope.findMany({ where: {
    linkId: link.id, revokedAt: null,
    membership: { customerAccountId: link.customerAccountId, role: 'TENANT', status: 'ACTIVE' },
    home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' },
  }, orderBy: [{ homeId: 'asc' }, { membershipId: 'asc' }], select: {
    id: true, homeId: true, membershipId: true, exposureGeneration: true,
    home: { select: { postcode: true, activeHubInstallationId: true, areas: { where: { status: 'ACTIVE' }, select: { id: true, originalName: true, overrideName: true } } } },
    membership: { select: { id: true, role: true, status: true, customerAccountId: true,
      tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } },
    areaSelections: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true, exposureGeneration: true } },
  } });

  type Candidate = { scope: (typeof scopes)[number]; device: Awaited<ReturnType<typeof loadDevices>>[number]; controls: JsonObject[]; areaIds: string[]; areaId: string; areaGeneration: number };
  const candidates: Candidate[] = [];
  const hubs = new Map<string, boolean>();
  for (const scope of scopes) {
    const hubId = scope.home.activeHubInstallationId;
    if (!hubId || scope.membership.role !== 'TENANT' || scope.membership.status !== 'ACTIVE' || scope.membership.customerAccountId !== link.customerAccountId) continue;
    if (!hubs.has(hubId)) hubs.set(hubId, !!(await tx.hubInstallation.findFirst({ where: { id: hubId, homeId: scope.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true } })));
    if (!hubs.get(hubId)) continue;
    const granted = new Set(scope.membership.tenantAreaGrants.map((grant) => grant.areaId));
    const currentSelections = scope.areaSelections.filter((selection) => granted.has(selection.areaId));
    const selectedAreaIds = [...new Set(currentSelections.map((selection) => selection.areaId))].sort();
    if (selectedAreaIds.length === 0) continue;
    const generationByArea = new Map(currentSelections.map((selection) => [selection.areaId, selection.exposureGeneration]));
    const devices = await loadDevices(tx, scope.homeId, hubId, scope.membershipId, selectedAreaIds, now);
    for (const device of devices) {
      if (device.homeId !== scope.homeId || device.managementClass === 'TENANT_DEVICE' && device.ownerMembershipId !== scope.membershipId
        || device.managementClass === 'PROPERTY_DEVICE' && device.ownerMembershipId !== null) continue;
      const summary = object(device.capabilitySummary);
      const catalog = object(summary?.controlCatalog);
      const rawControls = Array.isArray(catalog?.controls) ? catalog.controls : [];
      if (catalog?.revision !== device.descriptorRevision || typeof catalog.descriptorDigest !== 'string'
        || catalog.descriptorDigest !== device.descriptorDigest || rawControls.length > 64) continue;
      const controls = rawControls.map((raw) => projectSupportedAlexaControl(raw, device.id, device.descriptorRevision, device.osDeviceId)).filter((item): item is JsonObject => item !== null);
      if (controls.length === 0) continue;
      const areaIds = device.assignments.map((assignment) => assignment.areaId).filter((areaId) => granted.has(areaId) && generationByArea.has(areaId)).sort();
      if (areaIds.length === 0) continue;
      candidates.push({ scope, device, controls, areaIds, areaId: areaIds[0], areaGeneration: generationByArea.get(areaIds[0]) ?? 1 });
    }
  }

  // Keep a device's room stable while it stays valid; re-pin to another granted room when the old one is gone.
  const existingRows = await tx.alexaNativeEndpointProjection.findMany({ where: { linkId: link.id }, select: {
    id: true, deviceId: true, endpointId: true, exposureGeneration: true, status: true, homeId: true, membershipId: true, areaId: true, payloadHash: true,
  } });
  const existingByDevice = new Map(existingRows.map((row) => [row.deviceId, row]));
  const roomNames = new Map<string, string>();
  for (const scope of scopes) for (const area of scope.home.areas) roomNames.set(area.id, area.overrideName ?? area.originalName);
  for (const candidate of candidates) {
    const existing = existingByDevice.get(candidate.device.id);
    if (existing && existing.status === 'ACTIVE' && existing.homeId === candidate.scope.homeId && existing.membershipId === candidate.scope.membershipId && candidate.areaIds.includes(existing.areaId)) {
      candidate.areaId = existing.areaId;
      candidate.areaGeneration = candidate.scope.areaSelections.find((selection) => selection.areaId === existing.areaId)?.exposureGeneration ?? candidate.areaGeneration;
    }
  }
  const names = chooseFriendlyNames(candidates.map((candidate) => ({
    key: candidate.device.id, deviceName: deviceName(candidate.device), roomName: roomNames.get(candidate.areaId) ?? null,
    homeKey: candidate.scope.homeId, postcode: candidate.scope.home.postcode ?? '', order: candidate.device.createdAt.getTime(),
  })));

  const properties = new Map<string, { scope: Candidate['scope']; data: JsonObject[] }>();
  const endpoints: AlexaEndpoint[] = [];
  const seenDeviceIds = new Set<string>();
  for (const candidate of candidates) {
    const { scope, device, controls, areaIds, areaId } = candidate;
    const existing = existingByDevice.get(device.id);
    // A live endpoint keeps its id for as long as it stays exposed (it may move to another granted room). Anything
    // retired and later exposed again is a new endpoint with a new id; the old id is reported as removed by the sweep.
    const live = existing?.status === 'ACTIVE' && existing.homeId === scope.homeId && existing.membershipId === scope.membershipId;
    const exposureGeneration = live && existing.areaId === areaId ? existing.exposureGeneration : candidate.areaGeneration;
    let endpointId = live ? existing.endpointId : endpointIdentity(link.id, device.id, exposureGeneration);
    if (!live && existing && existing.endpointId === endpointId) endpointId = endpointIdentity(link.id, device.id, exposureGeneration, now.toISOString());
    const friendlyName = names.get(device.id) ?? deviceName(device);
    const endpoint = buildAlexaEndpoint({ endpointId, friendlyName, label: device.customerLabel, controls });
    if (!endpoint) continue;
    const payloadHash = sha256(JSON.stringify(endpoint));
    const capabilities = { schemaVersion: 1, controls, alexaEndpoint: endpoint } as unknown as Prisma.InputJsonValue;
    if (existing && live) {
      await tx.alexaNativeEndpointProjection.update({ where: { id: existing.id }, data: {
        areaId, descriptorRevision: device.descriptorRevision, exposureGeneration, displayName: friendlyName, capabilities,
        payloadHash, updatedAt: now,
      } });
    } else {
      if (existing) {
        await tx.alexaNativeEndpointProjection.delete({ where: { id: existing.id } });
      }
      await tx.alexaNativeEndpointProjection.create({ data: {
        linkId: link.id, homeId: scope.homeId, membershipId: scope.membershipId,
        deviceId: device.id, areaId, endpointId, descriptorRevision: device.descriptorRevision,
        exposureGeneration, displayName: friendlyName, capabilities, payloadHash, status: 'ACTIVE',
      } });
    }
    seenDeviceIds.add(device.id);
    endpoints.push(endpoint);
    const bucket = properties.get(scope.id) ?? { scope, data: [] };
    bucket.data.push({
      endpointId, id: device.id, homeId: device.homeId,
      managementClass: device.managementClass === 'TENANT_DEVICE' ? 'tenant_device' : 'property_device',
      ownerMembershipId: device.managementClass === 'TENANT_DEVICE' ? device.ownerMembershipId : null,
      lifecycle: 'installed', technicalLabel: device.technicalLabel,
      customerLabel: null, friendlyName, propertyPostcode: scope.home.postcode ?? '',
      areaName: roomNames.get(areaId) ?? '', areaIds, controls, descriptorRevision: device.descriptorRevision,
    });
    properties.set(scope.id, bucket);
  }

  // Revoke cached projections that no longer have a current selected-room, membership, device, hub or supported path.
  const staleIds = existingRows.filter((row) => row.status !== 'REVOKED' && !seenDeviceIds.has(row.deviceId)).map((row) => row.id);
  if (staleIds.length) await tx.alexaNativeEndpointProjection.updateMany({ where: { id: { in: staleIds }, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });

  return {
    endpoints,
    properties: scopes.flatMap((scope) => {
      const bucket = properties.get(scope.id);
      const selectedAreaIds = [...new Set(scope.areaSelections.map((selection) => selection.areaId).filter((areaId) => scope.membership.tenantAreaGrants.some((grant) => grant.areaId === areaId)))].sort();
      if (!bucket || selectedAreaIds.length === 0) return [];
      return [{ homeId: scope.homeId, membership: { homeMembershipId: scope.membershipId, role: 'TENANT' },
        selectedAreaIds, exposureGeneration: scope.exposureGeneration, postcode: scope.home.postcode ?? '', data: bucket.data }];
    }),
  };
}

async function loadDevices(tx: Prisma.TransactionClient, homeId: string, hubId: string, membershipId: string, areaIds: string[], now: Date) {
  return tx.nativeDevice.findMany({ where: {
    homeId, hubInstallationId: hubId, lifecycle: 'INSTALLED',
    OR: [
      { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null },
      { managementClass: 'TENANT_DEVICE', ownerMembershipId: membershipId },
    ],
    assignments: { some: { validFrom: { lte: now }, validUntil: null, areaId: { in: areaIds }, area: { status: 'ACTIVE' } } },
  }, orderBy: [{ id: 'asc' }], select: {
    id: true, homeId: true, originalName: true, overrideName: true, technicalLabel: true, createdAt: true,
    customerLabel: true, managementClass: true, ownerMembershipId: true, osDeviceId: true, descriptorRevision: true, descriptorDigest: true,
    capabilitySummary: true,
    assignments: { where: { validFrom: { lte: now }, validUntil: null, areaId: { in: areaIds }, area: { status: 'ACTIVE' } }, orderBy: [{ areaId: 'asc' }], select: { areaId: true } },
  } });
}
