// Architecture: Shared platform helper src/lib/authClientError.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { friendlyMessageForCode, friendlyUnknownError, parseClientApiError } from '@/lib/clientError';

export function friendlyAuthError(errorCode: string | undefined, fallbackMessage: string): string {
  return friendlyMessageForCode(errorCode, fallbackMessage);
}

export function parseApiError(data: unknown, fallbackMessage: string): { errorCode?: string; message: string } {
  return parseClientApiError(data, fallbackMessage);
}

export function friendlyErrorFromUnknown(error: unknown, fallbackMessage: string): string {
  return friendlyUnknownError(error, fallbackMessage);
}
