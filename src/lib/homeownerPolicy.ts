// Architecture: Shared platform helper src/lib/homeownerPolicy.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { AuditEventType, HomeownerPolicyAcceptance, Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const DEFAULT_HOMEOWNER_POLICY_VERSION = '2026-V1';

export const HOMEOWNER_POLICY_VERSION =
  process.env.HOMEOWNER_POLICY_VERSION?.trim() || DEFAULT_HOMEOWNER_POLICY_VERSION;

export type HomeownerPolicyAddressInput = {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state?: string | null;
  postcode: string;
  country: string;
};

export type HomeownerPolicyAcceptanceInput = {
  userId: number;
  signatureName: string;
  acceptedStatements: Prisma.InputJsonValue;
  address: HomeownerPolicyAddressInput;
  approvedSupportContacts?: Prisma.InputJsonValue | null;
  notificationPreference?: string | null;
  ipHash?: string | null;
  deviceFingerprintHash?: string | null;
  pendingOnboardingId?: string | null;
};

export function requiresHomeownerPolicyAcceptance(user: {
  role: Role;
  homeownerPolicyAcceptedVersion?: string | null;
}) {
  if (user.role !== Role.ADMIN) return false;
  return user.homeownerPolicyAcceptedVersion !== HOMEOWNER_POLICY_VERSION;
}

export async function getHomeownerPolicyStatus(userId: number) {
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      homeId: true,
      emailVerifiedAt: true,
      homeownerPolicyAcceptedVersion: true,
      homeownerPolicyAcceptedAt: true,
    },
  });

  if (!user) return null;

  const requiresAcceptance = requiresHomeownerPolicyAcceptance(user);
  const currentAcceptance =
    user.role === Role.ADMIN
      ? await prisma.homeownerPolicyAcceptance.findUnique({
          where: {
            homeownerUserId_policyVersion: {
              homeownerUserId: user.id,
              policyVersion: HOMEOWNER_POLICY_VERSION,
            },
          },
          select: {
            id: true,
            policyVersion: true,
            acceptedAt: true,
            signatureName: true,
            addressReference: true,
          },
        })
      : null;

  const pending =
    user.role === Role.ADMIN
      ? await prisma.pendingHomeownerOnboarding.findFirst({
          where: {
            userId: user.id,
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            homeId: true,
            emailVerifiedAt: true,
            policyAcceptedAt: true,
            expiresAt: true,
          },
        })
      : null;

  return {
    policyVersion: HOMEOWNER_POLICY_VERSION,
    requiresAcceptance,
    emailVerified: Boolean(user.emailVerifiedAt),
    homeId: user.homeId ?? pending?.homeId ?? null,
    acceptedVersion: user.homeownerPolicyAcceptedVersion ?? null,
    acceptedAt: user.homeownerPolicyAcceptedAt ?? currentAcceptance?.acceptedAt ?? null,
    currentAcceptance,
    pendingOnboardingId: pending?.id ?? null,
    pendingEmailVerifiedAt: pending?.emailVerifiedAt ?? null,
    pendingPolicyAcceptedAt: pending?.policyAcceptedAt ?? null,
    pendingExpiresAt: pending?.expiresAt ?? null,
  };
}

export async function recordHomeownerPolicyAcceptance(input: HomeownerPolicyAcceptanceInput): Promise<{
  created: boolean;
  acceptance: HomeownerPolicyAcceptance;
  homeId: number;
  pendingOnboardingId: string | null;
}> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        role: true,
        username: true,
        homeId: true,
        emailVerifiedAt: true,
      },
    });

    if (!user || user.role !== Role.ADMIN) {
      throw new Error('Homeowner policy acceptance is only allowed for admin users.');
    }
    if (!user.emailVerifiedAt) {
      throw new Error('Email verification is required before accepting the homeowner policy.');
    }

    const existing = await tx.homeownerPolicyAcceptance.findUnique({
      where: {
        homeownerUserId_policyVersion: {
          homeownerUserId: user.id,
          policyVersion: HOMEOWNER_POLICY_VERSION,
        },
      },
    });

    if (existing) {
      return {
        created: false,
        acceptance: existing,
        homeId: existing.homeId,
        pendingOnboardingId: input.pendingOnboardingId ?? null,
      };
    }

    const now = new Date();
    const pending = input.pendingOnboardingId
      ? await tx.pendingHomeownerOnboarding.findFirst({
          where: {
            id: input.pendingOnboardingId,
            userId: user.id,
            expiresAt: { gt: now },
          },
          select: {
            id: true,
            homeId: true,
            hubInstallId: true,
            emailVerifiedAt: true,
          },
        })
      : await tx.pendingHomeownerOnboarding.findFirst({
          where: {
            userId: user.id,
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            homeId: true,
            hubInstallId: true,
            emailVerifiedAt: true,
          },
        });

    let homeId = user.homeId ?? pending?.homeId ?? null;

    if (!homeId && pending?.hubInstallId) {
      const hubInstall = await tx.hubInstall.findUnique({
        where: { id: pending.hubInstallId },
        select: { homeId: true },
      });
      homeId = hubInstall?.homeId ?? null;
    }

    if (!homeId) {
      throw new Error('No home is available for homeowner policy acceptance.');
    }

    await tx.home.update({
      where: { id: homeId },
      data: {
        addressLine1: input.address.addressLine1,
        addressLine2: input.address.addressLine2?.trim() || null,
        city: input.address.city,
        state: input.address.state?.trim() || null,
        postcode: input.address.postcode,
        country: input.address.country,
      },
    });

    const addressReference = [
      input.address.addressLine1,
      input.address.addressLine2?.trim() || null,
      input.address.city,
      input.address.state?.trim() || null,
      input.address.postcode,
      input.address.country,
    ]
      .filter((part) => Boolean(part && String(part).trim().length > 0))
      .join(', ');

    const acceptance = await tx.homeownerPolicyAcceptance.create({
      data: {
        homeId,
        homeownerUserId: user.id,
        policyVersion: HOMEOWNER_POLICY_VERSION,
        signatureName: input.signatureName,
        acceptedStatements: input.acceptedStatements,
        addressReference,
        approvedSupportContacts: input.approvedSupportContacts ?? undefined,
        notificationPreference: input.notificationPreference ?? null,
        ipHash: input.ipHash ?? null,
        deviceFingerprintHash: input.deviceFingerprintHash ?? null,
      },
    });

    await tx.user.update({
      where: { id: user.id },
      data: {
        homeownerPolicyAcceptedVersion: HOMEOWNER_POLICY_VERSION,
        homeownerPolicyAcceptedAt: acceptance.acceptedAt,
      },
    });

    if (pending?.id) {
      await tx.pendingHomeownerOnboarding.update({
        where: { id: pending.id },
        data: {
          policyAcceptedAt: acceptance.acceptedAt,
          homeId,
        },
      });
    }

    await tx.auditEvent.create({
      data: {
        type: AuditEventType.HOMEOWNER_POLICY_ACCEPTED,
        homeId,
        actorUserId: user.id,
        metadata: {
          policyVersion: HOMEOWNER_POLICY_VERSION,
          acceptanceId: acceptance.id,
          pendingOnboardingId: pending?.id ?? null,
        },
      },
    });

    return {
      created: true,
      acceptance,
      homeId,
      pendingOnboardingId: pending?.id ?? null,
    };
  });
}
