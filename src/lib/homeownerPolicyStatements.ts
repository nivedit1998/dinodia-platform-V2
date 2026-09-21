// Architecture: Shared platform helper src/lib/homeownerPolicyStatements.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export const HOMEOWNER_POLICY_STATEMENTS = [
  {
    key: 'managed_platform_understanding',
    text: 'I understand Dinodia provides a homeowner/tenant-managed smart-home platform.',
  },
  {
    key: 'default_no_ongoing_installer_access',
    text: 'I acknowledge Dinodia and its installers do not have ongoing access to my home data by default.',
  },
  {
    key: 'support_access_requires_explicit_approval',
    text: 'I agree that any installer support access must be explicitly approved by me, is time-limited, and can be revoked by me at any time.',
  },
  {
    key: 'audit_trail_understanding',
    text: 'I understand Dinodia maintains an audit trail of support access requests and actions for security and accountability.',
  },
  {
    key: 'limited_processing_consent',
    text: 'I consent to Dinodia processing my data only as required to operate, secure, and support my smart-home service under this policy.',
  },
] as const;

export type HomeownerPolicyStatementKey = (typeof HOMEOWNER_POLICY_STATEMENTS)[number]['key'];

export function getRequiredHomeownerPolicyStatementKeys(): HomeownerPolicyStatementKey[] {
  return HOMEOWNER_POLICY_STATEMENTS.map((item) => item.key);
}
