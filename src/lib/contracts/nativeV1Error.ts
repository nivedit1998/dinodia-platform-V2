import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

type BoundedFailure = { status?: unknown; code?: unknown; message?: unknown };

const CODE_BY_STAGE1_ERROR: Record<string, string> = {
  customer_session_required: 'AUTH_REQUIRED',
  customer_session_invalid: 'TOKEN_EXPIRED',
  customer_access_token_expired: 'CUSTOMER_ACCESS_EXPIRED',
  customer_credentials_invalid: 'AUTH_REQUIRED',
  app_token_invalid: 'AUTH_REQUIRED',
  membership_invalid: 'TOKEN_EXPIRED',
  employee_session_invalid: 'AUTH_REQUIRED',
  employee_session_revoked: 'TOKEN_EXPIRED',
  employee_session_expired: 'TOKEN_EXPIRED',
  recent_authentication_required: 'STEP_UP_REQUIRED',
  area_policy_stale: 'UPDATE_REQUIRED',
  policy_stale: 'UPDATE_REQUIRED',
  claim_policy_required: 'UPDATE_REQUIRED',
  claim_policy_stale: 'UPDATE_REQUIRED',
  claim_address_confirmation_required: 'REVISION_CONFLICT',
  claim_reservation_expired: 'RESOURCE_NOT_FOUND',
  claim_unavailable: 'RESOURCE_NOT_FOUND',
  policy_unavailable: 'FEATURE_NOT_ENABLED',
  customer_policy_unavailable: 'FEATURE_NOT_ENABLED',
  customer_policy_acceptance_required: 'UPDATE_REQUIRED',
  trusted_device_revoked: 'AUTH_REQUIRED',
  trusted_device_identity_changed: 'SCOPE_DENIED',
  employee_role_denied: 'SCOPE_DENIED',
  home_membership_forbidden: 'SCOPE_DENIED',
  home_hub_unavailable: 'HUB_UNAVAILABLE',
  hub_not_available: 'HUB_UNAVAILABLE',
  app_auth_unconfigured: 'HUB_UNAVAILABLE',
  internal_error: 'INTERNAL_ERROR',
};

const DINODIA_V1_CODES = new Set([
  'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'CUSTOMER_ACCESS_EXPIRED', 'STEP_UP_REQUIRED', 'STEP_UP_FAILED', 'SCOPE_DENIED',
  'EMAIL_VERIFICATION_REQUIRED', 'ROOM_ACCESS_HOME_NOT_READY',
  'HOME_MISMATCH', 'AREA_DENIED', 'NOT_DEVICE_OWNER', 'PERMANENT_DEVICE_IMMUTABLE',
  'RESOURCE_NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'FINAL_RELATIONSHIP_CONFIRMATION_REQUIRED', 'CATALOG_REVISION_MISMATCH', 'CONTROL_REMOVED',
  'VALIDATION_FAILED', 'DEVICE_OFFLINE', 'CONTROL_UNAVAILABLE', 'COMMAND_UNCERTAIN',
  'HUB_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY', 'UPDATE_REQUIRED', 'RATE_LIMITED',
  'PAIRING_NOT_ADVERTISED', 'PAIRING_EXPIRED', 'PAIRING_USED', 'HARDWARE_IDENTITY_INVALID',
  'PAIRING_PROOF_FAILED', 'CLOUDURL_NOT_REPORTED', 'CLOUDURL_UNVERIFIED',
  'TUNNEL_IDENTITY_MISMATCH', 'SUPPORT_TICKET_CLOSED', 'SUPPORT_APPROVAL_REQUIRED',
  'SUPPORT_CODE_EXPIRED', 'SUPPORT_CODE_USED', 'SUPPORT_EMPLOYEE_MISMATCH',
  'SUPPORT_SCOPE_CHANGED', 'SUPPORT_REMOTE_UNAVAILABLE', 'FEATURE_NOT_ENABLED', 'INTERNAL_ERROR',
  'AUTOMATION_INVALID', 'AUTOMATION_TRIGGER_INVALID', 'AUTOMATION_ACTIONS_INVALID', 'AUTOMATION_ACTION_INVALID',
  'AUTOMATION_ACTION_DUPLICATE', 'AUTOMATION_SCOPE_DENIED', 'AUTOMATION_DESCRIPTOR_STALE',
  'AUTOMATION_CONTROL_APP_ONLY', 'AUTOMATION_CONTROL_UNAVAILABLE', 'AUTOMATION_CONFLICT',
  'AUTOMATION_NOT_FOUND', 'AUTOMATION_REVISION_CONFLICT', 'AUTOMATION_IDEMPOTENCY_CONFLICT',
]);

function normalizedStatus(value: unknown): number {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function canonicalCode(failure: BoundedFailure, status: number): string {
  const source = String(failure.code ?? '').trim();
  if (DINODIA_V1_CODES.has(source)) return source;
  const mapped = CODE_BY_STAGE1_ERROR[source];
  if (mapped) return mapped;
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'SCOPE_DENIED';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 409) return 'REVISION_CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'HUB_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_FAILED';
}

/** The sole Native V1 Platform error envelope. Stage 1's legacy responder is
 * intentionally unchanged; only routes under /api/v2 use this boundary. */
export function nativeV1ErrorResponse(error: unknown, diagnostic?: {
  operation: string; phase: string; startedAt: number;
}): NextResponse {
  const failure = error && typeof error === 'object' ? error as BoundedFailure : {};
  const status = normalizedStatus(failure.status);
  const code = canonicalCode(failure, status);
  const message = status >= 500 && code === 'INTERNAL_ERROR'
    ? 'The request could not be completed'
    : String(failure.message ?? 'The request could not be completed').trim().slice(0, 240);
  const requestId = crypto.randomUUID();
  if (status >= 500 && diagnostic) {
    const record = error && typeof error === 'object'
      ? error as { name?: unknown; code?: unknown; meta?: { code?: unknown; sqlState?: unknown; sqlstate?: unknown } }
      : {};
    const errorName = String(record.name ?? 'Error').slice(0, 48).replace(/[^A-Za-z0-9_.-]/g, '');
    const prismaCode = String(record.code ?? '').match(/^P\d{4}$/)?.[0] ?? null;
    const sqlStateValue = record.meta?.code ?? record.meta?.sqlState ?? record.meta?.sqlstate;
    const sqlState = typeof sqlStateValue === 'string' && /^[0-9A-Z]{5}$/.test(sqlStateValue) ? sqlStateValue : null;
    console.error('[native-v1-management-failure]', JSON.stringify({
      requestId, operation: diagnostic.operation, phase: diagnostic.phase,
      elapsedMs: Math.max(0, Math.min(600_000, Date.now() - diagnostic.startedAt)),
      errorName, prismaCode, sqlState,
    }));
  }
  const retryable = code === 'HUB_UNAVAILABLE' || code === 'RATE_LIMITED' || code === 'INTERNAL_ERROR';
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
  return NextResponse.json({ error: { code, message, requestId, retryable } }, {
    status,
    headers,
  });
}
