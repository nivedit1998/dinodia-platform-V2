// Architecture: Shared platform helper src/lib/policyVersions.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export const PRIVACY_NOTICE_VERSION =
  process.env.PRIVACY_NOTICE_VERSION?.trim() || '2026-06-02-V1';

export const TERMS_VERSION =
  process.env.TERMS_VERSION?.trim() || '2026-06-02-V1';

export const PRIVACY_NOTICE_LAST_UPDATED = '2026-06-02';
export const TERMS_LAST_UPDATED = '2026-06-02';
