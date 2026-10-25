import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { sha256 } from '@/lib/stage1Crypto';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';

const ALLOWED_WRITABLE_ROLES = new Set(['power', 'brightness', 'target_temperature', 'opening_percentage', 'position']);
const ALLOWED_READ_ROLES = new Set(['ambient_temperature']);
const FORBIDDEN_ROLES = new Set(['security_lock', 'lock_state']);

type AlexaActor = { accountId: string; linkId: string; tokenHash: string };
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function nativeAlexaEnabled(): boolean {
  return process.env.DINODIA_NATIVE_ALEXA_ENABLED === 'true';
}

function readBearer(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer (dno-alexa-access-[A-Za-z0-9_-]{40,128})$/.exec(authorization);
  if (!match) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
  return match[1];
}

async function currentAlexaActor(tx: Prisma.TransactionClient, tokenHash: string, now: Date): Promise<AlexaActor> {
  const token = await tx.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: {
    tokenHash: true, expiresAt: true, revokedAt: true,
    family: { select: {
      id: true, linkId: true, absoluteExpiresAt: true, inactivityExpiresAt: true, revokedAt: true,
      link: { select: { id: true, customerAccountId: true, status: true, revokedAt: true,
        customerAccount: { select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true } } } },
    } },
  } });
  if (!token || token.revokedAt || token.expiresAt <= now || token.tokenHash !== tokenHash
    || token.family.revokedAt || token.family.absoluteExpiresAt <= now || token.family.inactivityExpiresAt <= now
    || token.family.link.status !== 'ACTIVE' || token.family.link.revokedAt
    || token.family.link.customerAccount.id !== token.family.link.customerAccountId
    || token.family.link.customerAccount.status !== 'ACTIVE' || !token.family.link.customerAccount.emailVerifiedAt
    || token.family.link.customerAccount.mustChangePassword || token.family.link.customerAccount.usernameSelectionRequired) {
    throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
  }
  const policy = currentCustomerPolicy();
  if (!policy) throw new Stage1AuthError(503, 'customer_policy_unavailable', 'Customer access is unavailable until the current policy is configured');
  const accepted = await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
    customerAccountId: token.family.link.customerAccount.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
  } }, select: { id: true } });
  if (!accepted) throw new Stage1AuthError(403, 'customer_policy_acceptance_required', 'Review and accept the current Dinodia policy before continuing');
  return { accountId: token.family.link.customerAccountId, linkId: token.family.linkId, tokenHash };
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

function endpointIdentity(linkId: string, deviceId: string, exposureGeneration: number): string {
  const digest = crypto.createHash('sha256').update(`dinodia-native-alexa-v1\0${linkId}\0${deviceId}\0${exposureGeneration}`).digest('base64url');
  return `dos_${digest}`;
}

function deviceName(device: { overrideName: string | null; originalName: string; customerLabel: string | null; managementClass: string }): string {
  const candidate = device.overrideName || (device.managementClass === 'TENANT_DEVICE' ? device.customerLabel : null) || device.originalName;
  const clean = candidate.trim().replace(/\s+/g, ' ');
  return clean.slice(0, 160) || 'Dinodia device';
}

/** Re-authorized, multi-property Alexa discovery from current Platform-owned inventory. */
export async function discoverNativeAlexa(request: Request) {
  if (!nativeAlexaEnabled()) throw new Stage1AuthError(501, 'NATIVE_FEATURE_NOT_ENABLED', 'Native Alexa is not yet activated');
  const token = readBearer(request);
  const tokenHash = sha256(token);
  return serializableTransaction(async (tx) => {
    const now = new Date();
    const initial = await currentAlexaActor(tx, tokenHash, now);
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${initial.accountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${initial.linkId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthTokenFamily" WHERE "linkId" = ${initial.linkId}::uuid ORDER BY "id" FOR UPDATE`;
    const actor = await currentAlexaActor(tx, tokenHash, new Date());
    if (actor.accountId !== initial.accountId || actor.linkId !== initial.linkId) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');

    const scopes = await tx.alexaNativeHomeScope.findMany({ where: {
      linkId: actor.linkId, revokedAt: null,
      membership: { customerAccountId: actor.accountId, role: 'TENANT', status: 'ACTIVE' },
      home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' },
    }, orderBy: [{ homeId: 'asc' }, { membershipId: 'asc' }], select: {
      id: true, homeId: true, membershipId: true, exposureGeneration: true,
      home: { select: { postcode: true, activeHubInstallationId: true, areas: { where: { status: 'ACTIVE' }, select: { id: true, originalName: true, overrideName: true } } } },
      membership: { select: { id: true, role: true, status: true, customerAccountId: true,
        tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } },
      areaSelections: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true, exposureGeneration: true } },
    } });

    const properties: Array<JsonObject> = [];
    const seenDeviceIds = new Set<string>();
    for (const scope of scopes) {
      const hubId = scope.home.activeHubInstallationId;
      if (!hubId || scope.membership.role !== 'TENANT' || scope.membership.status !== 'ACTIVE' || scope.membership.customerAccountId !== actor.accountId) continue;
      const hub = await tx.hubInstallation.findFirst({ where: { id: hubId, homeId: scope.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      if (!hub) continue;
      const granted = new Set(scope.membership.tenantAreaGrants.map((grant) => grant.areaId));
      const currentSelections = scope.areaSelections.filter((selection) => granted.has(selection.areaId));
      const selectedAreaIds = [...new Set(currentSelections.map((selection) => selection.areaId))].sort();
      if (selectedAreaIds.length === 0) continue;
      const areasById = new Map(scope.home.areas.map((area) => [area.id, area]));
      const generationByArea = new Map(currentSelections.map((selection) => [selection.areaId, selection.exposureGeneration]));
      const devices = await tx.nativeDevice.findMany({ where: {
        homeId: scope.homeId, hubInstallationId: hub.id, lifecycle: 'INSTALLED',
        OR: [
          { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null },
          { managementClass: 'TENANT_DEVICE', ownerMembershipId: scope.membershipId },
        ],
        assignments: { some: { validFrom: { lte: now }, validUntil: null, areaId: { in: selectedAreaIds }, area: { status: 'ACTIVE' } } },
      }, orderBy: [{ id: 'asc' }], select: {
      id: true, homeId: true, originalName: true, overrideName: true, technicalLabel: true,
        customerLabel: true, managementClass: true, ownerMembershipId: true, osDeviceId: true, descriptorRevision: true, descriptorDigest: true,
        capabilitySummary: true,
        assignments: { where: { validFrom: { lte: now }, validUntil: null, areaId: { in: selectedAreaIds }, area: { status: 'ACTIVE' } }, orderBy: [{ areaId: 'asc' }], select: { areaId: true } },
      } });

      const propertyDevices: Array<JsonObject> = [];
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
        const areaId = areaIds[0];
        const areaGeneration = generationByArea.get(areaId) ?? 1;
        const existing = await tx.alexaNativeEndpointProjection.findUnique({ where: { linkId_deviceId: { linkId: actor.linkId, deviceId: device.id } }, select: {
          id: true, endpointId: true, exposureGeneration: true, status: true, homeId: true, membershipId: true,
        } });
        const sameExposure = existing?.status === 'ACTIVE' && existing.homeId === scope.homeId && existing.membershipId === scope.membershipId;
        const exposureGeneration = sameExposure ? existing.exposureGeneration : Math.max(areaGeneration, (existing?.exposureGeneration ?? 0) + (existing ? 1 : 0));
        const endpointId = sameExposure ? existing.endpointId : endpointIdentity(actor.linkId, device.id, exposureGeneration);
        const displayName = deviceName(device);
        const capabilities = { schemaVersion: 1, controls } as Prisma.InputJsonValue;
        if (existing) {
          await tx.alexaNativeEndpointProjection.update({ where: { id: existing.id }, data: {
            homeId: scope.homeId, membershipId: scope.membershipId, areaId, endpointId,
            descriptorRevision: device.descriptorRevision, exposureGeneration, displayName, capabilities,
            status: 'ACTIVE', updatedAt: now,
          } });
        } else {
          await tx.alexaNativeEndpointProjection.create({ data: {
            linkId: actor.linkId, homeId: scope.homeId, membershipId: scope.membershipId,
            deviceId: device.id, areaId, endpointId, descriptorRevision: device.descriptorRevision,
            exposureGeneration, displayName, capabilities, status: 'ACTIVE',
          } });
        }
        seenDeviceIds.add(device.id);
        propertyDevices.push({
          endpointId, id: device.id, homeId: device.homeId,
          managementClass: device.managementClass === 'TENANT_DEVICE' ? 'tenant_device' : 'property_device',
          ownerMembershipId: device.managementClass === 'TENANT_DEVICE' ? device.ownerMembershipId : null,
          lifecycle: 'installed', technicalLabel: device.technicalLabel,
          customerLabel: null, friendlyName: displayName, propertyPostcode: scope.home.postcode ?? '',
          areaName: areasById.get(areaId)?.overrideName ?? areasById.get(areaId)?.originalName ?? '',
          areaIds, controls, descriptorRevision: device.descriptorRevision,
        });
      }
      properties.push({ homeId: scope.homeId,
        membership: { homeMembershipId: scope.membershipId, role: 'TENANT' },
        selectedAreaIds, exposureGeneration: scope.exposureGeneration,
        postcode: scope.home.postcode ?? '', data: propertyDevices });
    }

    // Revoke cached projections that no longer have a current selected-area,
    // membership, device, hub or supported descriptor path.
    const active = await tx.alexaNativeEndpointProjection.findMany({ where: { linkId: actor.linkId, status: { not: 'REVOKED' } }, select: { id: true, deviceId: true } });
    const staleIds = active.filter((row) => !seenDeviceIds.has(row.deviceId)).map((row) => row.id);
    if (staleIds.length) await tx.alexaNativeEndpointProjection.updateMany({ where: { id: { in: staleIds }, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });

    const allNames = properties.flatMap((property) => Array.isArray(property.data) ? property.data as Array<JsonObject> : []);
    const counts = new Map<string, number>();
    for (const device of allNames) {
      const normalized = String(device.friendlyName ?? '').trim().toLocaleLowerCase('en-GB');
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    for (const property of properties) {
      if (!Array.isArray(property.data)) continue;
      property.data = (property.data as Array<JsonObject>).map((device) => {
        const name = String(device.friendlyName ?? 'Dinodia device');
        const key = name.trim().toLocaleLowerCase('en-GB');
        return counts.get(key)! > 1 && String(device.propertyPostcode ?? '')
          ? { ...device, friendlyName: `${name} (${String(device.propertyPostcode)})`.slice(0, 160) }
          : device;
      });
    }
    return { schemaVersion: 'dinodia.v1', properties };
  }, 3);
}
