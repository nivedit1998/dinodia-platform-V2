// Architecture: Shared platform helper src/lib/policyAcceptance.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { PolicyKind, type PolicyAcceptance } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { PRIVACY_NOTICE_VERSION, TERMS_VERSION } from '@/lib/policyVersions';

export type UserPolicyStatus = {
  privacyVersion: string;
  termsVersion: string;
  privacyAccepted: boolean;
  termsAccepted: boolean;
  privacyAcceptedAt: Date | null;
  termsAcceptedAt: Date | null;
};

async function findAcceptance(userId: number, kind: PolicyKind, version: string): Promise<PolicyAcceptance | null> {
  return prisma.policyAcceptance.findUnique({
    where: {
      userId_policyKind_policyVersion: {
        userId,
        policyKind: kind,
        policyVersion: version,
      },
    },
  });
}

export async function getUserPolicyStatus(userId: number): Promise<UserPolicyStatus> {
  const [privacy, terms] = await Promise.all([
    findAcceptance(userId, PolicyKind.PRIVACY_NOTICE, PRIVACY_NOTICE_VERSION),
    findAcceptance(userId, PolicyKind.TERMS, TERMS_VERSION),
  ]);

  return {
    privacyVersion: PRIVACY_NOTICE_VERSION,
    termsVersion: TERMS_VERSION,
    privacyAccepted: Boolean(privacy),
    termsAccepted: Boolean(terms),
    privacyAcceptedAt: privacy?.acceptedAt ?? null,
    termsAcceptedAt: terms?.acceptedAt ?? null,
  };
}
