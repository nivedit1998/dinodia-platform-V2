/** Canonical Native V2 wire contract. Versioned DTOs are transport types, never authority. */
export const DINODIA_V1 = 'dinodia.v1' as const;
export type OpaqueId = string;
export type MembershipRole = 'OWNER' | 'PROPERTY_MANAGER' | 'TENANT';
export type ManagementClass = 'property_device' | 'tenant_device';
export type ValueType = 'boolean' | 'number' | 'option' | 'text' | 'invoke';
export type InteractionKind = string; // Unknown kinds are safe read-only descriptors, never command authority.
export type StateQuality = 'fresh' | 'stale' | 'unknown' | 'unavailable';
export type HubOnlineState = 'online' | 'offline' | 'unknown';
export type UIState = 'restoring_session' | 'loading' | 'ready' | 'empty' | 'stale' | 'offline' | 'denied' | 'expired' | 'uncertain' | 'maintenance' | 'error';

export interface MembershipContext { accountId: OpaqueId; homeId: OpaqueId; homeMembershipId: OpaqueId; role: MembershipRole; status: 'active'|'suspended'|'removed'; areaIds: OpaqueId[]; revision: number }
export interface AccountSessionContext { schemaVersion: typeof DINODIA_V1; accountId: OpaqueId; memberships: MembershipContext[]; expiresAt: string }
export interface CustomerSessionLoginRequest { email: string; password: string; deviceInstallationId: OpaqueId; publicKey: string; deviceName: string; model?: string; osFamily?: string; osVersion?: string }
export interface CustomerSessionReceipt { ok: true; accountId: OpaqueId; sessionId: OpaqueId; trustedDeviceId: OpaqueId; expiresAt: string }
export interface CustomerSessionLogoutReceipt { ok: true }
export type CustomerHubEndpoint = { state: 'verified_cloud'; origin: string } | { state: 'unavailable' };
export interface CustomerHubSession { ok: true; token: string; expiresAt: string; homeId: OpaqueId; membershipId: OpaqueId; hubEndpoint: CustomerHubEndpoint }
export interface OfflineHomeCandidate { schemaVersion: typeof DINODIA_V1; grantId: OpaqueId; accountId: OpaqueId; homeId: OpaqueId; homeMembershipId: OpaqueId; trustedDeviceId: OpaqueId; role: 'TENANT'; areaIds: OpaqueId[]; membershipRevision: number; issuedAt: string; expiresAt: string|null }
export interface OfflineHomeSelection { schemaVersion: typeof DINODIA_V1; accountId: OpaqueId; generatedAt: string; state: 'offline'; candidates: OfflineHomeCandidate[] }
export interface NativeControl { schemaVersion: 1; deviceId: OpaqueId; surfaceId?: OpaqueId|null; controlId: OpaqueId; label: string; group?: string|null; sortOrder: number; valueType: ValueType; interactionKind: InteractionKind; semanticRole: string; readable: boolean; writable: boolean; automatable: boolean; observable: boolean; idempotency: 'set_value'|'invoke_once'|'none'; confirmationPolicy: 'none'|'matching_observation'|'explicit_user'|'step_up'; riskLevel: 'low'|'normal'|'sensitive'|'critical'; stepUpPolicy: 'none'|'required'; catalogRevision: number; expectedReportingIntervalSeconds?: number; maxStateValiditySeconds?: number; constraints?: Record<string, unknown>; unsupportedReason?: string|null }
export interface NativeDevice { id: OpaqueId; homeId: OpaqueId; managementClass: ManagementClass; ownerMembershipId: OpaqueId|null; lifecycle: 'commissioning'|'installed'|'view_only'|'retired'; technicalLabel: string; customerLabel: string|null; areaIds: OpaqueId[]; controls: NativeControl[]; descriptorRevision: number }
export interface NativeControlState { deviceId: OpaqueId; controlId: OpaqueId; homeId: OpaqueId; descriptorRevision: number; revision: number; observedAt: string; receivedAt: string; validUntil: string; quality: StateQuality; value: unknown; deviceAvailability: 'online'|'offline'|'unknown'; analyticsActivity: 'on'|'off'|'unknown' }
export interface NativeEnvelope<T> { schemaVersion: typeof DINODIA_V1; homeId: OpaqueId; streamId: OpaqueId; sequence: number; generatedAt: string; revision: number; data: T }
export interface NativeCommand { commandId: OpaqueId; homeId: OpaqueId; homeMembershipId: OpaqueId; deviceId: OpaqueId; controlId: OpaqueId; descriptorRevision: number; value: unknown; issuedAt: string; idempotencyKey: string; stepUpOperationId?: string|null }
export interface NativeError { error: { code: string; message: string; requestId: OpaqueId; retryable?: boolean } }
export interface NativeArea { id: OpaqueId; homeId: OpaqueId; originalName: string; overrideName?: string|null; revision: number; lifecycle: 'active'|'retired' }
export interface LanEndpointObservation { version: 1; revision: number; state: 'CURRENT'|'UNAVAILABLE'; baseUrl?: string; discoveryHost: string }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const codePointLength = (value: string): number => Array.from(value).length;
/** Trim user-supplied text and enforce JSON Schema's Unicode code-point bound. */
export function boundedContractText(value: unknown, maximumCodePoints: number): string {
  if (!Number.isInteger(maximumCodePoints) || maximumCodePoints < 0) return '';
  const text = String(value ?? '').trim();
  return codePointLength(text) <= maximumCodePoints ? text : '';
}
const id = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && codePointLength(x) <= 160;
const utcTimestamp = (x: unknown): x is string => {
  if (typeof x !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(x);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(x));
};
const roles = new Set(['OWNER','PROPERTY_MANAGER','TENANT']);
const interactionKinds = new Set(['toggle','slider','thermostat','picker','text_input','momentary_action','read_only']);
const semanticRoles = new Set(['power','brightness','active_heat_demand','active_heat_production','target_temperature','ambient_temperature','opening_percentage','connectivity','security_lock','lock_state','operating_mode','position','volume','color','state','unknown']);
const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
function validConstraints(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value) || !hasOnlyKeys(value, ['minimum','maximum','step','precision','unit','options'])) return false;
  if (value.minimum !== undefined && (typeof value.minimum !== 'number' || !Number.isFinite(value.minimum))) return false;
  if (value.maximum !== undefined && (typeof value.maximum !== 'number' || !Number.isFinite(value.maximum))) return false;
  if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) return false;
  if (value.step !== undefined && !(typeof value.step === 'number' && Number.isFinite(value.step) && value.step > 0)) return false;
  if (value.precision !== undefined && !(Number.isInteger(value.precision) && Number(value.precision) >= 0 && Number(value.precision) <= 12)) return false;
  if (value.unit !== undefined && !(typeof value.unit === 'string' && codePointLength(value.unit) <= 32)) return false;
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 128 || value.options.some((option) => !object(option) || !hasOnlyKeys(option, ['value','label']) || !Object.hasOwn(option, 'value') || typeof option.label !== 'string' || codePointLength(option.label) > 80) || new Set(value.options.map((option) => JSON.stringify(option.value))).size !== value.options.length)) return false;
  return true;
}
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJsonValue(item, b[index]));
  if (!object(a) || !object(b)) return false;
  const ak = Object.keys(a).sort(); const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && sameJsonValue(a[key], b[key]));
}
/** Canonical signed hub-heartbeat endpoint DTO; not a customer-visible Home endpoint. */
export function validateLanEndpointObservation(value: unknown, serial: string, expectedPort = 8123): value is LanEndpointObservation {
  if (!object(value) || !hasOnlyKeys(value, ['version','revision','state','baseUrl','discoveryHost']) || value.version !== 1
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !id(serial)) return false;
  const host = `dinodia-${serial.toLowerCase()}.local`;
  if (value.discoveryHost !== host || !/^dinodia-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(host)) return false;
  if (value.state === 'UNAVAILABLE') return !Object.hasOwn(value, 'baseUrl');
  if (value.state !== 'CURRENT' || typeof value.baseUrl !== 'string') return false;
  const match = value.baseUrl.match(/^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  if (!match || match[2] !== String(expectedPort)) return false;
  const octets = match[1].split('.').map(Number);
  if (octets.length !== 4 || octets.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== match[1].split('.')[index])) return false;
  const [a, b, , last] = octets;
  if (last === 0 || last === 255 || a === 172 && (b === 17 || b === 18)) return false;
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}
const deviceKeys = ['id','homeId','managementClass','ownerMembershipId','lifecycle','technicalLabel','customerLabel','areaIds','controls','descriptorRevision'];
const controlKeys = ['schemaVersion','deviceId','surfaceId','controlId','label','group','sortOrder','valueType','interactionKind','semanticRole','readable','writable','automatable','observable','idempotency','confirmationPolicy','riskLevel','stepUpPolicy','constraints','expectedReportingIntervalSeconds','maxStateValiditySeconds','unsupportedReason','catalogRevision'];

/** Rejects wrong-home, unsupported-version, tenant-private leakage and stale descriptor writes. */
export function validateNativeDevice(value: unknown, context?: { homeId?: string; homeMembershipId?: string; role?: MembershipRole; areaIds?: string[] }): value is NativeDevice {
  if (!object(value) || !hasOnlyKeys(value, deviceKeys) || !id(value.id) || !id(value.homeId) || (context?.homeId && value.homeId !== context.homeId)) return false;
  if (value.managementClass !== 'property_device' && value.managementClass !== 'tenant_device') return false;
  if (value.managementClass === 'tenant_device' && (!id(value.ownerMembershipId) || context?.role !== undefined && context.role !== 'TENANT' || (context?.homeMembershipId && value.ownerMembershipId !== context.homeMembershipId))) return false;
  if (value.managementClass === 'property_device' && value.ownerMembershipId != null) return false;
  if (!['commissioning','installed','view_only','retired'].includes(String(value.lifecycle)) || !id(value.technicalLabel) || codePointLength(value.technicalLabel) > 80 || !(value.customerLabel == null || typeof value.customerLabel === 'string' && codePointLength(value.customerLabel) <= 40)) return false;
  if (!Array.isArray(value.controls) || value.controls.length > 64 || !Number.isInteger(value.descriptorRevision) || Number(value.descriptorRevision) < 0 || !Array.isArray(value.areaIds) || value.areaIds.length < 1 || !value.areaIds.every(id) || new Set(value.areaIds).size !== value.areaIds.length || context?.areaIds && value.areaIds.some((area) => !context.areaIds?.includes(area))) return false;
  const controlIds = new Set<string>();
  return value.controls.every((c) => {
    if (!object(c) || !hasOnlyKeys(c, controlKeys) || c.schemaVersion !== 1 || c.deviceId !== value.id || !id(c.controlId) || controlIds.has(String(c.controlId)) || !(c.surfaceId == null || id(c.surfaceId)) || !(c.unsupportedReason == null || typeof c.unsupportedReason === 'string' && codePointLength(c.unsupportedReason) <= 120) || !validConstraints(c.constraints) || !semanticRoles.has(String(c.semanticRole)) || !['boolean','number','option','text','invoke'].includes(String(c.valueType)) || typeof c.interactionKind !== 'string' || !c.interactionKind || codePointLength(c.interactionKind) > 64 || !['set_value','invoke_once','none'].includes(String(c.idempotency)) || !['none','matching_observation','explicit_user','step_up'].includes(String(c.confirmationPolicy)) || !['low','normal','sensitive','critical'].includes(String(c.riskLevel)) || !['none','required'].includes(String(c.stepUpPolicy)) || typeof c.label !== 'string' || !c.label.trim() || codePointLength(c.label) > 80 || !(c.group == null || typeof c.group === 'string' && codePointLength(c.group) <= 80) || typeof c.writable !== 'boolean' || typeof c.readable !== 'boolean' || (c.writable && !c.readable) || typeof c.automatable !== 'boolean' || typeof c.observable !== 'boolean' || !Number.isInteger(c.catalogRevision) || c.catalogRevision !== value.descriptorRevision || typeof c.sortOrder !== 'number' || !Number.isInteger(c.sortOrder) || c.sortOrder < 0) return false;
    if (!interactionKinds.has(c.interactionKind) && (c.writable || c.automatable || c.idempotency !== 'none' || c.confirmationPolicy !== 'none' || c.stepUpPolicy !== 'none')) return false;
    const constraints = object(c.constraints) ? c.constraints : {};
    if (c.valueType === 'option' && c.writable && (!Array.isArray(constraints.options) || constraints.options.length === 0)) return false;
    if (c.observable && (!(Number.isInteger(c.expectedReportingIntervalSeconds) && Number(c.expectedReportingIntervalSeconds) > 0) || !(Number.isInteger(c.maxStateValiditySeconds) && Number(c.maxStateValiditySeconds) > 0))) return false;
    if (c.stepUpPolicy === 'required' && c.automatable) return false;
    if (['security_lock','lock_state'].includes(String(c.semanticRole)) && (c.stepUpPolicy !== 'required' || c.automatable)) return false;
    controlIds.add(String(c.controlId)); return true;
  });
}
export function validateMembership(value: unknown): value is MembershipContext {
  return object(value) && hasOnlyKeys(value, ['accountId','homeId','homeMembershipId','role','status','areaIds','revision']) && id(value.accountId) && id(value.homeId) && id(value.homeMembershipId) && roles.has(String(value.role)) && value.status === 'active' && Array.isArray(value.areaIds) && value.areaIds.every(id) && new Set(value.areaIds).size === value.areaIds.length && Number.isInteger(value.revision) && Number(value.revision) >= 0;
}
export function validateAccountSessionContext(value: unknown, now = Date.now()): value is AccountSessionContext {
  if (!object(value) || !hasOnlyKeys(value, ['schemaVersion','accountId','memberships','expiresAt']) || value.schemaVersion !== DINODIA_V1 || !id(value.accountId) || !utcTimestamp(value.expiresAt) || Date.parse(value.expiresAt) <= now || !Array.isArray(value.memberships)) return false;
  const homes = new Set<string>(); const membershipIds = new Set<string>();
  for (const membership of value.memberships) {
    if (!validateMembership(membership) || membership.accountId !== value.accountId || membership.status !== 'active' || homes.has(membership.homeId) || membershipIds.has(membership.homeMembershipId)) return false;
    homes.add(membership.homeId); membershipIds.add(membership.homeMembershipId);
  }
  return true;
}
export function validateCustomerSessionLoginRequest(value: unknown): value is CustomerSessionLoginRequest {
  if (!object(value) || !hasOnlyKeys(value, ['email','password','deviceInstallationId','publicKey','deviceName','model','osFamily','osVersion'])) return false;
  const email = value.email;
  return typeof email === 'string' && codePointLength(email) >= 3 && codePointLength(email) <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    typeof value.password === 'string' && codePointLength(value.password) > 0 && codePointLength(value.password) <= 1024 &&
    id(value.deviceInstallationId) && typeof value.publicKey === 'string' && codePointLength(value.publicKey) > 0 && codePointLength(value.publicKey) <= 4096 &&
    typeof value.deviceName === 'string' && value.deviceName.trim().length > 0 && codePointLength(value.deviceName) <= 160 &&
    (value.model === undefined || typeof value.model === 'string' && codePointLength(value.model) <= 160) &&
    (value.osFamily === undefined || typeof value.osFamily === 'string' && codePointLength(value.osFamily) <= 80) &&
    (value.osVersion === undefined || typeof value.osVersion === 'string' && codePointLength(value.osVersion) <= 80);
}
/** Login receipt is metadata only: the reusable session secret remains in the HttpOnly cookie. */
export function validateCustomerSessionReceipt(value: unknown, now = Date.now()): value is CustomerSessionReceipt {
  if (!object(value) || !hasOnlyKeys(value, ['ok','accountId','sessionId','trustedDeviceId','expiresAt']) || value.ok !== true || !id(value.accountId) || !id(value.sessionId) || !id(value.trustedDeviceId) || !utcTimestamp(value.expiresAt)) return false;
  const expiresAt = Date.parse(value.expiresAt);
  return expiresAt > now && expiresAt <= now + 30 * 24 * 60 * 60 * 1000 + 1000;
}
export function validateCustomerSessionLogoutReceipt(value: unknown): value is CustomerSessionLogoutReceipt {
  return object(value) && hasOnlyKeys(value, ['ok']) && value.ok === true;
}
/** The short-lived hub bearer is accepted only for its exact selected membership and home. */
export function validateCustomerHubSession(value: unknown, expected: { homeId: string; membershipId: string }, now = Date.now()): value is CustomerHubSession {
  if (!object(value) || !hasOnlyKeys(value, ['ok','token','expiresAt','homeId','membershipId','hubEndpoint']) || value.ok !== true || typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 8192 || value.token === 'TEST_ONLY_PLACEHOLDER_NOT_A_BEARER' || !utcTimestamp(value.expiresAt) || !id(expected.homeId) || !id(expected.membershipId) || value.homeId !== expected.homeId || value.membershipId !== expected.membershipId) return false;
  const endpoint = value.hubEndpoint;
  if (!object(endpoint)) return false;
  if (endpoint.state === 'unavailable') {
    if (!hasOnlyKeys(endpoint, ['state'])) return false;
  } else if (endpoint.state === 'verified_cloud') {
    if (!hasOnlyKeys(endpoint, ['state','origin']) || typeof endpoint.origin !== 'string') return false;
    let parsed: URL;
    try { parsed = new URL(endpoint.origin); } catch { return false; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' && parsed.pathname !== '' || parsed.search || parsed.hash || parsed.origin !== endpoint.origin || !/^dinodia-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.dinodiasmartliving\.com$/.test(parsed.hostname)) return false;
  } else return false;
  const expiresAt = Date.parse(value.expiresAt);
  return expiresAt > now && expiresAt <= now + 5 * 60 * 1000 + 1000;
}
const stepUpOperations = new Set(['trusted_device_remove','support_ticket_close','support_access_approve','support_access_revoke','alexa_unlink','heating_sensitive_command','device_sensitive_command']);
function validStepUpDescriptor(value: unknown): boolean {
  const keys = ['version','serial','identityGeneration','actorId','customerSessionId','trustedDeviceId','homeId','membershipId','hubInstallId','operationKind','targetIds','controlId','descriptorRevision','descriptorDigest','operationDigest','nonce','issuedAt','hubSignature'];
  return object(value) && Object.keys(value).length === keys.length && hasOnlyKeys(value, keys) && value.version === 1 && id(value.serial) && Number.isInteger(value.identityGeneration) && Number(value.identityGeneration) > 0 && id(value.actorId) && id(value.customerSessionId) && id(value.trustedDeviceId) && id(value.homeId) && id(value.membershipId) && id(value.hubInstallId) && stepUpOperations.has(String(value.operationKind)) && Array.isArray(value.targetIds) && value.targetIds.length > 0 && value.targetIds.length <= 20 && value.targetIds.every(id) && new Set(value.targetIds).size === value.targetIds.length && id(value.controlId) && Number.isInteger(value.descriptorRevision) && Number(value.descriptorRevision) >= 0 && (value.descriptorDigest === null || typeof value.descriptorDigest === 'string' && /^[0-9a-f]{64}$/.test(value.descriptorDigest)) && typeof value.operationDigest === 'string' && /^[0-9a-f]{64}$/.test(value.operationDigest) && typeof value.nonce === 'string' && codePointLength(value.nonce) >= 20 && codePointLength(value.nonce) <= 128 && /^[A-Za-z0-9_-]+$/.test(value.nonce) && Number.isSafeInteger(value.issuedAt) && Number(value.issuedAt) > 0 && typeof value.hubSignature === 'string' && codePointLength(value.hubSignature) >= 32 && codePointLength(value.hubSignature) <= 2048 && /^[A-Za-z0-9_-]+$/.test(value.hubSignature);
}
export function validateStepUpChallengeRequest(value: unknown): boolean {
  if (!object(value) || !hasOnlyKeys(value, ['operationKind','targetIds','value','descriptorAttestation']) || !stepUpOperations.has(String(value.operationKind)) || !Array.isArray(value.targetIds) || value.targetIds.length < 1 || value.targetIds.length > 20 || !value.targetIds.every(id) || new Set(value.targetIds).size !== value.targetIds.length) return false;
  const attestation = value.descriptorAttestation;
  if (attestation === undefined) return true;
  if (!validStepUpDescriptor(attestation)) return false;
  const checkedAttestation = attestation as Record<string, unknown>;
  return checkedAttestation.operationKind === value.operationKind && sameJsonValue(checkedAttestation.targetIds, value.targetIds);
}
export function validateStepUpCancellationRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['challengeId']) && id(value.challengeId);
}
export function validateStepUpIssueRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['challengeId','nonce','deviceSignature']) && id(value.challengeId) && typeof value.nonce === 'string' && codePointLength(value.nonce) >= 20 && codePointLength(value.nonce) <= 128 && /^[A-Za-z0-9_-]+$/.test(value.nonce) && typeof value.deviceSignature === 'string' && codePointLength(value.deviceSignature) >= 32 && codePointLength(value.deviceSignature) <= 2048 && /^[A-Za-z0-9_-]+$/.test(value.deviceSignature);
}
export function validateStepUpConsumeRequest(value: unknown): boolean {
  if (!object(value) || !hasOnlyKeys(value, ['operationKind','targetIds','proof','value','descriptorDigests']) || !stepUpOperations.has(String(value.operationKind)) || !Array.isArray(value.targetIds) || value.targetIds.length < 1 || value.targetIds.length > 20 || !value.targetIds.every(id) || new Set(value.targetIds).size !== value.targetIds.length) return false;
  if (value.proof !== undefined && (typeof value.proof !== 'string' || !value.proof || codePointLength(value.proof) > 8192)) return false;
  if (value.descriptorDigests !== undefined && (!object(value.descriptorDigests) || Object.keys(value.descriptorDigests).length > 20 || Object.entries(value.descriptorDigests).some(([deviceId, digest]) => !id(deviceId) || !(digest === null || typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))))) return false;
  return true;
}
export function validateStepUpChallengeReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','challengeId','nonce','operationDigest','expiresAt']) && value.ok === true && id(value.challengeId) && typeof value.nonce === 'string' && codePointLength(value.nonce) >= 20 && codePointLength(value.nonce) <= 128 && /^[A-Za-z0-9_-]+$/.test(value.nonce) && typeof value.operationDigest === 'string' && /^[0-9a-f]{64}$/.test(value.operationDigest) && utcTimestamp(value.expiresAt);
}
export function validateStepUpProofReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','proof','proofId','operationId','expiresAt']) && value.ok === true && typeof value.proof === 'string' && codePointLength(value.proof) > 0 && codePointLength(value.proof) <= 8192 && id(value.proofId) && id(value.operationId) && utcTimestamp(value.expiresAt);
}
export function validateStepUpCancellationReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','cancelled']) && value.ok === true && value.cancelled === true;
}
export function validateStepUpConsumeReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok']) && value.ok === true;
}
export function validateOfflineAuthorisationRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['trustedDeviceId','publicKey']) && id(value.trustedDeviceId) && typeof value.publicKey === 'string' && codePointLength(value.publicKey) > 0 && codePointLength(value.publicKey) <= 4096;
}
export function validateOfflineAuthorisationReceipt(value: unknown): boolean {
  if (!object(value) || !hasOnlyKeys(value, ['ok','authorisation']) || value.ok !== true || !object(value.authorisation) || !hasOnlyKeys(value.authorisation, ['id','homeId','membershipId','trustedDeviceId','areaIds','scopes','policyRevision'])) return false;
  const row = value.authorisation;
  return id(row.id) && id(row.homeId) && id(row.membershipId) && id(row.trustedDeviceId) && Array.isArray(row.areaIds) && row.areaIds.every(id) && new Set(row.areaIds).size === row.areaIds.length && sameJsonValue(row.scopes, ['tenant:device-command']) && Number.isInteger(row.policyRevision) && Number(row.policyRevision) >= 0;
}
export function validateOfflineRevocationReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','revoked']) && value.ok === true && Number.isInteger(value.revoked) && Number(value.revoked) >= 0;
}
export function validateTrustedDeviceRemovalRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['proof']) && (value.proof === undefined || typeof value.proof === 'string' && codePointLength(value.proof) > 0 && codePointLength(value.proof) <= 8192);
}
export function validateTrustedDeviceRemovalReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','trustedDeviceId','accountWide']) && value.ok === true && id(value.trustedDeviceId) && value.accountWide === true;
}
export function validateSupportNotificationProjection(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','notifications']) && value.ok === true && Array.isArray(value.notifications) && value.notifications.length <= 100 && value.notifications.every((item) => object(item) && hasOnlyKeys(item, ['id','ticketId','eventType','createdAt']) && id(item.id) && id(item.ticketId) && ['STARTED','REVOKED','ENDED','EXPIRED'].includes(String(item.eventType)) && utcTimestamp(item.createdAt));
}
const supportTicketCategories = new Set(['ACCOUNT_OR_SIGN_IN','ACCESS_OR_PERMISSIONS','DEVICE_PROBLEM','HUB_OR_CONNECTION','AUTOMATION','ALEXA','OTHER']);
export function validateSupportTicketCreateRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['category','description']) && supportTicketCategories.has(String(value.category)) && typeof value.description === 'string' && codePointLength(value.description.trim()) >= 1 && codePointLength(value.description) <= 4000;
}
export function validateSupportTicketCreateReceipt(value: unknown): boolean {
  if (!object(value) || !hasOnlyKeys(value, ['ok','ticket']) || value.ok !== true || !object(value.ticket) || !hasOnlyKeys(value.ticket, ['id','publicReference','status','createdAt'])) return false;
  const ticket = value.ticket;
  return id(ticket.id) && typeof ticket.publicReference === 'string' && codePointLength(ticket.publicReference) >= 1 && codePointLength(ticket.publicReference) <= 20 && ticket.status === 'OPEN' && utcTimestamp(ticket.createdAt);
}
export function validateSupportAccessRequestCreateRequest(value: unknown): boolean {
  if (!object(value) || !hasOnlyKeys(value, ['requestedScope','targetMembershipId','areaIds','targetIds']) || !['TENANT_SCOPE','PROPERTY_SCOPE'].includes(String(value.requestedScope)) || !(value.targetMembershipId === undefined || value.targetMembershipId === null || id(value.targetMembershipId))) return false;
  return Array.isArray(value.areaIds) && value.areaIds.length <= 100 && value.areaIds.every(id) && new Set(value.areaIds).size === value.areaIds.length && Array.isArray(value.targetIds) && value.targetIds.length <= 100 && value.targetIds.every(id) && new Set(value.targetIds).size === value.targetIds.length;
}
export function validateSupportAccessRequestCreateReceipt(value: unknown): boolean {
  if (!object(value) || !hasOnlyKeys(value, ['ok','accessRequest']) || value.ok !== true || !object(value.accessRequest) || !hasOnlyKeys(value.accessRequest, ['id','status','requestedScope','touchesPropertyInfrastructure','createdAt'])) return false;
  const accessRequest = value.accessRequest;
  return id(accessRequest.id) && accessRequest.status === 'REQUESTED' && ['TENANT_SCOPE','PROPERTY_SCOPE'].includes(String(accessRequest.requestedScope)) && typeof accessRequest.touchesPropertyInfrastructure === 'boolean' && utcTimestamp(accessRequest.createdAt);
}
export function validateSupportAccessDecisionRequest(value: unknown): boolean {
  if (!object(value) || typeof value.approve !== 'boolean') return false;
  if (value.approve === false) return hasOnlyKeys(value, ['approve']);
  return hasOnlyKeys(value, ['approve','confirmation','proof']) && (value.confirmation === undefined || typeof value.confirmation === 'string' && codePointLength(value.confirmation) <= 100) && (value.proof === undefined || typeof value.proof === 'string' && codePointLength(value.proof) > 0 && codePointLength(value.proof) <= 8192);
}
export function validateSupportAccessDecisionReceipt(value: unknown): boolean {
  if (!object(value) || value.ok !== true || !id(value.requestId)) return false;
  if (value.status === 'DENIED') return hasOnlyKeys(value, ['ok','requestId','status']);
  return value.status === 'APPROVED' && hasOnlyKeys(value, ['ok','requestId','status','oneUseCode','codeExpiresAt']) && typeof value.oneUseCode === 'string' && codePointLength(value.oneUseCode) > 0 && codePointLength(value.oneUseCode) <= 128 && utcTimestamp(value.codeExpiresAt);
}
export function validateSupportTicketCloseRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['action','proof']) && value.action === 'close' && (value.proof === undefined || typeof value.proof === 'string' && codePointLength(value.proof) > 0 && codePointLength(value.proof) <= 8192);
}
export function validateSupportTicketCloseReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','ticketId','status','message']) && value.ok === true && id(value.ticketId) && value.status === 'CLOSED' && typeof value.message === 'string' && codePointLength(value.message) <= 240;
}
export function validateOfflineHomeSelection(value: unknown, now = Date.now()): value is OfflineHomeSelection {
  if (!object(value) || !hasOnlyKeys(value, ['schemaVersion','accountId','generatedAt','state','candidates']) || value.schemaVersion !== DINODIA_V1 || !id(value.accountId) || !utcTimestamp(value.generatedAt) || Date.parse(value.generatedAt) > now || value.state !== 'offline' || !Array.isArray(value.candidates)) return false;
  const homes = new Set<string>(); const memberships = new Set<string>(); const grants = new Set<string>();
  for (const candidate of value.candidates) {
    if (!object(candidate) || !hasOnlyKeys(candidate, ['schemaVersion','grantId','accountId','homeId','homeMembershipId','trustedDeviceId','role','areaIds','membershipRevision','issuedAt','expiresAt']) || candidate.schemaVersion !== DINODIA_V1 || !id(candidate.grantId) || !id(candidate.accountId) || candidate.accountId !== value.accountId || !id(candidate.homeId) || !id(candidate.homeMembershipId) || !id(candidate.trustedDeviceId) || candidate.role !== 'TENANT' || !Array.isArray(candidate.areaIds) || candidate.areaIds.length === 0 || !candidate.areaIds.every(id) || new Set(candidate.areaIds).size !== candidate.areaIds.length || !Number.isInteger(candidate.membershipRevision) || Number(candidate.membershipRevision) < 0 || !utcTimestamp(candidate.issuedAt) || Date.parse(candidate.issuedAt) > now || !(candidate.expiresAt === null || utcTimestamp(candidate.expiresAt) && Date.parse(candidate.expiresAt) > now) || homes.has(candidate.homeId) || memberships.has(candidate.homeMembershipId) || grants.has(candidate.grantId)) return false;
    homes.add(candidate.homeId); memberships.add(candidate.homeMembershipId); grants.add(candidate.grantId);
  }
  return true;
}
export function validateNativeArea(value: unknown, expectedHomeId?: string): value is NativeArea {
  return object(value) && hasOnlyKeys(value, ['id','homeId','originalName','overrideName','revision','lifecycle']) && id(value.id) && id(value.homeId) && (!expectedHomeId || value.homeId === expectedHomeId) && typeof value.originalName === 'string' && value.originalName.trim().length > 0 && codePointLength(value.originalName) <= 80 && (value.overrideName == null || typeof value.overrideName === 'string' && value.overrideName.trim().length > 0 && codePointLength(value.overrideName) <= 80) && Number.isInteger(value.revision) && Number(value.revision) >= 0 && (value.lifecycle === 'active' || value.lifecycle === 'retired');
}
export function validateEnvelope(value: unknown, expectedHomeId?: string): value is NativeEnvelope<unknown> {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','homeId','streamId','sequence','generatedAt','revision','data']) && value.schemaVersion === DINODIA_V1 && id(value.homeId) && id(value.streamId) && (!expectedHomeId || value.homeId === expectedHomeId) && Number.isInteger(value.sequence) && Number(value.sequence) >= 0 && Number.isInteger(value.revision) && Number(value.revision) >= 0 && utcTimestamp(value.generatedAt) && Object.hasOwn(value, 'data');
}
export function effectiveControlQuality(state: NativeControlState, now = Date.now()): StateQuality {
  const validUntil = Date.parse(state.validUntil);
  if (!Number.isFinite(validUntil) || validUntil <= now) return 'unknown';
  return state.quality;
}
/** Project hub availability from the latest accepted signed heartbeat only. */
export function effectiveHubOnlineState(lastHeartbeatAt: string | null, now = Date.now()): HubOnlineState {
  if (lastHeartbeatAt === null || !Number.isFinite(now) || !utcTimestamp(lastHeartbeatAt)) return 'unknown';
  const receivedAt = Date.parse(lastHeartbeatAt);
  if (new Date(receivedAt).toISOString().slice(0, 19) !== lastHeartbeatAt.slice(0, 19)) return 'unknown';
  const ageMs = now - receivedAt;
  if (!Number.isFinite(receivedAt) || ageMs < 0) return 'unknown';
  return ageMs <= 420_000 ? 'online' : 'offline';
}
export function validateControlState(value: unknown, device: NativeDevice, control: NativeControl): value is NativeControlState {
  if (!object(value) || !hasOnlyKeys(value, ['deviceId','controlId','homeId','descriptorRevision','revision','observedAt','receivedAt','validUntil','quality','value','deviceAvailability','analyticsActivity'])) return false;
  if (typeof control.maxStateValiditySeconds !== 'number' || !Number.isInteger(control.maxStateValiditySeconds)) return false;
  const state = value as unknown as NativeControlState;
  const observedAt = Date.parse(state.observedAt); const receivedAt = Date.parse(state.receivedAt); const validUntil = Date.parse(state.validUntil);
  const valueMatches = state.value === null ? ['unknown','unavailable'].includes(state.quality) : commandValueMatches(control, state.value);
  return state.deviceId === device.id && state.controlId === control.controlId && state.homeId === device.homeId && state.descriptorRevision === device.descriptorRevision && state.descriptorRevision === control.catalogRevision && Number.isInteger(state.revision) && state.revision >= 0 && utcTimestamp(state.observedAt) && utcTimestamp(state.receivedAt) && utcTimestamp(state.validUntil) && Number.isFinite(observedAt) && Number.isFinite(receivedAt) && Number.isFinite(validUntil) && receivedAt >= observedAt && validUntil > observedAt && Number.isInteger(control.maxStateValiditySeconds) && validUntil - observedAt <= control.maxStateValiditySeconds * 1000 && ['fresh','stale','unknown','unavailable'].includes(state.quality) && valueMatches && ['online','offline','unknown'].includes(state.deviceAvailability) && ['on','off','unknown'].includes(state.analyticsActivity);
}
function commandValueMatches(control: NativeControl, value: unknown): boolean {
  if (control.valueType === 'boolean') return typeof value === 'boolean';
  if (control.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const bounds = control.constraints ?? {};
    const min = typeof bounds.minimum === 'number' ? bounds.minimum : -Infinity;
    const max = typeof bounds.maximum === 'number' ? bounds.maximum : Infinity;
    const step = typeof bounds.step === 'number' ? bounds.step : undefined;
    if (value < min || value > max) return false;
    if (step !== undefined && (!(step > 0) || Math.abs((value - (Number.isFinite(min) ? min : 0)) / step - Math.round((value - (Number.isFinite(min) ? min : 0)) / step)) > 1e-8)) return false;
    const precision = typeof bounds.precision === 'number' ? bounds.precision : undefined;
    return precision === undefined || Math.abs(value * 10 ** precision - Math.round(value * 10 ** precision)) <= 1e-8;
  }
  if (control.valueType === 'option') return Array.isArray(control.constraints?.options) && control.constraints.options.some((option) => object(option) && sameJsonValue(option.value, value));
  if (control.valueType === 'text') return typeof value === 'string' && codePointLength(value) <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  return control.valueType === 'invoke' && value === null;
}
export function validateCommandAgainstDevice(commandValue: unknown, device: NativeDevice, control: NativeControl, homeMembershipId: string): commandValue is NativeCommand {
  if (!object(commandValue) || !hasOnlyKeys(commandValue, ['commandId','homeId','homeMembershipId','deviceId','controlId','descriptorRevision','value','issuedAt','idempotencyKey','stepUpOperationId'])) return false;
  const currentControl = device.controls.find((candidate) => candidate.controlId === control.controlId && candidate.deviceId === control.deviceId);
  if (!validateNativeDevice(device) || !currentControl || !sameJsonValue(currentControl, control)) return false;
  const command = commandValue as unknown as NativeCommand;
  const requiresStepUp = control.stepUpPolicy === 'required' || control.semanticRole === 'security_lock' || control.semanticRole === 'lock_state';
  return device.lifecycle === 'installed' && interactionKinds.has(control.interactionKind) && id(command.commandId) && command.homeId === device.homeId && command.homeMembershipId === homeMembershipId && command.deviceId === device.id && command.controlId === control.controlId && Number.isInteger(command.descriptorRevision) && command.descriptorRevision >= 0 && command.descriptorRevision === device.descriptorRevision && command.descriptorRevision === control.catalogRevision && control.readable && control.writable && control.interactionKind !== 'read_only' && commandValueMatches(control, command.value) && utcTimestamp(command.issuedAt) && typeof command.idempotencyKey === 'string' && codePointLength(command.idempotencyKey) >= 16 && codePointLength(command.idempotencyKey) <= 160 && (!requiresStepUp || id(command.stepUpOperationId));
}
