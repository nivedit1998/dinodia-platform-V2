/** Canonical Native V2 wire contract. Versioned DTOs are transport types, never authority. */
export const DINODIA_V1 = 'dinodia.v1' as const;
export type OpaqueId = string;
export type MembershipRole = 'OWNER' | 'PROPERTY_MANAGER' | 'TENANT';
export type ManagementClass = 'property_device' | 'tenant_device';
export type ValueType = 'boolean' | 'number' | 'option' | 'text' | 'invoke';
export type InteractionKind = 'toggle' | 'slider' | 'thermostat' | 'picker' | 'text_input' | 'momentary_action' | 'read_only';
export type StateQuality = 'fresh' | 'stale' | 'unknown' | 'unavailable';
export type UIState = 'restoring_session' | 'loading' | 'ready' | 'empty' | 'stale' | 'offline' | 'denied' | 'expired' | 'uncertain' | 'maintenance' | 'error';

export interface MembershipContext { accountId: OpaqueId; homeId: OpaqueId; homeMembershipId: OpaqueId; role: MembershipRole; status: 'active'|'suspended'|'removed'; areaIds: OpaqueId[]; revision: number }
export interface AccountSessionContext { schemaVersion: typeof DINODIA_V1; accountId: OpaqueId; memberships: MembershipContext[]; expiresAt: string }
export interface CustomerSessionReceipt { ok: true; accountId: OpaqueId; sessionId: OpaqueId; trustedDeviceId: OpaqueId; expiresAt: string }
export interface CustomerHubSession { ok: true; token: string; expiresAt: string; homeId: OpaqueId; membershipId: OpaqueId }
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
const id = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 160;
const utcTimestamp = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(x) && Number.isFinite(Date.parse(x));
const roles = new Set(['OWNER','PROPERTY_MANAGER','TENANT']);
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
  if (value.unit !== undefined && !(typeof value.unit === 'string' && value.unit.length <= 32)) return false;
  if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length > 128 || value.options.some((option) => !object(option) || !hasOnlyKeys(option, ['value','label']) || !Object.hasOwn(option, 'value') || typeof option.label !== 'string' || option.label.length > 80) || new Set(value.options.map((option) => JSON.stringify(option.value))).size !== value.options.length)) return false;
  return true;
}
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
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
  if (!['commissioning','installed','view_only','retired'].includes(String(value.lifecycle)) || !id(value.technicalLabel) || value.technicalLabel.length > 80 || !(value.customerLabel == null || typeof value.customerLabel === 'string' && value.customerLabel.length <= 40)) return false;
  if (!Array.isArray(value.controls) || value.controls.length > 64 || !Number.isInteger(value.descriptorRevision) || Number(value.descriptorRevision) < 0 || !Array.isArray(value.areaIds) || value.areaIds.length < 1 || !value.areaIds.every(id) || new Set(value.areaIds).size !== value.areaIds.length || context?.areaIds && value.areaIds.some((area) => !context.areaIds?.includes(area))) return false;
  const controlIds = new Set<string>();
  return value.controls.every((c) => {
    if (!object(c) || !hasOnlyKeys(c, controlKeys) || c.schemaVersion !== 1 || c.deviceId !== value.id || !id(c.controlId) || controlIds.has(String(c.controlId)) || !(c.surfaceId == null || id(c.surfaceId)) || !(c.unsupportedReason == null || typeof c.unsupportedReason === 'string' && c.unsupportedReason.length <= 120) || !validConstraints(c.constraints) || !semanticRoles.has(String(c.semanticRole)) || !['boolean','number','option','text','invoke'].includes(String(c.valueType)) || !['toggle','slider','thermostat','picker','text_input','momentary_action','read_only'].includes(String(c.interactionKind)) || !['set_value','invoke_once','none'].includes(String(c.idempotency)) || !['none','matching_observation','explicit_user','step_up'].includes(String(c.confirmationPolicy)) || !['low','normal','sensitive','critical'].includes(String(c.riskLevel)) || !['none','required'].includes(String(c.stepUpPolicy)) || typeof c.label !== 'string' || !c.label.trim() || c.label.length > 80 || !(c.group == null || typeof c.group === 'string' && c.group.length <= 80) || typeof c.writable !== 'boolean' || typeof c.readable !== 'boolean' || typeof c.automatable !== 'boolean' || typeof c.observable !== 'boolean' || !Number.isInteger(c.catalogRevision) || c.catalogRevision !== value.descriptorRevision || typeof c.sortOrder !== 'number' || !Number.isInteger(c.sortOrder) || c.sortOrder < 0) return false;
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
/** Login receipt is metadata only: the reusable session secret remains in the HttpOnly cookie. */
export function validateCustomerSessionReceipt(value: unknown, now = Date.now()): value is CustomerSessionReceipt {
  if (!object(value) || !hasOnlyKeys(value, ['ok','accountId','sessionId','trustedDeviceId','expiresAt']) || value.ok !== true || !id(value.accountId) || !id(value.sessionId) || !id(value.trustedDeviceId) || !utcTimestamp(value.expiresAt)) return false;
  const expiresAt = Date.parse(value.expiresAt);
  return expiresAt > now && expiresAt <= now + 30 * 24 * 60 * 60 * 1000 + 1000;
}
/** The short-lived hub bearer is accepted only for its exact selected membership and home. */
export function validateCustomerHubSession(value: unknown, expected: { homeId: string; membershipId: string }, now = Date.now()): value is CustomerHubSession {
  if (!object(value) || !hasOnlyKeys(value, ['ok','token','expiresAt','homeId','membershipId']) || value.ok !== true || typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 8192 || value.token === 'TEST_ONLY_PLACEHOLDER_NOT_A_BEARER' || !utcTimestamp(value.expiresAt) || !id(expected.homeId) || !id(expected.membershipId) || value.homeId !== expected.homeId || value.membershipId !== expected.membershipId) return false;
  const expiresAt = Date.parse(value.expiresAt);
  return expiresAt > now && expiresAt <= now + 5 * 60 * 1000 + 1000;
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
  return object(value) && hasOnlyKeys(value, ['id','homeId','originalName','overrideName','revision','lifecycle']) && id(value.id) && id(value.homeId) && (!expectedHomeId || value.homeId === expectedHomeId) && typeof value.originalName === 'string' && value.originalName.trim().length > 0 && value.originalName.length <= 80 && (value.overrideName == null || typeof value.overrideName === 'string' && value.overrideName.trim().length > 0 && value.overrideName.length <= 80) && Number.isInteger(value.revision) && (value.lifecycle === 'active' || value.lifecycle === 'retired');
}
export function validateEnvelope(value: unknown, expectedHomeId?: string): value is NativeEnvelope<unknown> {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','homeId','streamId','sequence','generatedAt','revision','data']) && value.schemaVersion === DINODIA_V1 && id(value.homeId) && id(value.streamId) && (!expectedHomeId || value.homeId === expectedHomeId) && Number.isInteger(value.sequence) && Number(value.sequence) >= 0 && Number.isInteger(value.revision) && Number(value.revision) >= 0 && utcTimestamp(value.generatedAt) && Object.hasOwn(value, 'data');
}
export function effectiveControlQuality(state: NativeControlState, now = Date.now()): StateQuality {
  const validUntil = Date.parse(state.validUntil);
  if (!Number.isFinite(validUntil) || validUntil <= now) return 'unknown';
  return state.quality;
}
export function validateControlState(value: unknown, device: NativeDevice, control: NativeControl): value is NativeControlState {
  if (!object(value) || !hasOnlyKeys(value, ['deviceId','controlId','homeId','descriptorRevision','revision','observedAt','receivedAt','validUntil','quality','value','deviceAvailability','analyticsActivity'])) return false;
  if (typeof control.maxStateValiditySeconds !== 'number' || !Number.isInteger(control.maxStateValiditySeconds)) return false;
  const state = value as unknown as NativeControlState;
  const observedAt = Date.parse(state.observedAt); const receivedAt = Date.parse(state.receivedAt); const validUntil = Date.parse(state.validUntil);
  return state.deviceId === device.id && state.controlId === control.controlId && state.homeId === device.homeId && state.descriptorRevision === device.descriptorRevision && state.descriptorRevision === control.catalogRevision && Number.isInteger(state.revision) && state.revision >= 0 && utcTimestamp(state.observedAt) && utcTimestamp(state.receivedAt) && utcTimestamp(state.validUntil) && Number.isFinite(observedAt) && Number.isFinite(receivedAt) && Number.isFinite(validUntil) && receivedAt >= observedAt && validUntil > observedAt && Number.isInteger(control.maxStateValiditySeconds) && validUntil - observedAt <= control.maxStateValiditySeconds * 1000 && ['fresh','stale','unknown','unavailable'].includes(state.quality) && ['online','offline','unknown'].includes(state.deviceAvailability) && ['on','off','unknown'].includes(state.analyticsActivity);
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
  if (control.valueType === 'text') return typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  return control.valueType === 'invoke' && value === null;
}
export function validateCommandAgainstDevice(commandValue: unknown, device: NativeDevice, control: NativeControl, homeMembershipId: string): commandValue is NativeCommand {
  if (!object(commandValue) || !hasOnlyKeys(commandValue, ['commandId','homeId','homeMembershipId','deviceId','controlId','descriptorRevision','value','issuedAt','idempotencyKey','stepUpOperationId'])) return false;
  const currentControl = device.controls.find((candidate) => candidate.controlId === control.controlId && candidate.deviceId === control.deviceId);
  if (!validateNativeDevice(device) || !currentControl || !sameJsonValue(currentControl, control)) return false;
  const command = commandValue as unknown as NativeCommand;
  const requiresStepUp = control.stepUpPolicy === 'required' || control.semanticRole === 'security_lock' || control.semanticRole === 'lock_state';
  return id(command.commandId) && command.homeId === device.homeId && command.homeMembershipId === homeMembershipId && command.deviceId === device.id && command.controlId === control.controlId && Number.isInteger(command.descriptorRevision) && command.descriptorRevision >= 0 && command.descriptorRevision === device.descriptorRevision && command.descriptorRevision === control.catalogRevision && control.writable && commandValueMatches(control, command.value) && typeof command.issuedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(command.issuedAt) && Number.isFinite(Date.parse(command.issuedAt)) && typeof command.idempotencyKey === 'string' && command.idempotencyKey.length >= 16 && command.idempotencyKey.length <= 160 && (!requiresStepUp || id(command.stepUpOperationId));
}
