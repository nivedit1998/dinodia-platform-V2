import { createHash } from 'node:crypto';

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
export type NativeSupportCategory = 'ACCOUNT_OR_SIGN_IN'|'ACCESS_OR_PERMISSIONS'|'DEVICE_PROBLEM'|'HUB_OR_CONNECTION'|'AUTOMATION'|'ALEXA'|'OTHER';

export interface MembershipContext { accountId: OpaqueId; homeId: OpaqueId; homeMembershipId: OpaqueId; role: MembershipRole; status: 'active'|'suspended'|'removed'; areaIds: OpaqueId[]; revision: number }
export interface AccountSessionContext { schemaVersion: typeof DINODIA_V1; accountId: OpaqueId; sessionId: OpaqueId; trustedDeviceId: OpaqueId; memberships: MembershipContext[]; expiresAt: string }
export interface CustomerSessionLoginRequest { email: string; password: string; deviceInstallationId: OpaqueId; publicKey: string; deviceName: string; model?: string; osFamily?: string; osVersion?: string }
export interface CustomerSessionReceipt { ok: true; accountId: OpaqueId; sessionId: OpaqueId; trustedDeviceId: OpaqueId; expiresAt: string }
export interface MobileSessionMembership extends MembershipContext { postcode: string | null }
export interface MobileSessionUser { accountId: OpaqueId; displayName: string; username: string; email: string; emailVerifiedAt: string }
export interface MobileCustomerSessionReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; accountId: OpaqueId; sessionId: OpaqueId; trustedDeviceId: OpaqueId;
  accessToken: string; refreshToken: string; accessTokenExpiresAt: string; refreshTokenExpiresAt: string;
  user: MobileSessionUser; memberships: MobileSessionMembership[];
  nextAction: 'CHANGE_PASSWORD'|'CHOOSE_USERNAME'|'POLICY_UNAVAILABLE'|'ACCEPT_POLICY'|'PENDING_RELATIONSHIPS'|'SELECT_HOME';
  offlineHubEnforcement?: 'PENDING'|'NOT_REQUIRED';
}
export interface CustomerPolicyProjection { version: string; title: string; text: string; contentSha256: string }
export interface CustomerRequirementsReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true;
  nextAction: 'CHANGE_PASSWORD'|'CHOOSE_USERNAME'|'POLICY_UNAVAILABLE'|'ACCEPT_POLICY'|'CONTINUE'; accepted: boolean;
  policy: CustomerPolicyProjection|null;
}
export interface InvitedTenantRegistrationRequest { invitationId: OpaqueId; email: string; password: string }
export interface InvitedTenantUsernameRequest { username: string }
export interface InvitedTenantUsernameReceipt { schemaVersion: typeof DINODIA_V1; ok: true; username: string; usernameNormalized: string; nextAction: 'CONTINUE' }
export interface CustomerPolicyAcceptanceRequest { version: string; contentSha256: string; accepted: true }
export interface CustomerPolicyAcceptanceReceipt { schemaVersion: typeof DINODIA_V1; ok: true; policyVersion: string; contentSha256: string; idempotentReplay: boolean }
export interface CustomerSessionLogoutReceipt { ok: true }
export interface CustomerProfileReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; accountId: OpaqueId; displayName: string; username: string;
  phoneNumber: string|null; email: string; emailVerified: boolean; profileRevision: string;
}
export interface CustomerProfileUpdateRequest { displayName: string; username: string; phoneNumber: string|null; expectedProfileRevision: string; proof: string }
export interface TenantMembershipRemovalRequest {
  expectedAccessRevision: number; expectedManagementRevision: number; confirmFinalAccountDeletion: boolean;
  proof: string; idempotencyKey: string;
}
export interface TenantMembershipRemovalPreview {
  schemaVersion: typeof DINODIA_V1; homeMembershipId: OpaqueId; homePostcode: string|null;
  accessRevision: number; homeManagementRevision: number; willDeleteAccount: boolean; otherRelationshipsRemain: boolean;
}
export interface TenantMembershipRemovalReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; state: 'REMOVED'; homeMembershipId: OpaqueId;
  accountDeleted: boolean; otherRelationshipsRemain: boolean; nextAction: 'SELECT_HOME'|'PENDING_RELATIONSHIPS'|'SIGN_IN';
  hubEnforcement: 'PENDING'; anonymousReference: string|null; idempotentReplay: boolean;
}
export interface CustomerEmailChangeRequest { email: string; expectedProfileRevision: string; proof: string }
export interface CustomerEmailChangeReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; state: 'PENDING'; challengeId: OpaqueId; expiresAt: string;
  emailSubmission: 'ACCEPTED'|'FAILED';
}
export interface ApnsRegistrationRequest { deviceToken: string; environment: 'DEVELOPMENT'|'PRODUCTION' }
export interface ApnsRegistrationReceipt { schemaVersion: typeof DINODIA_V1; ok: true; trustedDeviceId: string; revision: number; state: 'ENABLED'|'DISABLED'; idempotentReplay: boolean }
export type CustomerPendingRelationshipType = 'INVITATION'|'ROOM_ACCESS_REQUEST'|'HOME_SETUP'|'INSTALLATION_PENDING';
export interface CustomerPendingRelationship {
  id: OpaqueId; type: CustomerPendingRelationshipType; postcode: string|null; createdAt: string; expiresAt: string|null;
  state: string; allowedActions: string[]; role?: MembershipRole; inviterLabel?: string; areaLabel?: string;
  decisionRevision?: string; revision?: number; requiredStep?: string|null;
}
export interface CustomerPendingRelationshipsProjection {
  schemaVersion: typeof DINODIA_V1; asOf: string; pendingRelationships: CustomerPendingRelationship[];
}
export interface CustomerInvitationDecisionRequest { decision: 'ACCEPT'|'DECLINE'; expectedUpdatedAt: string }
export interface CustomerInvitationDecisionReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; invitationId: OpaqueId; decision: 'ACCEPT'|'DECLINE';
  state: 'ACCEPTED'|'DECLINED'; homeMembershipId: OpaqueId|null; idempotentReplay: boolean;
}
export interface CustomerMembershipInvitationRequest { email: string; areaIds: OpaqueId[]; expectedManagementRevision: number; resendInvitationId?: OpaqueId }
export interface CustomerMembershipInvitationReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; invitationId: OpaqueId; homeId: OpaqueId;
  role: 'PROPERTY_MANAGER'|'TENANT'; state: 'PENDING'|'REVOKED'; expiresAt: string;
  emailSubmission: 'PENDING'|'ACCEPTED'|'NOT_SENT'|'FAILED'; idempotentReplay: boolean;
}
export interface HomeInvitationAreasReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; homeId: OpaqueId; managementRevision: number;
  areas: Array<{ id: OpaqueId; name: string }>;
}
export interface HomeownerTenantAreaGrantsRequest { areaIds: OpaqueId[]; expectedAccessRevision: number; expectedManagementRevision: number; proof: string }
export interface HomeownerTenantAreaGrantsReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; homeId: OpaqueId; tenantMembershipId: OpaqueId; areaIds: OpaqueId[];
  changed: boolean; managementRevision: number; accessRevision: number; decommissionTombstoneCount: number;
}
export interface HomeownerTenantRemovalRequest { expectedAccessRevision: number; expectedManagementRevision: number; proof: string; idempotencyKey: string }
export interface HomeownerTenantRemovalReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; homeId: OpaqueId; tenantMembershipId: OpaqueId; state: 'REMOVED';
  managementRevision: number; accessRevision: number; hubEnforcement: 'PENDING'; idempotentReplay: boolean;
}
export interface HomeownerManagerRemovalRequest { expectedManagementRevision: number; proof: string; idempotencyKey: string }
export interface HomeownerManagerRemovalReceipt {
  schemaVersion: typeof DINODIA_V1; ok: true; homeId: OpaqueId; managerMembershipId: OpaqueId; state: 'REMOVED';
  managementRevision: number; idempotentReplay: boolean;
}
export interface HomeownerManagementActivityItem { id: OpaqueId; occurredAt: string; activity: string; actor: string; target: string }
export interface HomeownerManagementActivityPage {
  schemaVersion: typeof DINODIA_V1; ok: true; homeId: OpaqueId; items: HomeownerManagementActivityItem[];
  nextCursor: string | null; retentionStartAt: string; asOf: string;
}
export interface CustomerRoomQrScanRequest { reference: string }
export interface CustomerRoomQrScanReceipt { schemaVersion: typeof DINODIA_V1; ok: true; state: 'AVAILABLE'; areaLabel: string; qrGeneration: number; requestValiditySeconds: number }
export interface CustomerRoomAccessRequestRequest { reference: string; expectedGeneration: number; idempotencyKey: string }
export interface CustomerRoomAccessRequestReceipt { schemaVersion: typeof DINODIA_V1; ok: true; requestId: OpaqueId; areaLabel: string; state: 'PENDING'; expiresAt: string; revision: string; coalesced: boolean; idempotentReplay: boolean }
export interface PublicRoomAccessEmailChallengeRequest { reference: string; expectedGeneration: number; email: string; idempotencyKey: string }
export interface PublicRoomAccessEmailChallengeReceipt { schemaVersion: typeof DINODIA_V1; ok: true; state: 'VERIFY_EMAIL'|'PENDING'; requestId: OpaqueId; challengeId?: OpaqueId; expiresAt: string; revision?: string; emailSubmission: 'ACCEPTED'|'PENDING'|'NOT_REQUIRED'; idempotentReplay: boolean }
export interface PublicRoomAccessEmailVerificationRequest { requestId: OpaqueId; challengeId: OpaqueId; code: string }
export interface PublicRoomAccessEmailVerificationReceipt { schemaVersion: typeof DINODIA_V1; ok: true; state: 'PENDING'; requestId: OpaqueId; expiresAt: string; revision: string; idempotentReplay: boolean }
export interface CustomerRoomAccessCancelRequest { expectedRevision: string; idempotencyKey: string }
export interface CustomerRoomAccessDecisionRequest { requestId: OpaqueId; decision: 'APPROVE'|'REJECT'; expectedRevision: string; idempotencyKey: string; proof: string }
export interface CustomerRoomAccessDecisionReceipt { schemaVersion: typeof DINODIA_V1; ok: true; requestId: OpaqueId; state: 'APPROVED'|'REJECTED'; membershipId: OpaqueId|null; idempotentReplay: boolean }
export interface CustomerHomeClaimResolveReceipt { schemaVersion: typeof DINODIA_V1; ok: true; claimId: OpaqueId; generation: number; state: 'SETUP'; expiresAt: string }
export interface CustomerHomeClaimResolverProof {
  version: 1; serial: string; identityGeneration: number; challengeId: OpaqueId; challenge: string;
  resolverGeneration: number; expiresAt: string; timestamp: string; nonce: string; bodyHash: string; hubSignature: string;
}
export interface CustomerHomeClaimResolveRequest { reference: string; resolverProof?: CustomerHomeClaimResolverProof }
export interface CustomerHomeClaimLanEndpointRequest { reference: string }
export interface CustomerHomeClaimLanEndpointReceipt { schemaVersion: typeof DINODIA_V1; ok: true; lanEndpoint: CustomerLanEndpoint }
export interface CustomerLanEndpoint {
  state: 'verified_lan'; origin: string; publicHubId: string; certificateGeneration: number; currentSpkiPin: string;
  currentNotBefore: string; currentNotAfter: string; nextCertificateGeneration?: number; nextSpkiPin?: string;
  nextNotBefore?: string; nextNotAfter?: string; reportedAt: string; validUntil: string;
}
export type CustomerHomeClaimSetupStep = 'PROFILE'|'ADDRESS'|'ADDRESS_CONFIRMATION'|'POLICY';
export interface CustomerHomeClaimSetupRequest { expectedRevision: number; step: CustomerHomeClaimSetupStep; mutation: Record<string, unknown> }
export interface CustomerHomeClaimCompleteRequest { expectedRevision: number; idempotencyKey: string }
export interface CustomerHomeClaimSetupStatus {
  schemaVersion: typeof DINODIA_V1; claimId: OpaqueId; state: 'SETUP'|'INSTALLATION_PENDING'|'ACTIVE'; requiredStep: 'PROFILE'|'ADDRESS'|'ADDRESS_CONFIRMATION'|'POLICY'|null;
  revision: number; expiresAt: string|null; postcode: string|null;
  ownDraft: { addressLine1: string|null; addressLine2: string|null; city: string|null; region: string|null; postcode: string|null; country: string|null; timezone: string|null }|null;
}
export interface CustomerHomeClaimAddress { schemaVersion: typeof DINODIA_V1; ok: true; claimId: OpaqueId; addressLine1: string|null; addressLine2: string|null; city: string|null; region: string|null; postcode: string|null; country: string|null; timezone: string|null; addressRevision: number; addressDigest: string }
export interface CustomerHomeClaimSetupReceipt { schemaVersion: typeof DINODIA_V1; ok: true; claimId: OpaqueId; step: 'PROFILE'|'ADDRESS'|'ADDRESS_CONFIRMATION'|'POLICY'; expiresAt: string; revision: number }
export interface CustomerHomeClaimCompleteReceipt { schemaVersion: typeof DINODIA_V1; ok: true; claimId: OpaqueId; state: 'PENDING_INSTALLATION'|'ACTIVE'; idempotentReplay: boolean; postcode: string|null }
export interface OwnershipTransferSummary { transferId: OpaqueId; state: 'PENDING'; createdAt: string; updatedAt: string; reference: string; recipientEmail: string; emailDeliveryStatus: 'PENDING'|'ACCEPTED'|'FAILED'; expiresAt: null }
export interface OwnershipTransferStatus { schemaVersion: typeof DINODIA_V1; homeId: OpaqueId; managementRevision: number; activeTransfer: OwnershipTransferSummary|null }
export interface OwnershipTransferStartRequest { action: 'START'; recipientEmail: string; expectedManagementRevision: number; proof: string; idempotencyKey: string }
export interface OwnershipTransferCancelRequest { action: 'CANCEL'; transferId: OpaqueId; expectedTransferUpdatedAt: string; proof: string; idempotencyKey: string }
export interface OwnershipTransferResolveRequest { reference: string; idempotencyKey: string; resolverProof?: CustomerHomeClaimResolverProof }
export interface OwnershipTransferStartReceipt { schemaVersion: typeof DINODIA_V1; ok: true; transferId: OpaqueId; reference: string; state: 'PENDING'; emailDeliveryStatus: 'PENDING'|'ACCEPTED'|'FAILED'; idempotentReplay: boolean }
export interface OwnershipTransferCancelReceipt { schemaVersion: typeof DINODIA_V1; ok: true; transferId: OpaqueId; state: 'CANCELLED'; idempotentReplay: boolean }
export interface OwnershipTransferResolveReceipt { schemaVersion: typeof DINODIA_V1; ok: true; transferId: OpaqueId; homeId: OpaqueId; homeMembershipId: OpaqueId; state: 'TRANSFERRED'; idempotentReplay: boolean }
export interface PublicSupportEmailChallengeRequest { replyEmail: string; category: NativeSupportCategory; description: string }
export interface PublicSupportEmailChallengeReceipt { schemaVersion: typeof DINODIA_V1; ok: true; state: 'PENDING'; challengeId: OpaqueId; expiresAt: string; emailSubmission: 'ACCEPTED'|'FAILED' }
export interface PublicSupportEmailVerificationRequest { challengeId: OpaqueId; code: string; category: NativeSupportCategory; description: string }
export interface PublicSupportTicketReceipt { schemaVersion: typeof DINODIA_V1; ok: true; state: 'SUBMITTED'; publicReference: string; idempotentReplay: boolean }
export interface CustomerLanEndpoint {
  state: 'verified_lan'; origin: string; publicHubId: string; certificateGeneration: number;
  currentSpkiPin: string; currentNotBefore: string; currentNotAfter: string;
  nextCertificateGeneration?: number; nextSpkiPin?: string; nextNotBefore?: string; nextNotAfter?: string;
  reportedAt: string; validUntil: string;
}
export type CustomerHubEndpoint = ({ state: 'verified_cloud'; origin: string } | { state: 'unavailable' }) & { lan?: CustomerLanEndpoint };
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
export interface LanTlsIdentityObservation {
  version: 1; revision: number; state: 'CURRENT'|'UNAVAILABLE'; publicHubId: string; host: string; port: 8123;
  certificateGeneration: number; currentSpkiPin: string; currentNotBefore: string; currentNotAfter: string;
  nextCertificateGeneration?: number; nextSpkiPin?: string; nextNotBefore?: string; nextNotAfter?: string;
  acknowledgedGeneration: number;
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const codePointLength = (value: string): number => Array.from(value).length;
const nonEmptyText = (value: unknown, maximumCodePoints: number): value is string => typeof value === 'string' && value.trim().length > 0 && codePointLength(value) <= maximumCodePoints;
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
export function validateCustomerRequirementsReceipt(value: unknown): value is CustomerRequirementsReceipt {
  if (!object(value) || !hasOnlyKeys(value, ['schemaVersion','ok','nextAction','accepted','policy'])
    || value.schemaVersion !== DINODIA_V1 || value.ok !== true
    || !['CHANGE_PASSWORD','CHOOSE_USERNAME','POLICY_UNAVAILABLE','ACCEPT_POLICY','CONTINUE'].includes(String(value.nextAction))
    || typeof value.accepted !== 'boolean') return false;
  const policy = value.policy;
  if (policy !== null) {
    if (!object(policy) || !hasOnlyKeys(policy, ['version','title','text','contentSha256'])
      || typeof policy.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(policy.version)
      || !nonEmptyText(policy.title, 160) || typeof policy.text !== 'string' || policy.text.trim().length < 20 || policy.text.length > 40_000
      || typeof policy.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(policy.contentSha256)
      || createHash('sha256').update(policy.text.trim(), 'utf8').digest('hex') !== policy.contentSha256) return false;
  }
  if (value.nextAction === 'POLICY_UNAVAILABLE') return !value.accepted && policy === null;
  if (value.nextAction === 'ACCEPT_POLICY') return !value.accepted && policy !== null;
  if (value.nextAction === 'CONTINUE') return value.accepted && policy !== null;
  return true; // Mandatory password replacement takes precedence over policy.
}
export function validateInvitedTenantRegistrationRequest(value: unknown): value is InvitedTenantRegistrationRequest {
  return object(value) && hasOnlyKeys(value, ['invitationId','email','password'])
    && typeof value.invitationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.invitationId)
    && typeof value.email === 'string' && value.email === value.email.trim().toLowerCase()
    && value.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    && typeof value.password === 'string' && codePointLength(value.password) >= 12 && codePointLength(value.password) <= 1024;
}
export function validateInvitedTenantUsernameRequest(value: unknown): value is InvitedTenantUsernameRequest {
  return object(value) && hasOnlyKeys(value, ['username']) && typeof value.username === 'string'
    && value.username === value.username.trim() && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(value.username);
}
export function validateInvitedTenantUsernameReceipt(value: unknown, expectedUsername: string): value is InvitedTenantUsernameReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','username','usernameNormalized','nextAction'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.username === expectedUsername
    && value.usernameNormalized === expectedUsername.toLowerCase() && value.nextAction === 'CONTINUE';
}
export function validateCustomerPolicyAcceptanceReceipt(value: unknown): value is CustomerPolicyAcceptanceReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','policyVersion','contentSha256','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true
    && typeof value.policyVersion === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value.policyVersion)
    && typeof value.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.contentSha256)
    && typeof value.idempotentReplay === 'boolean';
}
export function validateApnsRegistrationRequest(value: unknown): value is ApnsRegistrationRequest {
  return object(value) && hasOnlyKeys(value, ['deviceToken', 'environment'])
    && typeof value.deviceToken === 'string' && value.deviceToken.length >= 64 && value.deviceToken.length <= 512
    && value.deviceToken.length % 2 === 0 && /^(?:[A-Fa-f0-9]{2}){32,256}$/.test(value.deviceToken)
    && (value.environment === 'DEVELOPMENT' || value.environment === 'PRODUCTION');
}
export function validateApnsRegistrationReceipt(value: unknown): value is ApnsRegistrationReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','trustedDeviceId','revision','state','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && typeof value.trustedDeviceId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trustedDeviceId)
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && (value.state === 'ENABLED' || value.state === 'DISABLED') && typeof value.idempotentReplay === 'boolean';
}
export function validateCustomerProfileReceipt(value: unknown): value is CustomerProfileReceipt {
  return object(value) && Object.keys(value).length === 9 && hasOnlyKeys(value, ['schemaVersion','ok','accountId','displayName','username','phoneNumber','email','emailVerified','profileRevision'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && id(value.accountId)
    && nonEmptyText(value.displayName, 160) && nonEmptyText(value.username, 80)
    && (value.phoneNumber === null || typeof value.phoneNumber === 'string' && /^[+() .0-9-]{7,40}$/.test(value.phoneNumber))
    && typeof value.email === 'string' && value.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    && typeof value.emailVerified === 'boolean' && utcTimestamp(value.profileRevision);
}
export function validateCustomerProfileUpdateRequest(value: unknown): value is CustomerProfileUpdateRequest {
  return object(value) && Object.keys(value).length === 5 && hasOnlyKeys(value, ['displayName','username','phoneNumber','expectedProfileRevision','proof'])
    && nonEmptyText(value.displayName, 160) && nonEmptyText(value.username, 80)
    && (value.phoneNumber === null || typeof value.phoneNumber === 'string' && /^[+() .0-9-]{7,40}$/.test(value.phoneNumber))
    && utcTimestamp(value.expectedProfileRevision) && typeof value.proof === 'string' && codePointLength(value.proof) >= 40 && codePointLength(value.proof) <= 8192;
}
export function validateTenantMembershipRemovalRequest(value: unknown): value is TenantMembershipRemovalRequest {
  return object(value) && Object.keys(value).length === 5 && hasOnlyKeys(value, ['expectedAccessRevision','expectedManagementRevision','confirmFinalAccountDeletion','proof','idempotencyKey'])
    && Number.isSafeInteger(value.expectedAccessRevision) && Number(value.expectedAccessRevision) > 0
    && Number.isSafeInteger(value.expectedManagementRevision) && Number(value.expectedManagementRevision) > 0
    && typeof value.confirmFinalAccountDeletion === 'boolean'
    && typeof value.proof === 'string' && codePointLength(value.proof) >= 40 && codePointLength(value.proof) <= 8192
    && typeof value.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{16,160}$/.test(value.idempotencyKey);
}
export function validateTenantMembershipRemovalPreview(value: unknown): value is TenantMembershipRemovalPreview {
  return object(value) && Object.keys(value).length === 7 && hasOnlyKeys(value, ['schemaVersion','homeMembershipId','homePostcode','accessRevision','homeManagementRevision','willDeleteAccount','otherRelationshipsRemain'])
    && value.schemaVersion === DINODIA_V1 && id(value.homeMembershipId)
    && (value.homePostcode === null || nonEmptyText(value.homePostcode, 32))
    && Number.isSafeInteger(value.accessRevision) && Number(value.accessRevision) > 0
    && Number.isSafeInteger(value.homeManagementRevision) && Number(value.homeManagementRevision) > 0
    && typeof value.willDeleteAccount === 'boolean' && typeof value.otherRelationshipsRemain === 'boolean'
    && value.willDeleteAccount === !value.otherRelationshipsRemain;
}
export function validateTenantMembershipRemovalReceipt(value: unknown): value is TenantMembershipRemovalReceipt {
  return object(value) && Object.keys(value).length === 10 && hasOnlyKeys(value, ['schemaVersion','ok','state','homeMembershipId','accountDeleted','otherRelationshipsRemain','nextAction','hubEnforcement','anonymousReference','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.state === 'REMOVED' && id(value.homeMembershipId)
    && typeof value.accountDeleted === 'boolean' && typeof value.otherRelationshipsRemain === 'boolean'
    && value.accountDeleted === !value.otherRelationshipsRemain
    && ['SELECT_HOME','PENDING_RELATIONSHIPS','SIGN_IN'].includes(String(value.nextAction))
    && value.hubEnforcement === 'PENDING'
    && (value.anonymousReference === null || typeof value.anonymousReference === 'string' && /^del_[A-Za-z0-9_-]{32}$/.test(value.anonymousReference))
    && typeof value.idempotentReplay === 'boolean'
    && (value.accountDeleted ? value.nextAction === 'SIGN_IN' && value.anonymousReference !== null : value.nextAction !== 'SIGN_IN' && value.anonymousReference === null);
}
export function validateCustomerEmailChangeRequest(value: unknown): value is CustomerEmailChangeRequest {
  return object(value) && Object.keys(value).length === 3 && hasOnlyKeys(value, ['email','expectedProfileRevision','proof'])
    && typeof value.email === 'string' && value.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)
    && utcTimestamp(value.expectedProfileRevision) && typeof value.proof === 'string' && codePointLength(value.proof) >= 40 && codePointLength(value.proof) <= 8192;
}
export function validateCustomerEmailChangeReceipt(value: unknown): value is CustomerEmailChangeReceipt {
  return object(value) && Object.keys(value).length === 6 && hasOnlyKeys(value, ['schemaVersion','ok','state','challengeId','expiresAt','emailSubmission'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.state === 'PENDING'
    && id(value.challengeId) && utcTimestamp(value.expiresAt) && ['ACCEPTED','FAILED'].includes(String(value.emailSubmission));
}
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
export function validateLanEndpointObservation(value: unknown, serial: string, expectedPort = 80): value is LanEndpointObservation {
  if (!object(value) || !hasOnlyKeys(value, ['version','revision','state','baseUrl','discoveryHost']) || value.version !== 1
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !id(serial)) return false;
  const host = `dinodia-${serial.toLowerCase()}.local`;
  if (value.discoveryHost !== host || !/^dinodia-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(host)) return false;
  if (value.state === 'UNAVAILABLE') return !Object.hasOwn(value, 'baseUrl');
  if (value.state !== 'CURRENT' || typeof value.baseUrl !== 'string') return false;
  const match = value.baseUrl.match(/^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  const allowedPorts = expectedPort === 80 ? new Set(['80', '8123']) : new Set([String(expectedPort)]);
  if (!match || !allowedPorts.has(match[2])) return false;
  const octets = match[1].split('.').map(Number);
  if (octets.length !== 4 || octets.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== match[1].split('.')[index])) return false;
  const [a, b, , last] = octets;
  if (last === 0 || last === 255 || a === 172 && (b === 17 || b === 18)) return false;
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}
/** Authenticated machine report for the customer-only HTTPS LAN identity. */
export function validateLanTlsIdentityObservation(value: unknown): value is LanTlsIdentityObservation {
  if (!object(value) || !hasOnlyKeys(value, ['version','revision','state','publicHubId','host','port','certificateGeneration','currentSpkiPin','currentNotBefore','currentNotAfter','nextCertificateGeneration','nextSpkiPin','nextNotBefore','nextNotAfter','acknowledgedGeneration'])
    || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !['CURRENT','UNAVAILABLE'].includes(String(value.state)) || typeof value.publicHubId !== 'string' || !/^[a-f0-9]{20}$/.test(value.publicHubId)
    || value.host !== `dinodia-${value.publicHubId}.local` || value.port !== 8123
    || !Number.isSafeInteger(value.certificateGeneration) || Number(value.certificateGeneration) < 1
    || typeof value.currentSpkiPin !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.currentSpkiPin)
    || !utcTimestamp(value.currentNotBefore) || !utcTimestamp(value.currentNotAfter)
    || !Number.isSafeInteger(value.acknowledgedGeneration) || Number(value.acknowledgedGeneration) < 0) return false;
  if (Date.parse(value.currentNotBefore) >= Date.parse(value.currentNotAfter)) return false;
  const nextFields = ['nextCertificateGeneration','nextSpkiPin','nextNotBefore','nextNotAfter'];
  const hasNext = nextFields.some((key) => Object.hasOwn(value, key));
  if (hasNext && (nextFields.some((key) => !Object.hasOwn(value, key))
    || !Number.isSafeInteger(value.nextCertificateGeneration) || Number(value.nextCertificateGeneration) <= Number(value.certificateGeneration)
    || typeof value.nextSpkiPin !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.nextSpkiPin)
    || value.nextSpkiPin === value.currentSpkiPin || !utcTimestamp(value.nextNotBefore) || !utcTimestamp(value.nextNotAfter)
    || Date.parse(value.nextNotBefore) >= Date.parse(value.nextNotAfter))) return false;
  if (Number(value.acknowledgedGeneration) > Number(value.certificateGeneration)
    && (!hasNext || Number(value.acknowledgedGeneration) !== Number(value.nextCertificateGeneration))) return false;
  return value.state === 'CURRENT' || value.state === 'UNAVAILABLE';
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
  if (!object(value) || !hasOnlyKeys(value, ['schemaVersion','accountId','sessionId','trustedDeviceId','memberships','expiresAt']) || value.schemaVersion !== DINODIA_V1 || !id(value.accountId) || !id(value.sessionId) || !id(value.trustedDeviceId) || !utcTimestamp(value.expiresAt) || Date.parse(value.expiresAt) <= now || !Array.isArray(value.memberships)) return false;
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
export function validateMobileCustomerSessionReceipt(value: unknown, now = Date.now()): value is MobileCustomerSessionReceipt {
  const required = ['schemaVersion','ok','accountId','sessionId','trustedDeviceId','accessToken','refreshToken','accessTokenExpiresAt','refreshTokenExpiresAt','user','memberships','nextAction'];
  if (!object(value) || !hasOnlyKeys(value, [...required, 'offlineHubEnforcement']) || !required.every((key) => key in value)
    || value.schemaVersion !== DINODIA_V1 || value.ok !== true || !id(value.accountId) || !id(value.sessionId) || !id(value.trustedDeviceId)
    || typeof value.accessToken !== 'string' || !/^dno-customer-access-[A-Za-z0-9_-]{32,160}$/.test(value.accessToken)
    || typeof value.refreshToken !== 'string' || !/^dno-customer-session-[A-Za-z0-9_-]{32,160}$/.test(value.refreshToken)
    || !utcTimestamp(value.accessTokenExpiresAt) || !utcTimestamp(value.refreshTokenExpiresAt)
    || !object(value.user) || !hasOnlyKeys(value.user, ['accountId','displayName','username','email','emailVerifiedAt'])
    || value.user.accountId !== value.accountId || !nonEmptyText(value.user.displayName, 160) || !nonEmptyText(value.user.username, 80)
    || typeof value.user.email !== 'string' || value.user.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.user.email)
    || !utcTimestamp(value.user.emailVerifiedAt) || !Array.isArray(value.memberships)
    || !['CHANGE_PASSWORD','CHOOSE_USERNAME','POLICY_UNAVAILABLE','ACCEPT_POLICY','PENDING_RELATIONSHIPS','SELECT_HOME'].includes(String(value.nextAction))
    || (value.offlineHubEnforcement !== undefined && !['PENDING','NOT_REQUIRED'].includes(String(value.offlineHubEnforcement)))) return false;
  const accessExpiry = Date.parse(String(value.accessTokenExpiresAt)); const refreshExpiry = Date.parse(String(value.refreshTokenExpiresAt));
  if (accessExpiry <= now || accessExpiry > now + 15 * 60 * 1000 + 2000 || refreshExpiry <= now || refreshExpiry > now + 180 * 24 * 60 * 60 * 1000 + 2000) return false;
  const homeIds = new Set<string>(); const membershipIds = new Set<string>();
  for (const membership of value.memberships) {
    if (!object(membership) || !hasOnlyKeys(membership, ['accountId','homeId','homeMembershipId','role','status','areaIds','revision','postcode'])
      || !validateMembership({ accountId: membership.accountId, homeId: membership.homeId, homeMembershipId: membership.homeMembershipId, role: membership.role, status: membership.status, areaIds: membership.areaIds, revision: membership.revision })
      || membership.accountId !== value.accountId || !(membership.postcode === null || nonEmptyText(membership.postcode, 32))
      || homeIds.has(String(membership.homeId)) || membershipIds.has(String(membership.homeMembershipId))) return false;
    homeIds.add(String(membership.homeId)); membershipIds.add(String(membership.homeMembershipId));
  }
  return true;
}
export function validateCustomerSessionLogoutReceipt(value: unknown): value is CustomerSessionLogoutReceipt {
  return object(value) && hasOnlyKeys(value, ['ok']) && value.ok === true;
}
/** Strict account-global pending projection; action authority is server-declared per row. */
export function validateCustomerPendingRelationshipsProjection(value: unknown, now = Date.now()): value is CustomerPendingRelationshipsProjection {
  if (!object(value) || !hasOnlyKeys(value, ['schemaVersion','asOf','pendingRelationships']) || value.schemaVersion !== DINODIA_V1
    || !utcTimestamp(value.asOf) || Date.parse(value.asOf) > now || !Array.isArray(value.pendingRelationships) || value.pendingRelationships.length > 150) return false;
  const ids = new Set<string>();
  for (const row of value.pendingRelationships) {
    if (!object(row) || !hasOnlyKeys(row, ['id','type','postcode','createdAt','expiresAt','state','allowedActions','role','inviterLabel','areaLabel','decisionRevision','revision','requiredStep'])
      || !id(row.id) || ids.has(row.id) || !['INVITATION','ROOM_ACCESS_REQUEST','HOME_SETUP','INSTALLATION_PENDING'].includes(String(row.type))
      || !(row.postcode === null || nonEmptyText(row.postcode, 32)) || !utcTimestamp(row.createdAt) || !(row.expiresAt === null || utcTimestamp(row.expiresAt))
      || typeof row.state !== 'string' || !/^[A-Z_]{1,48}$/.test(row.state) || !Array.isArray(row.allowedActions)) return false;
    const actionSets: Record<string, string> = {
      INVITATION: 'ACCEPT,DECLINE', ROOM_ACCESS_REQUEST: 'VIEW_STATUS,CANCEL',
      HOME_SETUP: 'RESUME_SETUP', INSTALLATION_PENDING: 'VIEW_STATUS,REFRESH',
    };
    const expectedActions = actionSets[String(row.type)].split(',');
    if (row.allowedActions.length !== expectedActions.length || row.allowedActions.some((action, index) => action !== expectedActions[index])
      || Date.parse(row.createdAt) > Date.parse(value.asOf)) return false;
    if (row.type === 'INVITATION') {
      if (!nonEmptyText(row.postcode, 32) || !['PROPERTY_MANAGER','TENANT'].includes(String(row.role)) || !nonEmptyText(row.inviterLabel, 160)
        || !utcTimestamp(row.decisionRevision) || Object.hasOwn(row, 'areaLabel') || Object.hasOwn(row, 'revision') || Object.hasOwn(row, 'requiredStep')) return false;
    } else if (row.type === 'ROOM_ACCESS_REQUEST') {
      if (!nonEmptyText(row.postcode, 32) || !nonEmptyText(row.areaLabel, 80) || !utcTimestamp(row.decisionRevision) || Object.hasOwn(row, 'role') || Object.hasOwn(row, 'inviterLabel')
        || Object.hasOwn(row, 'revision') || Object.hasOwn(row, 'requiredStep')) return false;
    } else if (row.type === 'INSTALLATION_PENDING' && !nonEmptyText(row.postcode, 32)
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
      || !(row.requiredStep === null || typeof row.requiredStep === 'string' && /^[A-Z_]{1,80}$/.test(row.requiredStep))
      || Object.hasOwn(row, 'role') || Object.hasOwn(row, 'inviterLabel') || Object.hasOwn(row, 'areaLabel') || Object.hasOwn(row, 'decisionRevision')) return false;
    if (row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.parse(value.asOf)) return false;
    ids.add(row.id);
  }
  return true;
}
export function validateCustomerInvitationDecisionRequest(value: unknown): value is CustomerInvitationDecisionRequest {
  return object(value) && hasOnlyKeys(value, ['decision','expectedUpdatedAt']) && ['ACCEPT','DECLINE'].includes(String(value.decision)) && utcTimestamp(value.expectedUpdatedAt);
}
export function validateCustomerInvitationDecisionReceipt(value: unknown, expectedInvitationId: string): value is CustomerInvitationDecisionReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','invitationId','decision','state','homeMembershipId','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.invitationId === expectedInvitationId
    && ['ACCEPT','DECLINE'].includes(String(value.decision)) && (value.state === 'ACCEPTED' || value.state === 'DECLINED')
    && (value.homeMembershipId === null || id(value.homeMembershipId)) && typeof value.idempotentReplay === 'boolean'
    && (value.decision === 'ACCEPT' ? value.state === 'ACCEPTED' && id(value.homeMembershipId) : value.state === 'DECLINED' && value.homeMembershipId === null);
}
export function validateCustomerMembershipInvitationRequest(value: unknown, role: 'PROPERTY_MANAGER'|'TENANT'): value is CustomerMembershipInvitationRequest {
  if (!object(value) || !hasOnlyKeys(value, ['email','areaIds','expectedManagementRevision','resendInvitationId'])
    || typeof value.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim()) || value.email.trim().length > 320
    || !Array.isArray(value.areaIds) || value.areaIds.length > 64 || !value.areaIds.every(id) || new Set(value.areaIds).size !== value.areaIds.length
    || !Number.isSafeInteger(value.expectedManagementRevision) || Number(value.expectedManagementRevision) < 0
    || Object.hasOwn(value, 'resendInvitationId') && (typeof value.resendInvitationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.resendInvitationId))) return false;
  return role === 'TENANT' ? value.areaIds.length > 0 : value.areaIds.length === 0;
}
export function validateCustomerMembershipInvitationReceipt(value: unknown, expectedHomeId: string, expectedRole: 'PROPERTY_MANAGER'|'TENANT'): value is CustomerMembershipInvitationReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','invitationId','homeId','role','state','expiresAt','emailSubmission','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && id(value.invitationId) && value.homeId === expectedHomeId && value.role === expectedRole
    && ['PENDING','REVOKED'].includes(String(value.state)) && utcTimestamp(value.expiresAt)
    && ['PENDING','ACCEPTED','NOT_SENT','FAILED'].includes(String(value.emailSubmission)) && typeof value.idempotentReplay === 'boolean';
}
export function validateHomeInvitationAreasReceipt(value: unknown, expectedHomeId: string): value is HomeInvitationAreasReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','homeId','managementRevision','areas'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.homeId === expectedHomeId
    && Number.isSafeInteger(value.managementRevision) && Number(value.managementRevision) >= 0
    && Array.isArray(value.areas) && value.areas.length <= 64
    && value.areas.every((area) => object(area) && hasOnlyKeys(area, ['id','name']) && id(area.id) && nonEmptyText(area.name, 120))
    && new Set(value.areas.map((area) => (area as Record<string, unknown>).id)).size === value.areas.length;
}
export function validateHomeownerTenantAreaGrantsRequest(value: unknown): value is HomeownerTenantAreaGrantsRequest {
  return object(value) && hasOnlyKeys(value, ['areaIds','expectedAccessRevision','expectedManagementRevision','proof'])
    && Array.isArray(value.areaIds) && value.areaIds.length <= 64 && value.areaIds.every(id)
    && new Set(value.areaIds).size === value.areaIds.length
    && Number.isSafeInteger(value.expectedAccessRevision) && Number(value.expectedAccessRevision) >= 0
    && Number.isSafeInteger(value.expectedManagementRevision) && Number(value.expectedManagementRevision) >= 1
    && typeof value.proof === 'string' && codePointLength(value.proof) >= 32 && codePointLength(value.proof) <= 16384;
}
export function validateHomeownerTenantAreaGrantsReceipt(value: unknown, expectedHomeId: string, expectedMembershipId: string): value is HomeownerTenantAreaGrantsReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','homeId','tenantMembershipId','areaIds','changed','managementRevision','accessRevision','decommissionTombstoneCount'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.homeId === expectedHomeId
    && value.tenantMembershipId === expectedMembershipId && Array.isArray(value.areaIds) && value.areaIds.length <= 64
    && value.areaIds.every(id) && new Set(value.areaIds).size === value.areaIds.length
    && typeof value.changed === 'boolean' && Number.isSafeInteger(value.managementRevision) && Number(value.managementRevision) >= 1
    && Number.isSafeInteger(value.accessRevision) && Number(value.accessRevision) >= 0
    && Number.isSafeInteger(value.decommissionTombstoneCount) && Number(value.decommissionTombstoneCount) >= 0;
}
export function validateHomeownerTenantRemovalRequest(value: unknown): value is HomeownerTenantRemovalRequest {
  return object(value) && Object.keys(value).sort().join(',') === 'expectedAccessRevision,expectedManagementRevision,idempotencyKey,proof'
    && Number.isSafeInteger(value.expectedAccessRevision) && Number(value.expectedAccessRevision) >= 0
    && Number.isSafeInteger(value.expectedManagementRevision) && Number(value.expectedManagementRevision) >= 1
    && typeof value.proof === 'string' && codePointLength(value.proof) >= 32 && codePointLength(value.proof) <= 16384
    && idempotencyKey(value.idempotencyKey);
}
export function validateHomeownerTenantRemovalReceipt(value: unknown, expectedHomeId: string, expectedMembershipId: string): value is HomeownerTenantRemovalReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','homeId','tenantMembershipId','state','managementRevision','accessRevision','hubEnforcement','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.homeId === expectedHomeId && value.tenantMembershipId === expectedMembershipId
    && value.state === 'REMOVED' && Number.isSafeInteger(value.managementRevision) && Number(value.managementRevision) >= 1
    && Number.isSafeInteger(value.accessRevision) && Number(value.accessRevision) >= 1 && value.hubEnforcement === 'PENDING'
    && typeof value.idempotentReplay === 'boolean';
}
export function validateHomeownerManagerRemovalRequest(value: unknown): value is HomeownerManagerRemovalRequest {
  return object(value) && Object.keys(value).sort().join(',') === 'expectedManagementRevision,idempotencyKey,proof'
    && Number.isSafeInteger(value.expectedManagementRevision) && Number(value.expectedManagementRevision) >= 1
    && typeof value.proof === 'string' && codePointLength(value.proof) >= 32 && codePointLength(value.proof) <= 16384
    && idempotencyKey(value.idempotencyKey);
}
export function validateHomeownerManagerRemovalReceipt(value: unknown, expectedHomeId: string, expectedMembershipId: string): value is HomeownerManagerRemovalReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','homeId','managerMembershipId','state','managementRevision','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.homeId === expectedHomeId && value.managerMembershipId === expectedMembershipId
    && value.state === 'REMOVED' && Number.isSafeInteger(value.managementRevision) && Number(value.managementRevision) >= 1
    && typeof value.idempotentReplay === 'boolean';
}
export function validateHomeownerManagementActivityPage(value: unknown, expectedHomeId: string): value is HomeownerManagementActivityPage {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','homeId','items','nextCursor','retentionStartAt','asOf'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.homeId === expectedHomeId
    && Array.isArray(value.items) && value.items.length <= 100 && value.items.every((item) => object(item)
      && hasOnlyKeys(item, ['id','occurredAt','activity','actor','target']) && id(item.id) && utcTimestamp(item.occurredAt)
      && nonEmptyText(item.activity, 120) && nonEmptyText(item.actor, 160) && nonEmptyText(item.target, 80))
    && (value.nextCursor === null || typeof value.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.nextCursor))
    && utcTimestamp(value.retentionStartAt) && utcTimestamp(value.asOf);
}
const idempotencyKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{16,160}$/.test(value);
export function validateCustomerRoomQrScanRequest(value: unknown): value is CustomerRoomQrScanRequest {
  return object(value) && hasOnlyKeys(value, ['reference']) && typeof value.reference === 'string' && /^dno_room_[A-Za-z0-9_-]{40,64}$/.test(value.reference);
}
export function validateCustomerRoomQrScanReceipt(value: unknown): value is CustomerRoomQrScanReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','state','areaLabel','qrGeneration','requestValiditySeconds'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.state === 'AVAILABLE'
    && nonEmptyText(value.areaLabel, 80) && Number.isSafeInteger(value.qrGeneration) && Number(value.qrGeneration) > 0
    && value.requestValiditySeconds === 604800;
}
export function validateCustomerRoomAccessRequestRequest(value: unknown): value is CustomerRoomAccessRequestRequest {
  return object(value) && hasOnlyKeys(value, ['reference','expectedGeneration','idempotencyKey'])
    && validateCustomerRoomQrScanRequest({ reference: value.reference }) && Number.isSafeInteger(value.expectedGeneration)
    && Number(value.expectedGeneration) > 0 && idempotencyKey(value.idempotencyKey);
}
export function validateCustomerRoomAccessRequestReceipt(value: unknown): value is CustomerRoomAccessRequestReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','requestId','areaLabel','state','expiresAt','revision','coalesced','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && id(value.requestId) && nonEmptyText(value.areaLabel, 80)
    && value.state === 'PENDING' && utcTimestamp(value.expiresAt) && utcTimestamp(value.revision)
    && typeof value.coalesced === 'boolean' && typeof value.idempotentReplay === 'boolean';
}
export function validatePublicRoomAccessEmailChallengeRequest(value: unknown): value is PublicRoomAccessEmailChallengeRequest {
  return object(value) && hasOnlyKeys(value, ['reference','expectedGeneration','email','idempotencyKey'])
    && validateCustomerRoomQrScanRequest({ reference: value.reference }) && Number.isSafeInteger(value.expectedGeneration)
    && Number(value.expectedGeneration) > 0 && typeof value.email === 'string' && value.email.trim().length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim()) && idempotencyKey(value.idempotencyKey);
}
export function validatePublicRoomAccessEmailChallengeReceipt(value: unknown): value is PublicRoomAccessEmailChallengeReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','state','requestId','challengeId','expiresAt','revision','emailSubmission','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && ['VERIFY_EMAIL','PENDING'].includes(String(value.state))
    && id(value.requestId) && (value.challengeId === undefined || id(value.challengeId)) && utcTimestamp(value.expiresAt)
    && ['ACCEPTED','PENDING','NOT_REQUIRED'].includes(String(value.emailSubmission)) && typeof value.idempotentReplay === 'boolean'
    && (value.state === 'VERIFY_EMAIL' ? Boolean(value.challengeId) && value.revision === undefined
      : value.challengeId === undefined && value.emailSubmission === 'NOT_REQUIRED' && utcTimestamp(value.revision));
}
export function validatePublicRoomAccessEmailVerificationRequest(value: unknown): value is PublicRoomAccessEmailVerificationRequest {
  return object(value) && hasOnlyKeys(value, ['requestId','challengeId','code']) && id(value.requestId) && id(value.challengeId)
    && typeof value.code === 'string' && /^\d{6}$/.test(value.code);
}
export function validatePublicRoomAccessEmailVerificationReceipt(value: unknown): value is PublicRoomAccessEmailVerificationReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','state','requestId','expiresAt','revision','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.state === 'PENDING' && id(value.requestId)
    && utcTimestamp(value.expiresAt) && utcTimestamp(value.revision) && typeof value.idempotentReplay === 'boolean';
}
export function validateCustomerRoomAccessCancelRequest(value: unknown): value is CustomerRoomAccessCancelRequest {
  return object(value) && hasOnlyKeys(value, ['expectedRevision','idempotencyKey']) && utcTimestamp(value.expectedRevision) && idempotencyKey(value.idempotencyKey);
}
export function validateCustomerRoomAccessDecisionRequest(value: unknown): value is CustomerRoomAccessDecisionRequest {
  return object(value) && hasOnlyKeys(value, ['requestId','decision','expectedRevision','idempotencyKey','proof'])
    && id(value.requestId) && (value.decision === 'APPROVE' || value.decision === 'REJECT') && utcTimestamp(value.expectedRevision)
    && idempotencyKey(value.idempotencyKey) && typeof value.proof === 'string' && codePointLength(value.proof) >= 40 && codePointLength(value.proof) <= 8192;
}
export function validateCustomerRoomAccessDecisionReceipt(value: unknown, expectedRequestId: string): value is CustomerRoomAccessDecisionReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','requestId','state','membershipId','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.requestId === expectedRequestId
    && (value.state === 'APPROVED' ? value.membershipId === null || id(value.membershipId) : value.state === 'REJECTED' && value.membershipId === null)
    && typeof value.idempotentReplay === 'boolean';
}
const nullableText = (value: unknown, limit: number): value is string|null => value === null || nonEmptyText(value, limit);
export function validateCustomerHomeClaimResolveRequest(value: unknown): value is CustomerHomeClaimResolveRequest {
  if (!object(value) || !hasOnlyKeys(value, ['reference','resolverProof']) || typeof value.reference !== 'string') return false;
  const qrReference = /^dno_home_[A-Za-z0-9_-]{40,64}$/.test(value.reference);
  const permanentLabel = /^DNO-HOME-[A-Za-z0-9_-]{32,64}$/.test(value.reference);
  if (qrReference && value.resolverProof === undefined) return true;
  if (!permanentLabel || !object(value.resolverProof)
    || !hasOnlyKeys(value.resolverProof, ['version','serial','identityGeneration','challengeId','challenge','resolverGeneration','expiresAt','timestamp','nonce','bodyHash','hubSignature'])) return false;
  const proof = value.resolverProof;
  return proof.version === 1 && nonEmptyText(proof.serial, 160) && Number.isSafeInteger(proof.identityGeneration) && Number(proof.identityGeneration) > 0
    && id(proof.challengeId) && typeof proof.challenge === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(proof.challenge)
    && Number.isSafeInteger(proof.resolverGeneration) && Number(proof.resolverGeneration) > 0
    && utcTimestamp(proof.expiresAt) && typeof proof.timestamp === 'string' && /^\d{10,16}$/.test(proof.timestamp)
    && typeof proof.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(proof.nonce)
    && typeof proof.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(proof.bodyHash)
    && typeof proof.hubSignature === 'string' && /^[A-Za-z0-9_-]{40,2048}$/.test(proof.hubSignature);
}
export function validateCustomerHomeClaimLanEndpointRequest(value: unknown): value is CustomerHomeClaimLanEndpointRequest {
  return object(value) && hasOnlyKeys(value, ['reference']) && typeof value.reference === 'string'
    && /^DNO-HOME-[A-Za-z0-9_-]{32,64}$/.test(value.reference);
}
export function validateCustomerHomeClaimLanEndpointReceipt(value: unknown, now = Date.now()): value is CustomerHomeClaimLanEndpointReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','lanEndpoint']) && value.schemaVersion === DINODIA_V1
    && value.ok === true && validateCustomerLanEndpoint(value.lanEndpoint, now);
}
export function validateCustomerHomeClaimSetupRequest(value: unknown): value is CustomerHomeClaimSetupRequest {
  if (!object(value) || !hasOnlyKeys(value, ['expectedRevision','step','mutation']) || !Number.isSafeInteger(value.expectedRevision)
    || Number(value.expectedRevision) < 0 || !object(value.mutation)) return false;
  const mutation = value.mutation;
  if (value.step === 'PROFILE') return hasOnlyKeys(mutation, ['displayName','username']) && nonEmptyText(mutation.displayName, 160) && nonEmptyText(mutation.username, 80);
  const optionalText = (input: unknown, limit: number) => input === null || typeof input === 'string' && codePointLength(input) <= limit;
  if (value.step === 'ADDRESS') return hasOnlyKeys(mutation, ['addressLine1','addressLine2','city','region','postcode','country','timezone'])
    && nonEmptyText(mutation.addressLine1, 200) && optionalText(mutation.addressLine2, 200)
    && nonEmptyText(mutation.city, 120) && optionalText(mutation.region, 120) && nonEmptyText(mutation.postcode, 32)
    && typeof mutation.country === 'string' && /^[A-Z]{2}$/.test(mutation.country) && nonEmptyText(mutation.timezone, 80);
  if (value.step === 'ADDRESS_CONFIRMATION') return hasOnlyKeys(mutation, ['addressRevision','addressDigest'])
    && Number.isSafeInteger(mutation.addressRevision) && Number(mutation.addressRevision) >= 0
    && typeof mutation.addressDigest === 'string' && /^[a-f0-9]{64}$/.test(mutation.addressDigest);
  if (value.step === 'POLICY') return hasOnlyKeys(mutation, ['policyVersion','contentSha256','accepted']) && mutation.accepted === true
    && typeof mutation.policyVersion === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(mutation.policyVersion)
    && typeof mutation.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(mutation.contentSha256);
  return false;
}
export function validateCustomerHomeClaimCompleteRequest(value: unknown): value is CustomerHomeClaimCompleteRequest {
  return object(value) && hasOnlyKeys(value, ['expectedRevision','idempotencyKey']) && Number.isSafeInteger(value.expectedRevision)
    && Number(value.expectedRevision) >= 0 && typeof value.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{16,160}$/.test(value.idempotencyKey);
}
export function validateCustomerHomeClaimResolveReceipt(value: unknown): value is CustomerHomeClaimResolveReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','claimId','generation','state','expiresAt']) && value.schemaVersion === DINODIA_V1
    && value.ok === true && id(value.claimId) && Number.isSafeInteger(value.generation) && Number(value.generation) > 0
    && value.state === 'SETUP' && utcTimestamp(value.expiresAt);
}
export function validateCustomerHomeClaimSetupStatus(value: unknown): value is CustomerHomeClaimSetupStatus {
  if (!object(value) || !hasOnlyKeys(value, ['schemaVersion','claimId','state','requiredStep','revision','expiresAt','postcode','ownDraft'])
    || value.schemaVersion !== DINODIA_V1 || !id(value.claimId) || !['SETUP','INSTALLATION_PENDING','ACTIVE'].includes(String(value.state))
    || !(value.requiredStep === null || ['PROFILE','ADDRESS','ADDRESS_CONFIRMATION','POLICY'].includes(String(value.requiredStep)))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !(value.expiresAt === null || utcTimestamp(value.expiresAt)) || !nullableText(value.postcode, 32)) return false;
  if (value.ownDraft === null) return (value.state === 'INSTALLATION_PENDING' || value.state === 'ACTIVE') && value.expiresAt === null && value.requiredStep === null;
  return value.state === 'SETUP' && object(value.ownDraft) && hasOnlyKeys(value.ownDraft, ['addressLine1','addressLine2','city','region','postcode','country','timezone'])
    && nullableText(value.ownDraft.addressLine1, 200) && nullableText(value.ownDraft.addressLine2, 200)
    && nullableText(value.ownDraft.city, 120) && nullableText(value.ownDraft.region, 120) && nullableText(value.ownDraft.postcode, 32)
    && nullableText(value.ownDraft.country, 2) && nullableText(value.ownDraft.timezone, 80);
}
export function validateCustomerHomeClaimAddress(value: unknown, expectedClaimId: string): value is CustomerHomeClaimAddress {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','claimId','addressLine1','addressLine2','city','region','postcode','country','timezone','addressRevision','addressDigest'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.claimId === expectedClaimId
    && nullableText(value.addressLine1, 200) && nullableText(value.addressLine2, 200) && nullableText(value.city, 120)
    && nullableText(value.region, 120) && nullableText(value.postcode, 32) && nullableText(value.country, 2)
    && nullableText(value.timezone, 80) && Number.isSafeInteger(value.addressRevision) && Number(value.addressRevision) >= 0
    && typeof value.addressDigest === 'string' && /^[a-f0-9]{64}$/.test(value.addressDigest);
}
export function validateCustomerHomeClaimSetupReceipt(value: unknown, expectedClaimId: string): value is CustomerHomeClaimSetupReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','claimId','step','expiresAt','revision']) && value.schemaVersion === DINODIA_V1
    && value.ok === true && value.claimId === expectedClaimId && ['PROFILE','ADDRESS','ADDRESS_CONFIRMATION','POLICY'].includes(String(value.step))
    && utcTimestamp(value.expiresAt) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0;
}
export function validateCustomerHomeClaimCompleteReceipt(value: unknown, expectedClaimId: string): value is CustomerHomeClaimCompleteReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','claimId','state','idempotentReplay','postcode']) && value.schemaVersion === DINODIA_V1
    && value.ok === true && value.claimId === expectedClaimId && ['PENDING_INSTALLATION','ACTIVE'].includes(String(value.state))
    && typeof value.idempotentReplay === 'boolean' && nullableText(value.postcode, 32);
}
const ownershipTransferReference = (value: unknown): value is string => typeof value === 'string'
  && /^dno_transfer_[0-9a-f-]{36}_[A-Za-z0-9_-]{40,64}$/.test(value);
function validateOwnershipTransferSummary(value: unknown): value is OwnershipTransferSummary {
  return object(value) && hasOnlyKeys(value, ['transferId','state','createdAt','updatedAt','reference','recipientEmail','emailDeliveryStatus','expiresAt'])
    && id(value.transferId) && value.state === 'PENDING' && utcTimestamp(value.createdAt) && utcTimestamp(value.updatedAt)
    && ownershipTransferReference(value.reference) && typeof value.recipientEmail === 'string' && value.recipientEmail.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.recipientEmail)
    && ['PENDING','ACCEPTED','FAILED'].includes(String(value.emailDeliveryStatus)) && value.expiresAt === null;
}
export function validateOwnershipTransferStatus(value: unknown, expectedHomeId: string): value is OwnershipTransferStatus {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','homeId','managementRevision','activeTransfer'])
    && value.schemaVersion === DINODIA_V1 && id(expectedHomeId) && value.homeId === expectedHomeId
    && Number.isSafeInteger(value.managementRevision) && Number(value.managementRevision) >= 1
    && (value.activeTransfer === null || validateOwnershipTransferSummary(value.activeTransfer));
}
export function validateOwnershipTransferStartRequest(value: unknown): value is OwnershipTransferStartRequest {
  return object(value) && hasOnlyKeys(value, ['action','recipientEmail','expectedManagementRevision','proof','idempotencyKey'])
    && value.action === 'START' && typeof value.recipientEmail === 'string' && value.recipientEmail.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.recipientEmail)
    && Number.isSafeInteger(value.expectedManagementRevision) && Number(value.expectedManagementRevision) >= 1
    && typeof value.proof === 'string' && value.proof.length >= 40 && value.proof.length <= 8192 && idempotencyKey(value.idempotencyKey);
}
export function validateOwnershipTransferCancelRequest(value: unknown): value is OwnershipTransferCancelRequest {
  return object(value) && hasOnlyKeys(value, ['action','transferId','expectedTransferUpdatedAt','proof','idempotencyKey'])
    && value.action === 'CANCEL' && id(value.transferId) && utcTimestamp(value.expectedTransferUpdatedAt)
    && typeof value.proof === 'string' && value.proof.length >= 40 && value.proof.length <= 8192 && idempotencyKey(value.idempotencyKey);
}
export function validateOwnershipTransferResolveRequest(value: unknown): value is OwnershipTransferResolveRequest {
  if (!object(value) || !hasOnlyKeys(value, ['reference','idempotencyKey','resolverProof']) || !idempotencyKey(value.idempotencyKey)) return false;
  if (ownershipTransferReference(value.reference)) return value.resolverProof === undefined;
  return typeof value.reference === 'string' && /^DNO-HOME-[A-Za-z0-9_-]{32,64}$/.test(value.reference)
    && value.resolverProof !== undefined && validateCustomerHomeClaimResolveRequest({ reference: value.reference, resolverProof: value.resolverProof });
}
export function validateOwnershipTransferStartReceipt(value: unknown): value is OwnershipTransferStartReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','transferId','reference','state','emailDeliveryStatus','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && id(value.transferId) && ownershipTransferReference(value.reference)
    && value.state === 'PENDING' && ['PENDING','ACCEPTED','FAILED'].includes(String(value.emailDeliveryStatus)) && typeof value.idempotentReplay === 'boolean';
}
export function validateOwnershipTransferCancelReceipt(value: unknown): value is OwnershipTransferCancelReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','transferId','state','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && id(value.transferId) && value.state === 'CANCELLED' && typeof value.idempotentReplay === 'boolean';
}
export function validateOwnershipTransferResolveReceipt(value: unknown): value is OwnershipTransferResolveReceipt {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','transferId','homeId','homeMembershipId','state','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && id(value.transferId) && id(value.homeId)
    && id(value.homeMembershipId) && value.state === 'TRANSFERRED' && typeof value.idempotentReplay === 'boolean';
}
/** The short-lived hub bearer is accepted only for its exact selected membership and home. */
export function validateCustomerHubSession(value: unknown, expected: { homeId: string; membershipId: string }, now = Date.now()): value is CustomerHubSession {
  if (!object(value) || !hasOnlyKeys(value, ['ok','token','expiresAt','homeId','membershipId','hubEndpoint']) || value.ok !== true || typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 8192 || value.token === 'TEST_ONLY_PLACEHOLDER_NOT_A_BEARER' || !utcTimestamp(value.expiresAt) || !id(expected.homeId) || !id(expected.membershipId) || value.homeId !== expected.homeId || value.membershipId !== expected.membershipId) return false;
  const endpoint = value.hubEndpoint;
  if (!object(endpoint)) return false;
  if (endpoint.state === 'unavailable') {
    if (!hasOnlyKeys(endpoint, ['state','lan'])) return false;
  } else if (endpoint.state === 'verified_cloud') {
    if (!hasOnlyKeys(endpoint, ['state','origin','lan']) || typeof endpoint.origin !== 'string') return false;
    let parsed: URL;
    try { parsed = new URL(endpoint.origin); } catch { return false; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' && parsed.pathname !== '' || parsed.search || parsed.hash || parsed.origin !== endpoint.origin || !/^dinodia-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.dinodiasmartliving\.com$/.test(parsed.hostname)) return false;
  } else return false;
  if (endpoint.lan !== undefined) {
    const lan = endpoint.lan;
    if (!object(lan) || !hasOnlyKeys(lan, ['state','origin','publicHubId','certificateGeneration','currentSpkiPin','currentNotBefore','currentNotAfter','nextCertificateGeneration','nextSpkiPin','nextNotBefore','nextNotAfter','reportedAt','validUntil'])
      || lan.state !== 'verified_lan' || typeof lan.publicHubId !== 'string' || !/^[a-f0-9]{20}$/.test(lan.publicHubId)
      || lan.origin !== `https://dinodia-${lan.publicHubId}.local:8123` || !Number.isSafeInteger(lan.certificateGeneration) || Number(lan.certificateGeneration) < 1
      || typeof lan.currentSpkiPin !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(lan.currentSpkiPin)
      || !utcTimestamp(lan.currentNotBefore) || !utcTimestamp(lan.currentNotAfter) || !utcTimestamp(lan.reportedAt) || !utcTimestamp(lan.validUntil)) return false;
    const notBefore = Date.parse(lan.currentNotBefore); const notAfter = Date.parse(lan.currentNotAfter);
    const reportedAt = Date.parse(lan.reportedAt); const validUntil = Date.parse(lan.validUntil);
    if (notBefore > now || notAfter <= now || notAfter <= notBefore || reportedAt > now || now - reportedAt > 420_000 || validUntil <= now || validUntil > reportedAt + 420_000) return false;
    const hasNext = lan.nextCertificateGeneration !== undefined || lan.nextSpkiPin !== undefined || lan.nextNotBefore !== undefined || lan.nextNotAfter !== undefined;
    if (hasNext && (!Number.isSafeInteger(lan.nextCertificateGeneration) || Number(lan.nextCertificateGeneration) <= Number(lan.certificateGeneration)
      || typeof lan.nextSpkiPin !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(lan.nextSpkiPin)
      || !utcTimestamp(lan.nextNotBefore) || !utcTimestamp(lan.nextNotAfter)
      || Date.parse(lan.nextNotBefore) > Date.parse(lan.nextNotAfter) || lan.nextSpkiPin === lan.currentSpkiPin)) return false;
  }
  const expiresAt = Date.parse(value.expiresAt);
  return expiresAt > now && expiresAt <= now + 5 * 60 * 1000 + 1000;
}
const stepUpOperations = new Set(['trusted_device_remove','customer_password_change','customer_profile_change','customer_email_change','tenant_membership_remove','home_tenant_remove','home_property_manager_remove','home.tenant_automation_disable','home.tenant_automation_delete','tenant_device_remove','tenant_area_grants_replace','home.transfer','home.deregister','home_room_access_decision','support_ticket_close','support_access_approve','support_access_revoke','alexa_unlink','heating_sensitive_command','device_sensitive_command']);
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
  if (!object(value) || !hasOnlyKeys(value, ['ok','authorisation']) || value.ok !== true || !object(value.authorisation) || !hasOnlyKeys(value.authorisation, ['id','homeId','membershipId','trustedDeviceId','areaIds','scopes','policyRevision','hubInstallationId','membershipRevision','issuedAt','lanEndpoint'])) return false;
  const row = value.authorisation;
  const hasEnrollmentBinding = ['hubInstallationId','membershipRevision','issuedAt','lanEndpoint'].some((key) => Object.hasOwn(row, key));
  if (hasEnrollmentBinding && (!id(row.hubInstallationId) || !Number.isInteger(row.membershipRevision) || Number(row.membershipRevision) < 0 || !utcTimestamp(row.issuedAt) || !validateCustomerLanEndpoint(row.lanEndpoint))) return false;
  return id(row.id) && id(row.homeId) && id(row.membershipId) && id(row.trustedDeviceId) && Array.isArray(row.areaIds) && row.areaIds.length > 0 && row.areaIds.every(id) && new Set(row.areaIds).size === row.areaIds.length && sameJsonValue(row.scopes, ['tenant:device-command']) && Number.isInteger(row.policyRevision) && Number(row.policyRevision) >= 0;
}

export function validateCustomerLanEndpoint(value: unknown, now = Date.now()): value is CustomerLanEndpoint {
  if (!object(value) || !hasOnlyKeys(value, ['state','origin','publicHubId','certificateGeneration','currentSpkiPin','currentNotBefore','currentNotAfter','nextCertificateGeneration','nextSpkiPin','nextNotBefore','nextNotAfter','reportedAt','validUntil'])
    || value.state !== 'verified_lan' || typeof value.publicHubId !== 'string' || !/^[a-f0-9]{20}$/.test(value.publicHubId)
    || value.origin !== `https://dinodia-${value.publicHubId}.local:8123`
    || !Number.isSafeInteger(value.certificateGeneration) || Number(value.certificateGeneration) < 1
    || typeof value.currentSpkiPin !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.currentSpkiPin)
    || !utcTimestamp(value.currentNotBefore) || !utcTimestamp(value.currentNotAfter) || Date.parse(value.currentNotBefore) >= Date.parse(value.currentNotAfter)
    || !utcTimestamp(value.reportedAt) || !utcTimestamp(value.validUntil) || Date.parse(value.validUntil) <= Date.parse(value.reportedAt)
    || Date.parse(value.reportedAt) > now || now - Date.parse(value.reportedAt) > 420_000 || Date.parse(value.validUntil) <= now
    || Date.parse(value.validUntil) > Date.parse(value.reportedAt) + 420_000
    || Date.parse(value.currentNotBefore) > now || Date.parse(value.currentNotAfter) <= now) return false;
  const next = ['nextCertificateGeneration','nextSpkiPin','nextNotBefore','nextNotAfter'];
  const hasNext = next.some((key) => Object.hasOwn(value, key));
  return !hasNext || next.every((key) => Object.hasOwn(value, key))
    && Number.isSafeInteger(value.nextCertificateGeneration) && Number(value.nextCertificateGeneration) > Number(value.certificateGeneration)
    && typeof value.nextSpkiPin === 'string' && /^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.nextSpkiPin)
    && utcTimestamp(value.nextNotBefore) && utcTimestamp(value.nextNotAfter)
    && Date.parse(value.nextNotAfter) > now
    && Date.parse(value.nextNotBefore) < Date.parse(value.nextNotAfter) && value.nextSpkiPin !== value.currentSpkiPin;
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
export function validateSupportAccessApprovalProjection(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','requests']) && value.ok === true && Array.isArray(value.requests) && value.requests.length <= 100
    && value.requests.every((item) => object(item) && hasOnlyKeys(item, ['requestId','ticketId','publicReference','requestedScope','areaIds','createdAt'])
      && id(item.requestId) && id(item.ticketId) && typeof item.publicReference === 'string' && codePointLength(item.publicReference) >= 1 && codePointLength(item.publicReference) <= 32
      && ['TENANT_SCOPE','PROPERTY_SCOPE'].includes(String(item.requestedScope)) && Array.isArray(item.areaIds) && item.areaIds.length <= 100 && item.areaIds.every(id)
      && new Set(item.areaIds).size === item.areaIds.length && utcTimestamp(item.createdAt));
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
export function validatePublicSupportEmailChallengeRequest(value: unknown): value is PublicSupportEmailChallengeRequest {
  return object(value) && hasOnlyKeys(value, ['replyEmail','category','description'])
    && typeof value.replyEmail === 'string' && /^\S+@\S+\.\S+$/.test(value.replyEmail.trim())
    && value.replyEmail.trim().length <= 320 && supportTicketCategories.has(String(value.category))
    && typeof value.description === 'string' && codePointLength(value.description.trim()) >= 1
    && codePointLength(value.description) <= 4000;
}
export function validatePublicSupportEmailChallengeReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','state','challengeId','expiresAt','emailSubmission'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.state === 'PENDING'
    && id(value.challengeId) && utcTimestamp(value.expiresAt)
    && ['ACCEPTED','FAILED'].includes(String(value.emailSubmission));
}
export function validatePublicSupportEmailVerificationRequest(value: unknown): value is PublicSupportEmailVerificationRequest {
  return object(value) && hasOnlyKeys(value, ['challengeId','code','category','description'])
    && id(value.challengeId) && typeof value.code === 'string' && /^\d{6}$/.test(value.code)
    && supportTicketCategories.has(String(value.category)) && typeof value.description === 'string'
    && codePointLength(value.description.trim()) >= 1 && codePointLength(value.description) <= 4000;
}
export function validatePublicSupportTicketReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['schemaVersion','ok','state','publicReference','idempotentReplay'])
    && value.schemaVersion === DINODIA_V1 && value.ok === true && value.state === 'SUBMITTED'
    && typeof value.publicReference === 'string' && /^DNO-[A-Z0-9]{16}$/.test(value.publicReference)
    && typeof value.idempotentReplay === 'boolean';
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
  return hasOnlyKeys(value, ['approve','confirmation','proof'])
    && ['I approve this support access for my property','I approve this support access for me'].includes(String(value.confirmation))
    && typeof value.proof === 'string' && codePointLength(value.proof) > 0 && codePointLength(value.proof) <= 8192;
}
export function validateSupportAccessDecisionReceipt(value: unknown): boolean {
  if (!object(value) || value.ok !== true || !id(value.requestId)) return false;
  if (value.status === 'DENIED') return hasOnlyKeys(value, ['ok','requestId','status']);
  return value.status === 'APPROVED' && hasOnlyKeys(value, ['ok','requestId','status']);
}
export function validateSupportAccessIssueReceipt(value: unknown): boolean {
  if (!object(value) || !hasOnlyKeys(value, ['ok','requestId','status','oneUseCode','supportUrl','codeExpiresAt']) || value.ok !== true
    || !id(value.requestId) || value.status !== 'ISSUED' || typeof value.oneUseCode !== 'string'
    || !/^DNO-S-[A-Za-z0-9_-]{20,}$/.test(value.oneUseCode) || !utcTimestamp(value.codeExpiresAt)) return false;
  try {
    const url = new URL(String(value.supportUrl));
    return url.protocol === 'https:' && url.pathname === '/support-access' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function validateSupportAccessRevokeRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['confirmation','proof']) &&
    value.confirmation === 'I revoke this support access for my property' &&
    (value.proof === undefined || typeof value.proof === 'string' && codePointLength(value.proof) > 0 && codePointLength(value.proof) <= 8192);
}
export function validateSupportAccessRevokeReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','requestId','status','message']) && value.ok === true &&
    id(value.requestId) && value.status === 'REVOKED' &&
    value.message === 'Property support access revoked — waiting for hub confirmation';
}
export function validateSupportTicketCloseRequest(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['action','proof']) && value.action === 'close' && (value.proof === undefined || typeof value.proof === 'string' && codePointLength(value.proof) > 0 && codePointLength(value.proof) <= 8192);
}
export function validateSupportTicketCloseReceipt(value: unknown): boolean {
  return object(value) && hasOnlyKeys(value, ['ok','ticketId','status','message','hubEnforcement']) && value.ok === true && id(value.ticketId) && value.status === 'CLOSED' && typeof value.message === 'string' && codePointLength(value.message) <= 240 && ['PENDING','ACKNOWLEDGED','EXPIRED','NOT_REQUIRED'].includes(String(value.hubEnforcement));
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
