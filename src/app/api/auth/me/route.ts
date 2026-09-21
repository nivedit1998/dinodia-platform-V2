// Architecture: API boundary /auth/me; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { PolicyKind, Role } from '@prisma/client';
import { getHomeownerPolicyStatus } from '@/lib/homeownerPolicy';
import { getUserPolicyStatus } from '@/lib/policyAcceptance';
import { prisma } from '@/lib/prisma';
import { PRIVACY_NOTICE_VERSION, TERMS_VERSION } from '@/lib/policyVersions';
import { logServerError } from '@/lib/serverErrorLog';

export async function GET(req: NextRequest) {
  const user = await getCurrentUserFromRequest(req);
  if (!user) return NextResponse.json({ user: null });
  if (user.role !== Role.ADMIN) {
    return NextResponse.json({ user });
  }
  const policy = await getHomeownerPolicyStatus(user.id);

  if (policy?.requiresAcceptance === false) {
    try {
      const status = await getUserPolicyStatus(user.id);
      const needsPrivacy = !status.privacyAccepted;
      const needsTerms = !status.termsAccepted;
      if (needsPrivacy || needsTerms) {
        await Promise.all([
          needsPrivacy
            ? prisma.policyAcceptance.upsert({
                where: {
                  userId_policyKind_policyVersion: {
                    userId: user.id,
                    policyKind: PolicyKind.PRIVACY_NOTICE,
                    policyVersion: PRIVACY_NOTICE_VERSION,
                  },
                },
                update: {},
                create: {
                  userId: user.id,
                  policyKind: PolicyKind.PRIVACY_NOTICE,
                  policyVersion: PRIVACY_NOTICE_VERSION,
                },
              })
            : Promise.resolve(),
          needsTerms
            ? prisma.policyAcceptance.upsert({
                where: {
                  userId_policyKind_policyVersion: {
                    userId: user.id,
                    policyKind: PolicyKind.TERMS,
                    policyVersion: TERMS_VERSION,
                  },
                },
                update: {},
                create: {
                  userId: user.id,
                  policyKind: PolicyKind.TERMS,
                  policyVersion: TERMS_VERSION,
                },
              })
            : Promise.resolve(),
        ]);
      }
    } catch (err) {
      logServerError('[api/auth/me] policy acceptance auto-upsert failed', err);
    }
  }

  return NextResponse.json({
    user,
    requiresHomeownerPolicyAcceptance: policy?.requiresAcceptance ?? true,
    homeownerPolicyVersion: policy?.policyVersion ?? '2026-V1',
    pendingOnboardingId: policy?.pendingOnboardingId ?? null,
  });
}
