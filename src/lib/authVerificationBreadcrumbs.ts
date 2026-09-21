// Architecture: Shared platform helper src/lib/authVerificationBreadcrumbs.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
'use client';

export type VerificationCompletionStatus = 'COMPLETED' | 'ALREADY_COMPLETED' | string;

type VerificationBreadcrumbDetails = {
  challengeId: string;
  source: string;
  completionStatus?: VerificationCompletionStatus | null;
  reason?: string | null;
};

export function logVerificationConsumedAfterApprovalBreadcrumb(
  details: VerificationBreadcrumbDetails
) {
  console.info('[emailVerification] consumed after approval', {
    challengeId: details.challengeId,
    source: details.source,
    completionStatus: details.completionStatus ?? null,
    reason: details.reason ?? null,
  });
}

export function logVerificationCompletionStatusBreadcrumb(
  details: VerificationBreadcrumbDetails
) {
  if (details.completionStatus !== 'ALREADY_COMPLETED') return;
  console.info('[emailVerification] idempotent completion after approval', {
    challengeId: details.challengeId,
    source: details.source,
    completionStatus: details.completionStatus,
  });
}
