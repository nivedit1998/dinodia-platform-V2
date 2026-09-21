// Architecture: Shared platform helper src/lib/clientError.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { AUTH_ERROR_CODES } from '@/lib/authErrorCodes';
import { APP_ERROR_CODES } from '@/lib/apiErrorCodes';

export type ClientApiErrorPayload = {
  ok?: unknown;
  error?: unknown;
  errorCode?: unknown;
  message?: unknown;
};

export class ClientApiError extends Error {
  status: number;
  errorCode?: string;
  payload?: unknown;

  constructor(message: string, status: number, errorCode?: string, payload?: unknown) {
    super(message);
    this.name = 'ClientApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.payload = payload;
  }
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shouldMaskRawMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.startsWith('{') ||
    lower.startsWith('[') ||
    lower.includes('<html') ||
    lower.includes('<!doctype') ||
    lower.includes('stack') ||
    lower.includes('exception')
  );
}

export function friendlyMessageForCode(errorCode: string | undefined, fallbackMessage: string): string {
  const code = (errorCode ?? '').trim();
  switch (code) {
    case AUTH_ERROR_CODES.USERNAME_NOT_FOUND:
      return "This username doesn't exist. Ask your homeowner to create it first.";
    case AUTH_ERROR_CODES.INVALID_PASSWORD:
      return 'That password is incorrect. Please try again.';
    case AUTH_ERROR_CODES.EMAIL_NOT_UNIQUE:
      return 'Multiple accounts use this email. Please sign in with your username instead.';
    case AUTH_ERROR_CODES.ROLE_MISMATCH:
      return fallbackMessage || 'Please use the correct login type for this account.';
    case AUTH_ERROR_CODES.INVALID_LOGIN_INPUT:
      return fallbackMessage || 'Please check your details and try again.';
    case AUTH_ERROR_CODES.RATE_LIMITED:
      return 'Too many attempts. Please wait a moment and try again.';
    case AUTH_ERROR_CODES.DEVICE_REQUIRED:
      return "We couldn't verify this device. Please refresh and try again.";
    case AUTH_ERROR_CODES.EMAIL_REQUIRED:
      return 'Please enter your email to continue.';
    case AUTH_ERROR_CODES.EMAIL_INVALID:
      return 'Please enter a valid email address.';
    case AUTH_ERROR_CODES.TENANT_EMAIL_MISMATCH:
      return "Email doesn’t match the tenant created.";
    case AUTH_ERROR_CODES.VERIFICATION_REQUIRED:
      return 'Email verification is required to continue.';
    case AUTH_ERROR_CODES.VERIFICATION_FAILED:
      return "We couldn't complete verification. Please refresh and try again.";
    case AUTH_ERROR_CODES.REGISTRATION_BLOCKED:
      return fallbackMessage || 'Setup is not available right now. Please try again.';
    case AUTH_ERROR_CODES.CLAIM_INVALID:
      return fallbackMessage || "We couldn't validate this claim. Please check the code and try again.";
    case AUTH_ERROR_CODES.INTERNAL_ERROR:
      return fallbackMessage || 'Something went wrong. Please refresh and try again.';
    case APP_ERROR_CODES.UNAUTHORIZED:
      return 'Your session has ended. Please sign in again.';
    case APP_ERROR_CODES.FORBIDDEN:
      return 'You are not allowed to do that.';
    case APP_ERROR_CODES.NOT_FOUND:
      return 'We could not find what you requested.';
    case APP_ERROR_CODES.INVALID_INPUT:
    case APP_ERROR_CODES.VALIDATION_FAILED:
      return fallbackMessage;
    case APP_ERROR_CODES.RATE_LIMITED:
      return 'Too many requests. Please wait and try again.';
    case APP_ERROR_CODES.DEVICE_NOT_TRUSTED:
      return "This device isn't trusted. Please sign in again.";
    case APP_ERROR_CODES.HA_UNAVAILABLE:
      return 'Dinodia Hub unavailable. Please refresh and try again.';
    case APP_ERROR_CODES.DINODIA_CLOUD_UNAVAILABLE:
      return 'Dinodia Cloud unavailable. Please refresh and try again.';
    case APP_ERROR_CODES.CONFLICT:
      return fallbackMessage || 'That action conflicts with the current state. Please refresh and try again.';
    case APP_ERROR_CODES.INTERNAL_ERROR:
    case APP_ERROR_CODES.INTEGRATION_ERROR:
      return fallbackMessage || 'Something went wrong. Please refresh and try again.';
    default:
      return fallbackMessage;
  }
}

export function parseClientApiError(
  payload: unknown,
  fallbackMessage: string,
  status?: number
): { errorCode?: string; message: string } {
  const objectPayload = payload && typeof payload === 'object' ? (payload as ClientApiErrorPayload) : undefined;
  const errorCode = toStringOrEmpty(objectPayload?.errorCode) || undefined;
  const rawError = toStringOrEmpty(objectPayload?.error) || toStringOrEmpty(objectPayload?.message);

  let fallback = fallbackMessage;
  if ((!fallback || !fallback.trim()) && typeof status === 'number') {
    if (status === 401) fallback = 'Your session has ended. Please sign in again.';
    else if (status === 403) fallback = 'You are not allowed to do that.';
    else if (status === 404) fallback = 'We could not find what you requested.';
    else if (status === 429) fallback = 'Too many requests. Please wait and try again.';
    else if (status >= 500) fallback = 'Something went wrong. Please refresh and try again.';
    else fallback = 'Request failed. Please refresh and try again.';
  }

  const safeRaw = rawError && !shouldMaskRawMessage(rawError) ? rawError : '';
  const message = friendlyMessageForCode(errorCode, safeRaw || fallback);
  return { errorCode, message: message || fallback || 'Request failed. Please refresh and try again.' };
}

export function friendlyUnknownError(error: unknown, fallbackMessage: string): string {
  if (!error) return fallbackMessage;

  if (error instanceof ClientApiError) {
    return error.message || fallbackMessage;
  }

  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  if (!trimmed) return fallbackMessage;

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parseClientApiError(parsed, fallbackMessage).message;
    } catch {
      return fallbackMessage;
    }
  }

  if (/network|failed to fetch|timeout|timed out/i.test(trimmed.toLowerCase())) {
    return 'Dinodia Hub unavailable. Please refresh and try again.';
  }

  if (shouldMaskRawMessage(trimmed)) {
    return fallbackMessage;
  }

  return trimmed;
}
