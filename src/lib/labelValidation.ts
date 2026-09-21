// Architecture: Shared platform helper src/lib/labelValidation.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export const OTHER_LABEL_ERROR = 'Label cannot be Other, please be more specific';

export function isReservedOtherLabel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'other';
}
