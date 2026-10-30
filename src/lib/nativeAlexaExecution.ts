import crypto from 'node:crypto';
import { rangeControllerInstances } from '@/lib/alexa/endpointBuilder';
import { prisma } from '@/lib/prisma';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { sha256, signNativeAlexaCommandToken, signNativeAlexaStateToken } from '@/lib/stage1Crypto';
import { projectSupportedAlexaControl } from '@/lib/nativeAlexaDiscovery';

type JsonObject = Record<string, unknown>;
type AlexaDirective = {
  header: { namespace: string; name: string; messageId: string; payloadVersion: string; correlationToken?: string; instance?: string };
  endpoint: { endpointId: string; scope: { type: 'BearerToken'; token: string } };
  payload: JsonObject;
};
export type AuthorizedEndpoint = {
  accountId: string; linkId: string; endpointId: string; homeId: string; membershipId: string;
  areaId: string; hubId: string; osDeviceId: string; descriptorRevision: number;
  accessRevision: number; hubPolicyRevision: number; cloudUrl: string; reservedHostname: string;
  controls: JsonObject[]; displayName: string;
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_HUB_RESPONSE_BYTES = 64 * 1024;
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OS_DELEGATION_SECONDS = 15;
const READABLE = new Set(['power', 'brightness', 'target_temperature', 'ambient_temperature', 'opening_percentage', 'position']);
const RANGE_ROLES = new Set(['opening_percentage', 'position']);
type AlexaProperty = { namespace: string; name: string; value: unknown; timeOfSample: string; uncertaintyInMilliseconds: number; instance?: string };

function record(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function bearerFromDirective(directive: AlexaDirective): string {
  const token = directive.endpoint?.scope?.token;
  if (typeof token !== 'string' || !/^dno-alexa-access-[A-Za-z0-9_-]{40,128}$/.test(token)) {
    throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
  }
  return token;
}

function parseDirective(value: unknown): AlexaDirective {
  const root = record(value);
  const directive = record(root?.directive);
  const header = record(directive?.header);
  const endpoint = record(directive?.endpoint);
  const scope = record(endpoint?.scope);
  const payload = record(directive?.payload) ?? {};
  if (!root || Object.keys(root).join(',') !== 'directive' || !directive || !header || !endpoint || !scope
    || typeof header.namespace !== 'string' || typeof header.name !== 'string'
    || typeof header.messageId !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/.test(header.messageId)
    || header.payloadVersion !== '3' || typeof endpoint.endpointId !== 'string'
    || !/^dos_[A-Za-z0-9_-]{16,80}$/.test(endpoint.endpointId)
    || scope.type !== 'BearerToken' || typeof scope.token !== 'string'
    || Object.keys(scope).some((key) => key !== 'type' && key !== 'token')) {
    throw new Stage1AuthError(400, 'alexa_directive_invalid', 'The Alexa request is not a valid Native V2 directive');
  }
  if (header.correlationToken !== undefined && (typeof header.correlationToken !== 'string' || header.correlationToken.length > 2048)) {
    throw new Stage1AuthError(400, 'alexa_directive_invalid', 'The Alexa request is not a valid Native V2 directive');
  }
  if (header.instance !== undefined && (header.namespace !== 'Alexa.RangeController' || typeof header.instance !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(header.instance))) {
    throw new Stage1AuthError(400, 'alexa_directive_invalid', 'The Alexa request is not a valid Native V2 directive');
  }
  return { header: header as AlexaDirective['header'], endpoint: endpoint as AlexaDirective['endpoint'], payload };
}

function cloudOrigin(endpoint: AuthorizedEndpoint): string {
  // Test-only transport can target a loopback Native OS listener. It is
  // impossible to activate in Production because both the V2 environment and
  // a literal loopback origin are required.
  const testOrigin = String(process.env.DINODIA_ALEXA_LOOPBACK_TEST_ORIGIN ?? '');
  if (process.env.V2_ENVIRONMENT === 'test' && testOrigin) {
    try {
      const url = new URL(testOrigin);
      if (url.protocol === 'http:' && ['127.0.0.1', '::1', '[::1]'].includes(url.hostname)
        && !url.username && !url.password && Boolean(url.port)
        && url.pathname === '/' && !url.search && !url.hash) return url.origin;
    } catch { /* fail closed below */ }
    throw new Stage1AuthError(503, 'alexa_hub_unavailable', 'The isolated Native OS test endpoint is invalid');
  }
  try {
    const url = new URL(endpoint.cloudUrl);
    const hostname = endpoint.reservedHostname.toLowerCase();
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== hostname || url.username || url.password || url.port
      || !['', '/'].includes(url.pathname) || url.search || url.hash
      || !/^dinodia-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.dinodiasmartliving\.com$/.test(hostname)) throw new Error('invalid');
    return url.origin;
  } catch {
    throw new Stage1AuthError(503, 'alexa_hub_unavailable', 'The verified Native OS endpoint is unavailable');
  }
}

function platformPrivateKey(): crypto.KeyObject {
  const pem = String(process.env.DINODIA_APP_SESSION_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
  if (!pem) throw new Stage1AuthError(503, 'alexa_signing_unavailable', 'Native Alexa signing is not configured');
  try {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return key;
  } catch {
    throw new Stage1AuthError(503, 'alexa_signing_unavailable', 'Native Alexa signing is not configured');
  }
}

function requireCurrentAlexaFeature() {
  if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') {
    throw new Stage1AuthError(501, 'NATIVE_FEATURE_NOT_ENABLED', 'Native Alexa is not yet activated');
  }
}

async function lockAndAuthorizeEndpoint(tokenHash: string, endpointId: string): Promise<AuthorizedEndpoint> {
  requireCurrentAlexaFeature();
  return serializableTransaction(async (tx) => {
    const tokenHint = await tx.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: {
      id: true, familyId: true, family: { select: { linkId: true, link: { select: { customerAccountId: true } } } },
    } });
    if (!tokenHint) throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
    const endpointHint = await tx.alexaNativeEndpointProjection.findUnique({ where: { endpointId }, select: {
      homeId: true, membershipId: true, linkId: true,
    } });
    if (!endpointHint || endpointHint.linkId !== tokenHint.family.linkId) {
      throw new Stage1AuthError(404, 'alexa_endpoint_unavailable', 'The selected Alexa endpoint is unavailable');
    }

    // Match current property/security lock ordering: Home -> account -> link
    // and token family -> membership/grants -> hub -> endpoint projection.
    await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${endpointHint.homeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${tokenHint.family.link.customerAccountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${tokenHint.family.linkId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaOAuthTokenFamily" WHERE "linkId" = ${tokenHint.family.linkId}::uuid ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${endpointHint.membershipId}::uuid AND "homeId" = ${endpointHint.homeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${endpointHint.membershipId}::uuid AND "homeId" = ${endpointHint.homeId}::uuid ORDER BY "areaId" FOR UPDATE`;

    const now = new Date();
    const access = await tx.alexaOAuthAccessToken.findUnique({ where: { tokenHash }, select: {
      expiresAt: true, revokedAt: true, family: { select: {
        id: true, linkId: true, absoluteExpiresAt: true, inactivityExpiresAt: true, revokedAt: true,
        link: { select: { id: true, customerAccountId: true, status: true, revokedAt: true,
          customerAccount: { select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true } } } },
      } },
    } });
    const policy = currentCustomerPolicy();
    const accepted = policy ? await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
      customerAccountId: tokenHint.family.link.customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
    } }, select: { id: true } }) : null;
    if (!access || access.revokedAt || access.expiresAt <= now || access.family.revokedAt
      || access.family.absoluteExpiresAt <= now || access.family.inactivityExpiresAt <= now
      || access.family.linkId !== tokenHint.family.linkId || access.family.link.status !== 'ACTIVE' || access.family.link.revokedAt
      || access.family.link.customerAccount.id !== access.family.link.customerAccountId
      || access.family.link.customerAccount.status !== 'ACTIVE' || !access.family.link.customerAccount.emailVerifiedAt
      || access.family.link.customerAccount.mustChangePassword || access.family.link.customerAccount.usernameSelectionRequired
      || !policy || !accepted) {
      throw new Stage1AuthError(401, 'alexa_access_token_invalid', 'A current Alexa authorization is required');
    }

    const projection = await tx.alexaNativeEndpointProjection.findUnique({ where: { endpointId }, select: {
      id: true, linkId: true, homeId: true, membershipId: true, deviceId: true, areaId: true,
      descriptorRevision: true, exposureGeneration: true, displayName: true, status: true,
      link: { select: { customerAccountId: true, status: true, revokedAt: true, revision: true } },
      home: { select: { lifecycle: true, installationStatus: true, activeHubInstallationId: true, authorityGeneration: true } },
      membership: { select: { id: true, homeId: true, customerAccountId: true, role: true, status: true, accessRevision: true,
        tenantAreaGrants: { where: { revokedAt: null }, select: { areaId: true } } } },
      area: { select: { id: true, homeId: true, status: true } },
      device: { select: { id: true, homeId: true, hubInstallationId: true, osDeviceId: true, managementClass: true,
        ownerMembershipId: true, lifecycle: true, descriptorRevision: true, descriptorDigest: true, capabilitySummary: true,
        assignments: { where: { validFrom: { lte: now }, validUntil: null }, select: { areaId: true, homeId: true } } } },
    } });
    if (!projection || projection.linkId !== access.family.linkId || projection.status !== 'ACTIVE'
      || projection.link.status !== 'ACTIVE' || projection.link.revokedAt
      || projection.link.customerAccountId !== access.family.link.customerAccountId
      || projection.home.lifecycle !== 'ACTIVE' || projection.home.installationStatus !== 'COMPLETE'
      || projection.membership.id !== projection.membershipId || projection.membership.homeId !== projection.homeId
      || projection.membership.customerAccountId !== access.family.link.customerAccountId
      || projection.membership.role !== 'TENANT' || projection.membership.status !== 'ACTIVE'
      || projection.device.homeId !== projection.homeId || projection.device.hubInstallationId !== projection.home.activeHubInstallationId
      || projection.device.lifecycle !== 'INSTALLED' || projection.device.descriptorRevision !== projection.descriptorRevision
      || !projection.device.osDeviceId || projection.device.managementClass === 'TENANT_DEVICE' && projection.device.ownerMembershipId !== projection.membershipId
      || projection.device.managementClass === 'PROPERTY_DEVICE' && projection.device.ownerMembershipId !== null
      ) {
      throw new Stage1AuthError(404, 'alexa_endpoint_unavailable', 'The selected Alexa endpoint is no longer available');
    }
    const hubHint = projection.home.activeHubInstallationId;
    if (!hubHint) throw new Stage1AuthError(503, 'alexa_hub_unavailable', 'The selected Dinodia hub is unavailable');
    await tx.$queryRaw`SELECT "id" FROM "HubInstallation" WHERE "id" = ${hubHint}::uuid AND "homeId" = ${projection.homeId}::uuid FOR UPDATE`;
    const hub = await tx.hubInstallation.findFirst({ where: {
      id: hubHint, homeId: projection.homeId, lifecycleStatus: 'ACTIVE', state: 'ACTIVE',
      cloudUrl: { not: null }, cloudUrlVerifiedAt: { lte: now }, remoteVerificationAt: { lte: now },
    }, select: { id: true, cloudUrl: true, reservedHostname: true, cloudUrlVerifiedAt: true, remoteVerificationAt: true, accessPolicyRevision: true } });
    const scope = await tx.alexaNativeHomeScope.findUnique({ where: { linkId_membershipId: {
      linkId: projection.linkId, membershipId: projection.membershipId,
    } }, select: { id: true, homeId: true, revokedAt: true, areaSelections: { where: { revokedAt: null, area: { status: 'ACTIVE', homeId: projection.homeId } }, select: { areaId: true, exposureGeneration: true } } } });
    if (!hub || !hub.cloudUrl || !hub.reservedHostname || !hub.cloudUrlVerifiedAt || !hub.remoteVerificationAt
      || hub.cloudUrlVerifiedAt > now || hub.remoteVerificationAt > now || !scope || scope.revokedAt
      || scope.homeId !== projection.homeId) {
      throw new Stage1AuthError(404, 'alexa_endpoint_unavailable', 'The selected Alexa endpoint is no longer available');
    }
    // The device keeps working in whichever of its rooms the tenant may currently use: its pinned room while that stays
    // assigned, granted and selected, otherwise any other room that is (a device moved to another room still works).
    const grantedAreaIds = new Set(projection.membership.tenantAreaGrants.map((grant) => grant.areaId));
    const assignedAreaIds = new Set(projection.device.assignments.filter((assignment) => assignment.homeId === projection.homeId).map((assignment) => assignment.areaId));
    const usableSelections = scope.areaSelections.filter((selection) => grantedAreaIds.has(selection.areaId) && assignedAreaIds.has(selection.areaId));
    const pinned = usableSelections.find((selection) => selection.areaId === projection.areaId && selection.exposureGeneration === projection.exposureGeneration
      && projection.area.status === 'ACTIVE' && projection.area.homeId === projection.homeId);
    const effective = pinned ?? [...usableSelections].sort((a, b) => a.areaId.localeCompare(b.areaId))[0];
    if (!effective) throw new Stage1AuthError(404, 'alexa_endpoint_unavailable', 'The selected Alexa endpoint is no longer available');
    const effectiveAreaId = effective.areaId;
    const summary = record(projection.device.capabilitySummary);
    const catalog = record(summary?.controlCatalog);
    const rawControls = Array.isArray(catalog?.controls) ? catalog.controls : [];
    if (catalog?.revision !== projection.device.descriptorRevision || typeof catalog.descriptorDigest !== 'string'
      || !/^[a-f0-9]{64}$/i.test(catalog.descriptorDigest) || catalog.descriptorDigest !== projection.device.descriptorDigest
      || rawControls.length > 64) {
      throw new Stage1AuthError(409, 'alexa_descriptor_changed', 'The device controls changed. Refresh Alexa discovery before retrying');
    }
    const controls = rawControls.map((raw) => projectSupportedAlexaControl(raw, projection.deviceId, projection.device.descriptorRevision, projection.device.osDeviceId))
      .filter((item): item is JsonObject => item !== null);
    if (controls.length === 0) throw new Stage1AuthError(404, 'alexa_endpoint_unavailable', 'The selected Alexa endpoint has no supported controls');
    if (projection.device.managementClass === 'TENANT_DEVICE' && projection.device.ownerMembershipId !== projection.membershipId) {
      throw new Stage1AuthError(404, 'alexa_endpoint_unavailable', 'The selected Alexa endpoint is no longer available');
    }
    return {
      accountId: access.family.link.customerAccountId, linkId: projection.linkId, endpointId,
      homeId: projection.homeId, membershipId: projection.membershipId, areaId: effectiveAreaId,
      hubId: hub.id, osDeviceId: projection.device.osDeviceId, descriptorRevision: projection.descriptorRevision,
      accessRevision: projection.membership.accessRevision, hubPolicyRevision: hub.accessPolicyRevision,
      cloudUrl: hub.cloudUrl, reservedHostname: hub.reservedHostname, controls, displayName: projection.displayName,
    };
  }, 3, { timeoutMs: 8000 });
}

type AlexaCommandOperation = { control: JsonObject; value: boolean | number; alexaNamespace: string; propertyName: string; propertyValue: unknown;
  adjustmentDelta?: number; expectedObservationRevision?: number };

function commandValue(directive: AlexaDirective, controls: JsonObject[]): AlexaCommandOperation {
  const { namespace, name } = directive.header;
  let role: string;
  let value: boolean | number;
  let alexaNamespace: string;
  let propertyName: string;
  let propertyValue: unknown;
  let matchedControl: JsonObject | undefined;
  if (namespace === 'Alexa.PowerController' && (name === 'TurnOn' || name === 'TurnOff')) {
    role = 'power'; value = name === 'TurnOn'; alexaNamespace = namespace; propertyName = 'powerState'; propertyValue = value ? 'ON' : 'OFF';
  } else if (namespace === 'Alexa.BrightnessController' && (name === 'SetBrightness' || name === 'AdjustBrightness')) {
    role = 'brightness'; value = name === 'SetBrightness' ? directive.payload.brightness as number : 0; alexaNamespace = namespace; propertyName = 'brightness'; propertyValue = value;
    if (name === 'AdjustBrightness') {
      const delta = directive.payload.brightnessDelta;
      if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested brightness change is invalid');
      return adjustmentOperation(controls, role, delta, namespace, propertyName);
    }
  } else if (namespace === 'Alexa.ThermostatController' && (name === 'SetTargetTemperature' || name === 'AdjustTargetTemperature')) {
    role = 'target_temperature';
    if (name === 'AdjustTargetTemperature') {
      const delta = record(directive.payload.targetSetpointDelta);
      if (!delta || !['CELSIUS', 'FAHRENHEIT'].includes(String(delta.scale)) || typeof delta.value !== 'number'
        || !Number.isFinite(delta.value) || delta.value === 0) {
        throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested temperature change is invalid');
      }
      const control = controls.find((candidate) => candidate.semanticRole === role && candidate.writable === true
        && candidate.readable === true && candidate.observable === true && candidate.automatable === true
        && candidate.idempotency === 'set_value' && candidate.stepUpPolicy !== 'required');
      const unit = String(record(control?.constraints)?.unit ?? '').toLowerCase();
      if (!control || !['celsius', 'fahrenheit'].includes(unit)) throw new Stage1AuthError(409, 'alexa_descriptor_changed', 'The current thermostat unit is unavailable');
      const controlScale = unit === 'fahrenheit' ? 'FAHRENHEIT' : 'CELSIUS';
      const convertedDelta = delta.scale === controlScale ? Number(delta.value) : controlScale === 'CELSIUS' ? Number(delta.value) * 5 / 9 : Number(delta.value) * 9 / 5;
      return adjustmentOperation(controls, role, convertedDelta, namespace, 'targetSetpoint', control);
    }
    const target = record(directive.payload.targetSetpoint);
    if (!target || !['CELSIUS', 'FAHRENHEIT'].includes(String(target.scale)) || typeof target.value !== 'number' || !Number.isFinite(target.value)) {
      throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested temperature is invalid');
    }
    value = target.scale === 'FAHRENHEIT' ? (target.value - 32) * 5 / 9 : target.value;
    alexaNamespace = namespace; propertyName = 'targetSetpoint'; propertyValue = { value, scale: 'CELSIUS' };
  } else if (namespace === 'Alexa.RangeController' && (name === 'SetRangeValue' || name === 'AdjustRangeValue')) {
    if (Object.hasOwn(directive.payload, 'instance') || !directive.header.instance) {
      throw new Stage1AuthError(400, 'alexa_directive_invalid', 'Range control identity must be supplied in the Alexa header');
    }
    const instances = rangeControllerInstances(controls);
    matchedControl = controls.find((candidate) => instances.get(String(candidate.controlId)) === directive.header.instance);
    if (!matchedControl) throw new Stage1AuthError(404, 'alexa_control_unavailable', 'This range control is not currently available to Alexa');
    role = String(matchedControl.semanticRole);
    if (name === 'AdjustRangeValue') {
      const requestedDelta = directive.payload.rangeValueDelta;
      const defaultDelta = directive.payload.rangeValueDeltaDefault;
      const constraints = record(matchedControl.constraints);
      if (typeof requestedDelta !== 'number' || !Number.isFinite(requestedDelta) || requestedDelta === 0 || typeof defaultDelta !== 'boolean'
        || !constraints || typeof constraints.step !== 'number' || !Number.isFinite(constraints.step) || constraints.step <= 0) {
        throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested range change is invalid');
      }
      const delta = defaultDelta ? Math.sign(requestedDelta) * constraints.step : requestedDelta;
      return adjustmentOperation(controls, role, delta, namespace, 'rangeValue', matchedControl);
    }
    value = directive.payload.rangeValue as number; alexaNamespace = namespace; propertyName = 'rangeValue'; propertyValue = value;
  } else {
    throw new Stage1AuthError(400, 'alexa_directive_unsupported', 'This Alexa control operation is not supported by the current Dinodia descriptor');
  }
  if (typeof value !== 'number' && typeof value !== 'boolean' || typeof value === 'number' && !Number.isFinite(value)) {
    throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested value is invalid');
  }
  const control = matchedControl ?? controls.find((candidate) => candidate.semanticRole === role && candidate.writable === true
    && candidate.automatable === true && candidate.idempotency === 'set_value' && candidate.stepUpPolicy !== 'required');
  if (!control) throw new Stage1AuthError(404, 'alexa_control_unavailable', 'This control is not currently available to Alexa');
  const bounds = record(control.constraints);
  if (typeof value === 'number' && bounds) {
    if (typeof bounds.minimum === 'number' && value < bounds.minimum || typeof bounds.maximum === 'number' && value > bounds.maximum) {
      throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested value is outside the current control range');
    }
    if (typeof bounds.step === 'number' && bounds.step > 0 && typeof bounds.minimum === 'number') {
      const steps = (value - bounds.minimum) / bounds.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-7) throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested value does not match the current control step');
    }
  }
  if (role === 'brightness' && (typeof value !== 'number' || value < 0 || value > 100)) throw new Stage1AuthError(400, 'alexa_value_invalid', 'Brightness must be between 0 and 100');
  return { control, value, alexaNamespace, propertyName, propertyValue };
}

function adjustmentOperation(controls: JsonObject[], role: string, adjustmentDelta: number, alexaNamespace: string,
  propertyName: string, exactControl?: JsonObject): AlexaCommandOperation {
  const control = exactControl ?? controls.find((candidate) => candidate.semanticRole === role && candidate.writable === true
    && candidate.readable === true && candidate.observable === true && candidate.automatable === true
    && candidate.idempotency === 'set_value' && candidate.stepUpPolicy !== 'required');
  if (!control || control.writable !== true || control.readable !== true || control.observable !== true
    || control.automatable !== true || control.idempotency !== 'set_value' || control.stepUpPolicy === 'required') {
    throw new Stage1AuthError(404, 'alexa_control_unavailable', 'This control is not currently available to Alexa');
  }
  if (!Number.isFinite(adjustmentDelta) || adjustmentDelta === 0) throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested control change is invalid');
  return { control, value: 0, alexaNamespace, propertyName, propertyValue: null, adjustmentDelta };
}

// A setting (writable control) stays as last set until changed, so its last report is the baseline when no
// current value exists. The Hub sends it separately as lastSetting; its revision must equal the state's, and
// the Hub re-checks that revision at dispatch, so a newer report always wins.
function settingBaseline(control: JsonObject, state: JsonObject, now: number): number | null {
  const last = record(state.lastSetting);
  if (control.writable !== true || !last || typeof last.value !== 'number' || !Number.isFinite(last.value)
    || last.revision !== state.revision || typeof last.observedAt !== 'string'
    || !Number.isFinite(Date.parse(last.observedAt)) || Date.parse(last.observedAt) > now) return null;
  return last.value;
}

function resolveAdjustment(control: JsonObject, stateValue: unknown, adjustmentDelta: number, now: number) {
  const state = record(stateValue);
  if (!state || state.controlId !== control.controlId || state.descriptorRevision !== control.catalogRevision
    || !Number.isSafeInteger(state.revision)) {
    throw new Stage1AuthError(409, 'alexa_state_not_current', 'Current device state is unavailable; no adjustment was sent');
  }
  const current = state.quality === 'fresh' && typeof state.observedAt === 'string' && typeof state.validUntil === 'string'
    && Number.isFinite(Date.parse(state.observedAt)) && Date.parse(state.observedAt) <= now
    && Number.isFinite(Date.parse(state.validUntil)) && Date.parse(state.validUntil) > now
    && typeof state.value === 'number' && Number.isFinite(state.value) ? state.value : null;
  const baseline = current ?? settingBaseline(control, state, now);
  if (baseline === null) {
    throw new Stage1AuthError(409, 'alexa_state_not_current', 'Current device state is unavailable; no adjustment was sent');
  }
  const bounds = record(control.constraints);
  if (!bounds || typeof bounds.minimum !== 'number' || typeof bounds.maximum !== 'number'
    || typeof bounds.step !== 'number' || bounds.step <= 0) {
    throw new Stage1AuthError(409, 'alexa_descriptor_changed', 'The current control range is unavailable');
  }
  const value = baseline + adjustmentDelta;
  const steps = (value - bounds.minimum) / bounds.step;
  if (value < bounds.minimum || value > bounds.maximum || Math.abs(steps - Math.round(steps)) > 1e-7) {
    throw new Stage1AuthError(400, 'alexa_value_invalid', 'The requested change is outside the current control range or step');
  }
  return { value: Number(value.toFixed(8)), expectedObservationRevision: Number(state.revision) };
}

function requestDigest(directive: AlexaDirective): string {
  const canonical = {
    namespace: directive.header.namespace, name: directive.header.name, payloadVersion: directive.header.payloadVersion,
    messageId: directive.header.messageId, correlationToken: directive.header.correlationToken ?? null,
    instance: directive.header.instance ?? null,
    endpointId: directive.endpoint.endpointId, payload: directive.payload,
  };
  return sha256(JSON.stringify(canonical));
}

function directiveRequestId(linkId: string, messageId: string): string {
  return `alexa:${sha256(`${linkId}\n${messageId}`)}`;
}

function tokenTime(): { issuedAt: number; expiresAt: number } {
  const issuedAt = Math.floor(Date.now() / 1000);
  return { issuedAt, expiresAt: issuedAt + MAX_OS_DELEGATION_SECONDS };
}

async function callHub(origin: string, path: string, token: string, body: JsonObject, idempotencyKey?: string): Promise<JsonObject> {
  const headers = new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' });
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(6000), redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) throw new Stage1AuthError(503, 'alexa_hub_redirect_denied', 'The selected Dinodia hub returned an unexpected redirect');
  const reader = response.body?.getReader();
  if (!reader) throw new Stage1AuthError(503, 'alexa_hub_response_invalid', 'The selected Dinodia hub returned an invalid response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_HUB_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Stage1AuthError(503, 'alexa_hub_response_invalid', 'The selected Dinodia hub returned an invalid response');
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let bodyValue: unknown;
  try { bodyValue = JSON.parse(text); } catch { bodyValue = null; }
  const parsed = record(bodyValue);
  if (!response.ok || !parsed) {
    throw new Stage1AuthError(503, parsed ? `alexa_hub_http_${response.status}` : 'alexa_hub_response_invalid', 'The selected Dinodia hub is unavailable');
  }
  return parsed;
}

async function currentAlexaControlState(endpoint: AuthorizedEndpoint, control: JsonObject): Promise<JsonObject> {
  const now = tokenTime();
  const controlId = String(control.controlId);
  const stateToken = signNativeAlexaStateToken({ accountId: endpoint.accountId, linkId: endpoint.linkId,
    endpointId: endpoint.endpointId, homeId: endpoint.homeId, membershipId: endpoint.membershipId,
    hubInstallationId: endpoint.hubId, areaId: endpoint.areaId, deviceId: endpoint.osDeviceId,
    controlIds: [controlId], descriptorRevision: endpoint.descriptorRevision,
    policyRevision: Math.max(endpoint.accessRevision, endpoint.hubPolicyRevision), issuedAt: now.issuedAt, expiresAt: now.expiresAt,
  }, platformPrivateKey());
  const result = await callHub(cloudOrigin(endpoint), '/api/dinodia/v1/alexa/state', stateToken,
    { deviceId: endpoint.osDeviceId, controlIds: [controlId] });
  if (result.schemaVersion !== 'dinodia.v1' || result.endpointId !== endpoint.endpointId || result.homeId !== endpoint.homeId
    || result.membershipId !== endpoint.membershipId || result.deviceId !== endpoint.osDeviceId
    || result.descriptorRevision !== endpoint.descriptorRevision || !Array.isArray(result.states)) {
    throw new Stage1AuthError(503, 'alexa_hub_response_invalid', 'Dinodia OS returned an invalid current state');
  }
  const state = result.states.map(record).find((candidate): candidate is JsonObject => candidate?.controlId === controlId);
  if (!state || state.deviceId !== endpoint.osDeviceId || state.homeId !== endpoint.homeId
    || state.descriptorRevision !== endpoint.descriptorRevision) {
    throw new Stage1AuthError(409, 'alexa_state_not_current', 'Current device state is unavailable; no adjustment was sent');
  }
  return state;
}

function adjustmentReceiptMarker(value: number, revision: number): string {
  const marker = `adjust:${revision}:${value}`;
  if (marker.length > 120) throw new Stage1AuthError(503, 'alexa_receipt_invalid', 'The Alexa adjustment receipt is unavailable');
  return marker;
}

function parseAdjustmentReceiptMarker(marker: string | null): { value: number; expectedObservationRevision: number } | null {
  const match = /^adjust:(\d+):(-?\d+(?:\.\d+)?)$/.exec(String(marker ?? ''));
  if (!match) return null;
  const expectedObservationRevision = Number(match[1]);
  const value = Number(match[2]);
  return Number.isSafeInteger(expectedObservationRevision) && Number.isFinite(value)
    ? { value, expectedObservationRevision } : null;
}

function alexaHeader(directive: AlexaDirective, namespace: string, name: string) {
  return { namespace, name, messageId: crypto.randomUUID(), ...(directive.header.correlationToken ? { correlationToken: directive.header.correlationToken } : {}), payloadVersion: '3' };
}

function alexaError(directive: AlexaDirective, type: string, message: string) {
  return { event: { header: alexaHeader(directive, 'Alexa', 'ErrorResponse'), endpoint: { endpointId: directive.endpoint.endpointId }, payload: { type, message } } };
}

function alexaResponse(directive: AlexaDirective, properties: Array<{ namespace: string; name: string; value: unknown; timeOfSample: string; uncertaintyInMilliseconds: number }> = []) {
  return {
    event: { header: alexaHeader(directive, 'Alexa', 'Response'), endpoint: { scope: { type: 'BearerToken', token: directive.endpoint.scope.token }, endpointId: directive.endpoint.endpointId }, payload: {} },
    ...(properties.length ? { context: { properties } } : {}),
  };
}

function alexaStateReport(directive: AlexaDirective, properties: AlexaProperty[]) {
  return {
    event: { header: alexaHeader(directive, 'Alexa', 'StateReport'), endpoint: { endpointId: directive.endpoint.endpointId }, payload: {} },
    context: { properties },
  };
}

function alexaErrorFor(error: unknown, directive: AlexaDirective) {
  if (error instanceof Stage1AuthError) {
    if (error.status === 401) return alexaError(directive, 'INVALID_AUTHORIZATION_CREDENTIAL', 'Authorization is no longer valid. Relink Dinodia in the Alexa app.');
    if (error.status === 404) return alexaError(directive, 'NO_SUCH_ENDPOINT', 'This Dinodia endpoint is no longer available. Discover devices again.');
    if (error.status === 400) return alexaError(directive, 'INVALID_DIRECTIVE', 'This request is not supported by the current Dinodia device controls.');
    if (error.status === 409 && error.code === 'alexa_directive_replay_conflict') return alexaError(directive, 'INVALID_DIRECTIVE', 'This Alexa message identifier was already used for a different control request.');
  }
  return alexaError(directive, 'ENDPOINT_UNREACHABLE', 'Dinodia could not confirm this request. Retry safely or check the Dinodia app.');
}

export function alexaPropertiesFromStates(endpoint: AuthorizedEndpoint, controls: JsonObject[], states: unknown[], now = Date.now()): AlexaProperty[] {
  const byId = new Map<string, JsonObject>();
  for (const stateValue of states) {
    const state = record(stateValue);
    if (state && typeof state.controlId === 'string') byId.set(state.controlId, state);
  }
  const result: AlexaProperty[] = [];
  const rangeInstances = rangeControllerInstances(controls);
  const stateRows = [...byId.values()];
  const onlineEvidence = stateRows.find((state) => state.deviceAvailability === 'online' && typeof state.observedAt === 'string');
  const offlineEvidence = stateRows.find((state) => state.deviceAvailability === 'offline' && typeof state.observedAt === 'string');
  const connectivityEvidence = onlineEvidence ?? offlineEvidence;
  if (connectivityEvidence && typeof connectivityEvidence.observedAt === 'string') {
    const observedAt = Date.parse(connectivityEvidence.observedAt);
    if (Number.isFinite(observedAt) && observedAt <= now) result.push({
      namespace: 'Alexa.EndpointHealth', name: 'connectivity',
      value: { value: connectivityEvidence.deviceAvailability === 'online' ? 'OK' : 'UNREACHABLE' },
      timeOfSample: new Date(observedAt).toISOString(),
      uncertaintyInMilliseconds: Math.max(0, Math.min(60_000, Math.round(now - observedAt))),
    });
  }
  for (const control of controls) {
    const state = byId.get(String(control.controlId));
    if (!state || state.deviceId !== endpoint.osDeviceId || state.descriptorRevision !== endpoint.descriptorRevision
      || state.quality !== 'fresh' || typeof state.observedAt !== 'string' || typeof state.validUntil !== 'string'
      || !Number.isFinite(Date.parse(state.validUntil)) || Date.parse(state.validUntil) <= now
      || !Number.isFinite(Date.parse(state.observedAt)) || Date.parse(state.observedAt) > now) continue;
    const role = control.semanticRole;
    let namespace = '';
    let name = '';
    let value: unknown = state.value;
    if (role === 'power' && typeof value === 'boolean') { namespace = 'Alexa.PowerController'; name = 'powerState'; value = value ? 'ON' : 'OFF'; }
    else if (role === 'brightness' && typeof value === 'number' && value >= 0 && value <= 100) { namespace = 'Alexa.BrightnessController'; name = 'brightness'; }
    else if (role === 'target_temperature' && typeof value === 'number') { namespace = 'Alexa.ThermostatController'; name = 'targetSetpoint'; value = { value, scale: 'CELSIUS' }; }
    else if (role === 'ambient_temperature' && typeof value === 'number') { namespace = 'Alexa.TemperatureSensor'; name = 'temperature'; value = { value, scale: 'CELSIUS' }; }
    else if (RANGE_ROLES.has(String(role)) && typeof value === 'number') {
      const bounds = record(control.constraints);
      const instance = rangeInstances.get(String(control.controlId));
      if (!bounds || !instance || value < Number(bounds.minimum) || value > Number(bounds.maximum)) continue;
      const steps = (value - Number(bounds.minimum)) / Number(bounds.step);
      if (Math.abs(steps - Math.round(steps)) > 1e-7) continue;
      namespace = 'Alexa.RangeController'; name = 'rangeValue';
    }
    if (!namespace || !READABLE.has(String(role))) continue;
    const observedAt = Date.parse(state.observedAt);
    if (!Number.isFinite(observedAt)) continue;
    result.push({ namespace, name, value, timeOfSample: new Date(observedAt).toISOString(), uncertaintyInMilliseconds: Math.max(0, Math.min(60_000, Math.round(now - observedAt))),
      ...(namespace === 'Alexa.RangeController' ? { instance: rangeInstances.get(String(control.controlId)) } : {}) });
  }
  return result;
}

export async function executeNativeAlexaDirective(input: unknown): Promise<object> {
  const directive = parseDirective(input);
  if (directive.header.namespace === 'Alexa' && directive.header.name === 'ReportState') return reportNativeAlexaState(directive);
  const token = bearerFromDirective(directive);
  const endpoint = await lockAndAuthorizeEndpoint(sha256(token), directive.endpoint.endpointId);
  const operation = commandValue(directive, endpoint.controls);
  const requestId = directiveRequestId(endpoint.linkId, directive.header.messageId);
  const digest = requestDigest(directive);
  const commandId = `alexa-${sha256(`${endpoint.linkId}\n${directive.header.messageId}`)}`;
  const idempotencyKey = `alexa-${sha256(`${endpoint.linkId}\n${directive.header.messageId}`)}`;
  let resolvedAdjustment: { value: number; expectedObservationRevision: number } | null = null;
  if (operation.adjustmentDelta !== undefined) {
    const prior = await prisma.alexaNativeDirectiveReceipt.findUnique({ where: { requestId }, select: {
      linkId: true, requestDigest: true, responseStatus: true, responseDigest: true, expiresAt: true,
    } });
    if (prior && (prior.linkId !== endpoint.linkId || prior.requestDigest !== digest || prior.expiresAt <= new Date())) {
      throw new Stage1AuthError(409, 'alexa_directive_replay_conflict', 'The Alexa request identifier was already used');
    }
    if (prior?.responseStatus === 200) return alexaResponse(directive);
    resolvedAdjustment = prior
      ? parseAdjustmentReceiptMarker(prior.responseDigest)
      : resolveAdjustment(operation.control, await currentAlexaControlState(endpoint, operation.control), operation.adjustmentDelta, Date.now());
    if (!resolvedAdjustment) throw new Stage1AuthError(503, 'alexa_receipt_invalid', 'The reserved Alexa adjustment cannot be reconciled safely');
  }
  const receipt = await serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${endpoint.linkId}::uuid FOR UPDATE`;
    const existing = await tx.alexaNativeDirectiveReceipt.findUnique({ where: { requestId }, select: { id: true, linkId: true, requestDigest: true, commandId: true, responseStatus: true, responseDigest: true, expiresAt: true } });
    if (existing) {
      if (existing.linkId !== endpoint.linkId || existing.requestDigest !== digest || existing.expiresAt <= new Date()) {
        throw new Stage1AuthError(409, 'alexa_directive_replay_conflict', 'The Alexa request identifier was already used');
      }
      return existing;
    }
    return tx.alexaNativeDirectiveReceipt.create({ data: {
      linkId: endpoint.linkId, requestId, requestDigest: digest, commandId, eventTokenHash: sha256(token),
      responseStatus: 202, ...(resolvedAdjustment ? { responseDigest: adjustmentReceiptMarker(resolvedAdjustment.value, resolvedAdjustment.expectedObservationRevision) } : {}),
      expiresAt: new Date(Date.now() + RECEIPT_TTL_MS),
    }, select: { id: true, linkId: true, requestDigest: true, commandId: true, responseStatus: true, responseDigest: true, expiresAt: true } });
  }, 3, { timeoutMs: 5000 });
  if (!receipt.commandId) throw new Stage1AuthError(503, 'alexa_receipt_invalid', 'The Alexa command receipt is unavailable');
  if (receipt.responseStatus === 200) return alexaResponse(directive);

  if (operation.adjustmentDelta !== undefined) {
    resolvedAdjustment = parseAdjustmentReceiptMarker(receipt.responseDigest);
    if (!resolvedAdjustment) throw new Stage1AuthError(503, 'alexa_receipt_invalid', 'The reserved Alexa adjustment cannot be reconciled safely');
    operation.value = resolvedAdjustment.value;
    operation.propertyValue = operation.propertyName === 'targetSetpoint' ? { value: operation.value, scale: 'CELSIUS' } : operation.value;
    operation.expectedObservationRevision = resolvedAdjustment.expectedObservationRevision;
  }

  const now = tokenTime();
  const commandToken = signNativeAlexaCommandToken({ accountId: endpoint.accountId, linkId: endpoint.linkId,
    endpointId: endpoint.endpointId, homeId: endpoint.homeId, membershipId: endpoint.membershipId,
    hubInstallationId: endpoint.hubId, areaId: endpoint.areaId, deviceId: endpoint.osDeviceId,
    controlId: String(operation.control.controlId), descriptorRevision: endpoint.descriptorRevision,
    commandId: receipt.commandId, idempotencyKey, valueDigest: sha256(JSON.stringify(operation.value)),
    ...(operation.expectedObservationRevision !== undefined ? { expectedObservationRevision: operation.expectedObservationRevision } : {}),
    policyRevision: Math.max(endpoint.accessRevision, endpoint.hubPolicyRevision), issuedAt: now.issuedAt, expiresAt: now.expiresAt,
  }, platformPrivateKey());
  try {
    const origin = cloudOrigin(endpoint);
    const result = await callHub(origin, '/api/dinodia/v1/alexa/commands', commandToken, {
      commandId: receipt.commandId, homeId: endpoint.homeId, homeMembershipId: endpoint.membershipId,
      deviceId: endpoint.osDeviceId, controlId: String(operation.control.controlId),
      descriptorRevision: endpoint.descriptorRevision, value: operation.value,
      ...(operation.expectedObservationRevision !== undefined ? { expectedObservationRevision: operation.expectedObservationRevision } : {}),
      issuedAt: new Date().toISOString(), idempotencyKey,
    }, idempotencyKey);
    const status = typeof result.status === 'string' ? result.status : '';
    if (!['accepted', 'applied', 'succeeded'].includes(status)) {
      throw new Stage1AuthError(503, 'alexa_command_not_acknowledged', 'Dinodia OS has not confirmed the requested Alexa operation');
    }
    let adjustmentProperties: AlexaProperty[] = [];
    if (resolvedAdjustment) {
      const resultingState = await currentAlexaControlState(endpoint, operation.control);
      if (resultingState.quality !== 'fresh' || resultingState.value !== resolvedAdjustment.value
        || !Number.isSafeInteger(resultingState.revision) || Number(resultingState.revision) <= resolvedAdjustment.expectedObservationRevision) {
        throw new Stage1AuthError(503, 'alexa_command_not_acknowledged', 'Dinodia OS has not confirmed the resulting device state');
      }
      adjustmentProperties = alexaPropertiesFromStates(endpoint, [operation.control], [resultingState]);
      const matchingProperty = adjustmentProperties.filter((property) => property.namespace === operation.alexaNamespace
        && property.name === operation.propertyName
        && (operation.alexaNamespace !== 'Alexa.RangeController' || property.instance === directive.header.instance));
      if (matchingProperty.length !== 1 || JSON.stringify(matchingProperty[0].value) !== JSON.stringify(operation.propertyValue)) {
        throw new Stage1AuthError(503, 'alexa_command_not_acknowledged', 'Dinodia OS has not returned the requested current state');
      }
    }
    await prisma.alexaNativeDirectiveReceipt.update({ where: { id: receipt.id }, data: { responseStatus: 200, responseDigest: sha256(`${receipt.commandId}\n${status}`) } });
    return alexaResponse(directive, adjustmentProperties);
  } catch (error) {
    // Keep the reserved command ID and receipt. A retry of this exact Alexa
    // message reuses the same OS idempotency key; it can reconcile an uncertain
    // response but can never create a second logical operation.
    await prisma.alexaNativeDirectiveReceipt.update({ where: { id: receipt.id }, data: { responseStatus: 202 } }).catch(() => {});
    return alexaErrorFor(error, directive);
  }
}

async function reportNativeAlexaState(directive: AlexaDirective): Promise<object> {
  const token = bearerFromDirective(directive);
  const endpoint = await lockAndAuthorizeEndpoint(sha256(token), directive.endpoint.endpointId);
  const controls = endpoint.controls.filter((control) => READABLE.has(String(control.semanticRole))
    && control.readable === true && control.observable === true
    && control.stepUpPolicy !== 'required');
  if (!controls.length) throw new Stage1AuthError(404, 'alexa_state_unavailable', 'No current Alexa-readable state is available for this endpoint');
  const controlIds = controls.map((control) => String(control.controlId));
  if (controlIds.length > 32) throw new Stage1AuthError(503, 'alexa_descriptor_invalid', 'The current device descriptor is too large for Alexa state reporting');
  const now = tokenTime();
  const stateToken = signNativeAlexaStateToken({ accountId: endpoint.accountId, linkId: endpoint.linkId,
    endpointId: endpoint.endpointId, homeId: endpoint.homeId, membershipId: endpoint.membershipId,
    hubInstallationId: endpoint.hubId, areaId: endpoint.areaId, deviceId: endpoint.osDeviceId,
    controlIds, descriptorRevision: endpoint.descriptorRevision,
    policyRevision: Math.max(endpoint.accessRevision, endpoint.hubPolicyRevision), issuedAt: now.issuedAt, expiresAt: now.expiresAt,
  }, platformPrivateKey());
  const result = await callHub(cloudOrigin(endpoint), '/api/dinodia/v1/alexa/state', stateToken, { deviceId: endpoint.osDeviceId, controlIds });
  if (result.schemaVersion !== 'dinodia.v1' || result.endpointId !== endpoint.endpointId || result.homeId !== endpoint.homeId
    || result.membershipId !== endpoint.membershipId || result.deviceId !== endpoint.osDeviceId
    || result.descriptorRevision !== endpoint.descriptorRevision || !Array.isArray(result.states)) {
    throw new Stage1AuthError(503, 'alexa_hub_response_invalid', 'Dinodia OS returned an invalid state response');
  }
  const properties = alexaPropertiesFromStates(endpoint, controls, result.states);
  if (!properties.some((property) => property.name !== 'connectivity')) {
    return alexaError(directive, 'ENDPOINT_UNREACHABLE', 'The current device state is unknown or out of date. Try again when the device is available.');
  }
  return alexaStateReport(directive, properties);
}

export async function handleNativeAlexaDirective(request: Request): Promise<object> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new Stage1AuthError(413, 'alexa_directive_invalid', 'The Alexa request is too large');
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Stage1AuthError(413, 'alexa_directive_invalid', 'The Alexa request is too large');
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Stage1AuthError(400, 'alexa_directive_invalid', 'The Alexa request is invalid'); }
  const directive = parseDirective(input);
  if (directive.header.namespace === 'Alexa' && directive.header.name === 'ReportState') {
    return alexaError(directive, 'INVALID_DIRECTIVE', 'Use the Native Alexa ReportState endpoint for state requests.');
  }
  try { return await executeNativeAlexaDirective({ directive }); }
  catch (error) { return alexaErrorFor(error, directive); }
}

export async function handleNativeAlexaReportState(request: Request): Promise<object> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new Stage1AuthError(413, 'alexa_directive_invalid', 'The Alexa request is too large');
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Stage1AuthError(413, 'alexa_directive_invalid', 'The Alexa request is too large');
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Stage1AuthError(400, 'alexa_directive_invalid', 'The Alexa request is invalid'); }
  const directive = parseDirective(input);
  if (directive.header.namespace !== 'Alexa' || directive.header.name !== 'ReportState') {
    return alexaError(directive, 'INVALID_DIRECTIVE', 'This endpoint accepts Alexa ReportState requests only.');
  }
  try { return await reportNativeAlexaState(directive); }
  catch (error) { return alexaErrorFor(error, directive); }
}
