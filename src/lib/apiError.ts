// Architecture: Shared platform helper src/lib/apiError.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { NextResponse } from 'next/server';
import { APP_ERROR_CODES, APP_ERROR_MESSAGES, inferAppErrorCode, type AppErrorCode } from '@/lib/apiErrorCodes';

type Extras = Record<string, unknown>;

type UnknownErrorLike = {
  message?: unknown;
  code?: unknown;
};

function toSafeMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return fallback;
  if (trimmed.includes('<html') || trimmed.includes('<!doctype')) return fallback;
  return trimmed;
}

function toLowerMessage(err: unknown): string {
  const raw = (err as UnknownErrorLike)?.message;
  if (typeof raw === 'string') return raw.toLowerCase();
  return String(err ?? '').toLowerCase();
}

function isHubUnavailable(err: unknown): boolean {
  const raw = toLowerMessage(err);
  return (
    raw.includes('dinodia hub did not respond') ||
    raw.includes('ha api timeout') ||
    raw.includes('ha template timeout') ||
    raw.includes('ha ws timeout') ||
    raw.includes('home assistant') ||
    raw.includes('cloudflare tunnel error') ||
    raw.includes('econnrefused') ||
    raw.includes('etimedout')
  );
}

function isCloudUnavailable(err: unknown): boolean {
  const raw = toLowerMessage(err);
  return (
    raw.includes('failed to fetch') ||
    raw.includes('network') ||
    raw.includes('fetch failed') ||
    raw.includes('timed out') ||
    raw.includes('timeout')
  );
}

export function apiFail(status: number, errorCode: AppErrorCode, error: string, extras: Extras = {}) {
  return NextResponse.json({ ok: false, errorCode, error, ...extras }, { status });
}

export function apiFailFromStatus(status: number, error: string, extras: Extras = {}) {
  return apiFail(status, inferAppErrorCode(status), error, extras);
}

export function apiFailPayload(
  status: number,
  payload: { error: string } & Extras
) {
  const { error, ...extras } = payload;
  return apiFailFromStatus(status, error, extras);
}

export function apiUnauthorized(error = 'Your session has ended. Please sign in again.', extras: Extras = {}) {
  return apiFail(401, APP_ERROR_CODES.UNAUTHORIZED, error, extras);
}

export function apiForbidden(error = 'You are not allowed to do that.', extras: Extras = {}) {
  return apiFail(403, APP_ERROR_CODES.FORBIDDEN, error, extras);
}

export function apiNotFound(error = 'Not found.', extras: Extras = {}) {
  return apiFail(404, APP_ERROR_CODES.NOT_FOUND, error, extras);
}

export function apiBadRequest(error = 'Invalid request. Please try again.', extras: Extras = {}) {
  return apiFail(400, APP_ERROR_CODES.INVALID_INPUT, error, extras);
}

export function apiConflict(error = 'This request conflicts with the current state.', extras: Extras = {}) {
  return apiFail(409, APP_ERROR_CODES.CONFLICT, error, extras);
}

export function apiInternal(error = 'Something went wrong. Please refresh and try again.', extras: Extras = {}) {
  return apiFail(500, APP_ERROR_CODES.INTERNAL_ERROR, error, extras);
}

export function mapUnknownToApiError(
  err: unknown,
  fallbackMessage: string,
  status = 500,
  fallbackCode?: AppErrorCode
): { status: number; errorCode: AppErrorCode; error: string } {
  if (isHubUnavailable(err)) {
    return {
      status,
      errorCode: APP_ERROR_CODES.HA_UNAVAILABLE,
      error: APP_ERROR_MESSAGES.DINODIA_HUB_UNAVAILABLE,
    };
  }

  if (isCloudUnavailable(err)) {
    return {
      status,
      errorCode: APP_ERROR_CODES.DINODIA_CLOUD_UNAVAILABLE,
      error: APP_ERROR_MESSAGES.DINODIA_CLOUD_UNAVAILABLE,
    };
  }

  const safeFallback = toSafeMessage(fallbackMessage, 'Something went wrong. Please refresh and try again.');
  return {
    status,
    errorCode: fallbackCode ?? inferAppErrorCode(status),
    error: safeFallback,
  };
}
