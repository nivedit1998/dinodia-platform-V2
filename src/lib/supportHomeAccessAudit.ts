// Architecture: Shared platform helper src/lib/supportHomeAccessAudit.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { AuditEventType, SupportApprovalRecipientType } from '@prisma/client';

export function buildSupportAuditMetadata(input: {
  supportRequestId: string;
  homeId: number;
  actorUserId?: number | null;
  actorUsername?: string | null;
  approvalRecipientType?: SupportApprovalRecipientType | null;
  approvalRecipientEmail?: string | null;
  approvalRecipientName?: string | null;
  failureCode?: string | null;
  hostname?: string | null;
  sessionExpiresAt?: Date | null;
  reason?: string | null;
  extra?: Record<string, unknown>;
}) {
  return {
    supportRequestId: input.supportRequestId,
    homeId: input.homeId,
    actorUserId: input.actorUserId ?? null,
    actorUsername: input.actorUsername ?? null,
    approvalRecipientType: input.approvalRecipientType ?? null,
    approvalRecipientEmail: input.approvalRecipientEmail ?? null,
    approvalRecipientName: input.approvalRecipientName ?? null,
    failureCode: input.failureCode ?? null,
    hostname: input.hostname ?? null,
    sessionExpiresAt: input.sessionExpiresAt?.toISOString() ?? null,
    reason: input.reason ?? null,
    ...(input.extra ?? {}),
  };
}

export function supportAuditSummary(type: AuditEventType) {
  switch (type) {
    case AuditEventType.SUPPORT_REQUEST_CREATED:
      return 'Remote HA access requested';
    case AuditEventType.SUPPORT_REQUEST_APPROVED:
      return 'Remote HA access approved';
    case AuditEventType.SUPPORT_REQUEST_REVOKED:
      return 'Remote HA access revoked';
    case AuditEventType.SUPPORT_HA_CODE_ISSUED:
      return 'One-time HASecurityCode issued after approval';
    case AuditEventType.SUPPORT_HA_CODE_CONSUMED:
      return 'One-time HASecurityCode consumed and Dinodia hub launch started';
    case AuditEventType.SUPPORT_HA_SESSION_STARTED:
      return 'HA support session started after bootstrap confirmation';
    case AuditEventType.SUPPORT_HA_SESSION_FAILED:
      return 'HA support session failed and approval must be requested again';
    case AuditEventType.SUPPORT_HA_SESSION_EXPIRED:
      return 'HA support session expired';
    default:
      return 'Support event';
  }
}
