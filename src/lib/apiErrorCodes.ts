// Architecture: Shared platform helper src/lib/apiErrorCodes.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export const APP_ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  DEVICE_NOT_TRUSTED: 'DEVICE_NOT_TRUSTED',
  HA_UNAVAILABLE: 'HA_UNAVAILABLE',
  DINODIA_CLOUD_UNAVAILABLE: 'DINODIA_CLOUD_UNAVAILABLE',
  INTEGRATION_ERROR: 'INTEGRATION_ERROR',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[keyof typeof APP_ERROR_CODES];

export function inferAppErrorCode(status: number): AppErrorCode {
  if (status === 400) return APP_ERROR_CODES.INVALID_INPUT;
  if (status === 401) return APP_ERROR_CODES.UNAUTHORIZED;
  if (status === 403) return APP_ERROR_CODES.FORBIDDEN;
  if (status === 404) return APP_ERROR_CODES.NOT_FOUND;
  if (status === 409) return APP_ERROR_CODES.CONFLICT;
  if (status === 422) return APP_ERROR_CODES.VALIDATION_FAILED;
  if (status === 429) return APP_ERROR_CODES.RATE_LIMITED;
  if (status >= 500) return APP_ERROR_CODES.INTERNAL_ERROR;
  return APP_ERROR_CODES.INTERNAL_ERROR;
}

export const APP_ERROR_MESSAGES = {
  DINODIA_HUB_UNAVAILABLE: 'Dinodia Hub unavailable. Please refresh and try again.',
  DINODIA_CLOUD_UNAVAILABLE: 'Dinodia Cloud unavailable. Please refresh and try again.',
  REFRESH_AND_RETRY: 'Please refresh and try again.',
} as const;
