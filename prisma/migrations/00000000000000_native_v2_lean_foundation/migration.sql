-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED');

-- CreateEnum
CREATE TYPE "EmployeeRole" AS ENUM ('CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER', 'SENIOR_CUSTOMER_SUPPORT');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "HomeLifecycle" AS ENUM ('INSTALLING', 'CLAIMABLE', 'CLAIM_RESERVED', 'PENDING_INSTALLATION', 'ACTIVE', 'TRANSFER_PENDING', 'UNOWNED', 'DEREGISTRATION_PENDING', 'WAITING_FOR_HUB_CLEANUP', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "AddressStatus" AS ENUM ('NOT_PROVIDED', 'PENDING_CLAIM', 'VERIFIED', 'STAFF_CORRECTED');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETE', 'REOPENED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'PROPERTY_MANAGER', 'TENANT');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'REMOVAL_PENDING', 'REMOVED');

-- CreateEnum
CREATE TYPE "AreaStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "DeviceManagementClass" AS ENUM ('PROPERTY_DEVICE', 'TENANT_DEVICE');

-- CreateEnum
CREATE TYPE "DeviceAnalyticsCategory" AS ENUM ('NONE', 'LIGHT', 'BOILER', 'RADIATOR');

-- CreateEnum
CREATE TYPE "DeviceOnlineState" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DeviceLifecycleState" AS ENUM ('DISCOVERED', 'INSTALLED', 'VIEW_ONLY', 'RETIRED', 'REMOVAL_PENDING', 'REMOVED');

-- CreateEnum
CREATE TYPE "CompanyWorkKind" AS ENUM ('INITIAL_HUB_INSTALLATION', 'PHYSICAL_CONFIGURATION_CORRECTION', 'HUB_RECOVERY');

-- CreateEnum
CREATE TYPE "CompanyWorkState" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'REOPENED');

-- CreateEnum
CREATE TYPE "HubIdentityStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "HubLifecycleState" AS ENUM ('PAIRING', 'PROVISIONED', 'MAINTENANCE', 'DEREGISTRATION_PENDING', 'WAITING_FOR_CLEANUP', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "HubCredentialState" AS ENUM ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'ACTIVE', 'GRACE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ProvisioningState" AS ENUM ('CREATED', 'PRESENTED', 'REDEEMED', 'CHALLENGE_PENDING', 'PROOF_RECEIVED', 'CREDENTIAL_DELIVERED', 'ACKNOWLEDGED', 'COMPLETED', 'EXPIRED', 'REVOKED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvitationRole" AS ENUM ('PROPERTY_MANAGER', 'TENANT');

-- CreateEnum
CREATE TYPE "InvitationState" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED', 'REPLACED');

-- CreateEnum
CREATE TYPE "AreaQrStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REPLACED');

-- CreateEnum
CREATE TYPE "AreaAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClaimPurpose" AS ENUM ('INITIAL_OWNER', 'OWNERSHIP_TRANSFER');

-- CreateEnum
CREATE TYPE "ClaimState" AS ENUM ('AVAILABLE', 'RESERVED', 'PENDING_INSTALLATION', 'CONSUMED', 'CANCELLED', 'REPLACED', 'REVOKED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "ClaimReservationState" AS ENUM ('ACTIVE', 'CONVERTED_TO_PENDING_INSTALLATION', 'EXPIRED', 'MANUALLY_RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PendingHomeSetupState" AS ENUM ('PROFILE_REQUIRED', 'ADDRESS_REQUIRED', 'POLICY_REQUIRED', 'PENDING_INSTALLATION', 'READY_TO_ACTIVATE', 'EXPIRED', 'CANCELLED', 'ACTIVATED');

-- CreateEnum
CREATE TYPE "HomeDocumentKind" AS ENUM ('FLOORPLAN', 'AREA_PRESENTATION');

-- CreateEnum
CREATE TYPE "MemberPreferenceKind" AS ENUM ('DASHBOARD_LAYOUT', 'FILTER_STATE', 'QUIET_HOURS');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('CUSTOMER', 'EMPLOYEE', 'HUB', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('MANAGEMENT', 'SECURITY', 'INSTALLATION', 'ACCESS');

-- CreateTable
CREATE TABLE "CustomerAccount" (
    "id" UUID NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "username" VARCHAR(80) NOT NULL,
    "usernameNormalized" VARCHAR(80) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailNormalized" VARCHAR(320) NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "pendingEmail" VARCHAR(320),
    "pendingEmailNormalized" VARCHAR(320),
    "phoneNumber" VARCHAR(40),
    "passwordHash" VARCHAR(255) NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" TIMESTAMP(3),
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "securityVersion" INTEGER NOT NULL DEFAULT 1,
    "lastUsedHomeId" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEmployeeAccount" (
    "id" UUID NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailNormalized" VARCHAR(320) NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "EmployeeRole" NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "securityVersion" INTEGER NOT NULL DEFAULT 1,
    "recentAuthenticationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyEmployeeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "deviceInstallationId" VARCHAR(160) NOT NULL,
    "publicKey" TEXT NOT NULL,
    "publicKeyThumbprint" VARCHAR(128) NOT NULL,
    "deviceName" VARCHAR(160) NOT NULL,
    "model" VARCHAR(160),
    "osFamily" VARCHAR(80),
    "osVersion" VARCHAR(80),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSession" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "trustedDeviceId" UUID NOT NULL,
    "refreshTokenHash" VARCHAR(128) NOT NULL,
    "securityVersion" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyAcceptance" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "policyKind" VARCHAR(80) NOT NULL,
    "policyVersion" VARCHAR(80) NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceHash" VARCHAR(128),
    "redactedIpHash" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID,
    "purpose" VARCHAR(80) NOT NULL,
    "targetEmail" VARCHAR(320),
    "tokenHash" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "supersededById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepUpAuthorization" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "customerSessionId" UUID,
    "trustedDeviceId" UUID,
    "homeId" UUID,
    "membershipId" UUID,
    "operationKind" VARCHAR(120) NOT NULL,
    "targetDigest" VARCHAR(128) NOT NULL,
    "normalizedValueDigest" VARCHAR(128) NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "nonceHash" VARCHAR(128) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "StepUpAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Home" (
    "id" UUID NOT NULL,
    "addressLine1" VARCHAR(200),
    "addressLine2" VARCHAR(200),
    "city" VARCHAR(120),
    "region" VARCHAR(120),
    "postcode" VARCHAR(32),
    "country" VARCHAR(2),
    "timezone" VARCHAR(80),
    "addressStatus" "AddressStatus" NOT NULL DEFAULT 'NOT_PROVIDED',
    "lifecycle" "HomeLifecycle" NOT NULL DEFAULT 'INSTALLING',
    "installationStatus" "InstallationStatus" NOT NULL DEFAULT 'DRAFT',
    "installationCompletedAt" TIMESTAMP(3),
    "authorityGeneration" INTEGER NOT NULL DEFAULT 1,
    "customerDataGeneration" INTEGER NOT NULL DEFAULT 1,
    "managementRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Home_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeMembership" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessRevision" INTEGER NOT NULL DEFAULT 1,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removalReason" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Area" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "osAreaId" VARCHAR(160) NOT NULL,
    "originalName" VARCHAR(160) NOT NULL,
    "overrideName" VARCHAR(160),
    "status" "AreaStatus" NOT NULL DEFAULT 'ACTIVE',
    "retiredAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantAreaGrant" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "policyRevision" INTEGER NOT NULL DEFAULT 1,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAreaGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeDevice" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "hubInstallationId" UUID NOT NULL,
    "osDeviceId" VARCHAR(160) NOT NULL,
    "originalName" VARCHAR(160) NOT NULL,
    "overrideName" VARCHAR(160),
    "technicalLabel" VARCHAR(80) NOT NULL,
    "customerLabel" VARCHAR(80),
    "analyticsCategory" "DeviceAnalyticsCategory" NOT NULL DEFAULT 'NONE',
    "managementClass" "DeviceManagementClass" NOT NULL,
    "ownerMembershipId" UUID,
    "deviceType" VARCHAR(120) NOT NULL,
    "manufacturer" VARCHAR(160),
    "model" VARCHAR(160),
    "protocol" VARCHAR(80),
    "capabilitySummary" JSONB,
    "descriptorRevision" INTEGER NOT NULL DEFAULT 1,
    "descriptorDigest" VARCHAR(128),
    "onlineState" "DeviceOnlineState" NOT NULL DEFAULT 'UNKNOWN',
    "lastSeenAt" TIMESTAMP(3),
    "radiatorTemperature" DECIMAL(6,2),
    "radiatorReadingAt" TIMESTAMP(3),
    "lifecycle" "DeviceLifecycleState" NOT NULL DEFAULT 'DISCOVERED',
    "installedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "cleanupDeadlineAt" TIMESTAMP(3),
    "inventoryRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAreaAssignment" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "source" VARCHAR(80) NOT NULL,
    "actorType" VARCHAR(32),
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAreaAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubManufacturingIdentity" (
    "id" UUID NOT NULL,
    "serialNumber" VARCHAR(120) NOT NULL,
    "signingPublicKey" TEXT NOT NULL,
    "encryptionPublicKey" TEXT NOT NULL,
    "signingKeyFingerprint" VARCHAR(128) NOT NULL,
    "encryptionKeyFingerprint" VARCHAR(128) NOT NULL,
    "identityGeneration" INTEGER NOT NULL DEFAULT 1,
    "certificate" TEXT,
    "status" "HubIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubManufacturingIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyOperationalWorkItem" (
    "id" UUID NOT NULL,
    "publicReference" VARCHAR(32) NOT NULL,
    "kind" "CompanyWorkKind" NOT NULL,
    "state" "CompanyWorkState" NOT NULL DEFAULT 'ASSIGNED',
    "homeId" UUID,
    "hubInstallationId" UUID,
    "certifiedSerialNumber" VARCHAR(120),
    "assignedEmployeeId" UUID NOT NULL,
    "createdByEmployeeId" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "notes" VARCHAR(2000),
    "workRevision" INTEGER NOT NULL DEFAULT 1,
    "checklistRevision" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyOperationalWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubInstallation" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "manufacturingIdentityId" UUID NOT NULL,
    "serialNumberSnapshot" VARCHAR(120) NOT NULL,
    "state" "HubLifecycleState" NOT NULL DEFAULT 'PAIRING',
    "provisioningRevision" INTEGER NOT NULL DEFAULT 1,
    "baseUrl" VARCHAR(500),
    "cloudUrl" VARCHAR(500),
    "cloudUrlVerifiedAt" TIMESTAMP(3),
    "cloudflareTunnelId" VARCHAR(200),
    "cloudflareTunnelName" VARCHAR(200),
    "reservedHostname" VARCHAR(255),
    "remoteChallengeAt" TIMESTAMP(3),
    "remoteVerificationAt" TIMESTAMP(3),
    "currentCredentialVersion" INTEGER,
    "accessPolicyRevision" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3),
    "onlineStateEvaluatedAt" TIMESTAMP(3),
    "runtimeVersion" VARCHAR(120),
    "capabilitySummary" JSONB,
    "cleanupState" VARCHAR(80),
    "cleanupGeneration" INTEGER NOT NULL DEFAULT 0,
    "permanentResolverHash" VARCHAR(128),
    "permanentResolverGeneration" INTEGER NOT NULL DEFAULT 1,
    "permanentResolverStatus" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    "resolverIssuedAt" TIMESTAMP(3),
    "resolverReplacedAt" TIMESTAMP(3),
    "resolverRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubCredentialVersion" (
    "id" UUID NOT NULL,
    "hubInstallationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "HubCredentialState" NOT NULL DEFAULT 'PENDING',
    "tokenHash" VARCHAR(128) NOT NULL,
    "encryptedDeliveryEnvelope" JSONB,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HubCredentialVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubProvisioningAttempt" (
    "id" UUID NOT NULL,
    "attemptId" VARCHAR(160) NOT NULL,
    "manufacturingIdentityId" UUID NOT NULL,
    "hubInstallationId" UUID,
    "companyWorkItemId" UUID NOT NULL,
    "redeemerEmployeeId" UUID,
    "state" "ProvisioningState" NOT NULL DEFAULT 'CREATED',
    "codeHash" VARCHAR(128) NOT NULL,
    "baseUrlPresentation" VARCHAR(500) NOT NULL,
    "challengeHash" VARCHAR(128),
    "challengeExpiresAt" TIMESTAMP(3),
    "hubProofAt" TIMESTAMP(3),
    "encryptedCredentialEnvelope" JSONB,
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKeyHash" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubProvisioningAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipInvitation" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "inviterMembershipId" UUID NOT NULL,
    "targetAccountId" UUID,
    "targetEmail" VARCHAR(320) NOT NULL,
    "targetEmailNormalized" VARCHAR(320) NOT NULL,
    "role" "InvitationRole" NOT NULL,
    "state" "InvitationState" NOT NULL DEFAULT 'PENDING',
    "tokenHash" VARCHAR(128) NOT NULL,
    "temporaryCredentialHash" VARCHAR(128),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "replacementOfId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipInvitationArea" (
    "id" UUID NOT NULL,
    "invitationId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "homeId" UUID NOT NULL,

    CONSTRAINT "MembershipInvitationArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaQrCredential" (
    "id" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "resolverHash" VARCHAR(128) NOT NULL,
    "encryptedPrintablePayload" JSONB,
    "status" "AreaQrStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "AreaQrCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaAccessRequest" (
    "id" UUID NOT NULL,
    "areaQrCredentialId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "requesterAccountId" UUID NOT NULL,
    "status" "AreaAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedByMembershipId" UUID,
    "decidedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeClaimReference" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "hubInstallationId" UUID NOT NULL,
    "purpose" "ClaimPurpose" NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "state" "ClaimState" NOT NULL DEFAULT 'AVAILABLE',
    "companyQrReferenceHash" VARCHAR(128) NOT NULL,
    "transferCodeHash" VARCHAR(128),
    "resolverGeneration" INTEGER NOT NULL,
    "outgoingOwnerMembershipId" UUID,
    "claimedAccountId" UUID,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "replacedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "auditReference" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeClaimReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeClaimChallenge" (
    "id" UUID NOT NULL,
    "claimReferenceId" UUID NOT NULL,
    "hubInstallationId" UUID NOT NULL,
    "trustedDeviceId" UUID,
    "resolverGeneration" INTEGER NOT NULL,
    "nonceHash" VARCHAR(128) NOT NULL,
    "challengeDigest" VARCHAR(128) NOT NULL,
    "signedResponseDigest" VARCHAR(128),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "HomeClaimChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeClaimReservation" (
    "id" UUID NOT NULL,
    "claimReferenceId" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "state" "ClaimReservationState" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "setupRevision" INTEGER NOT NULL DEFAULT 0,
    "lastQualifyingMutationAt" TIMESTAMP(3),
    "releasedByEmployeeId" UUID,
    "releaseReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeClaimReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingHomeSetup" (
    "id" UUID NOT NULL,
    "claimReferenceId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "state" "PendingHomeSetupState" NOT NULL DEFAULT 'PROFILE_REQUIRED',
    "addressLine1" VARCHAR(200),
    "addressLine2" VARCHAR(200),
    "city" VARCHAR(120),
    "region" VARCHAR(120),
    "postcode" VARCHAR(32),
    "country" VARCHAR(2),
    "proposedTimezone" VARCHAR(80),
    "requiredStep" VARCHAR(80) NOT NULL,
    "setupRevision" INTEGER NOT NULL DEFAULT 0,
    "resumeTokenHash" VARCHAR(128),
    "lastQualifyingMutationAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingHomeSetup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeDocument" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "kind" "HomeDocumentKind" NOT NULL,
    "document" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdByAccountId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HomeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberPreferenceDocument" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "kind" "MemberPreferenceKind" NOT NULL,
    "document" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberPreferenceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "homeId" UUID,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" UUID,
    "category" "AuditCategory" NOT NULL,
    "action" VARCHAR(160) NOT NULL,
    "targetType" VARCHAR(120),
    "targetId" UUID,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeletionSecurityReceipt" (
    "id" UUID NOT NULL,
    "anonymousReference" VARCHAR(80) NOT NULL,
    "actionType" VARCHAR(120) NOT NULL,
    "actionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeletionSecurityReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "namespace" VARCHAR(120) NOT NULL,
    "keyHash" VARCHAR(128) NOT NULL,
    "actorId" UUID,
    "homeId" UUID,
    "requestHash" VARCHAR(128) NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseDigest" VARCHAR(128),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayNonce" (
    "id" UUID NOT NULL,
    "principalKind" VARCHAR(80) NOT NULL,
    "principalId" UUID NOT NULL,
    "nonceHash" VARCHAR(128) NOT NULL,
    "requestDigest" VARCHAR(128) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplayNonce_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccount_usernameNormalized_key" ON "CustomerAccount"("usernameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccount_emailNormalized_key" ON "CustomerAccount"("emailNormalized");

-- CreateIndex
CREATE INDEX "CustomerAccount_status_idx" ON "CustomerAccount"("status");

-- CreateIndex
CREATE INDEX "CustomerAccount_lastUsedHomeId_idx" ON "CustomerAccount"("lastUsedHomeId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEmployeeAccount_emailNormalized_key" ON "CompanyEmployeeAccount"("emailNormalized");

-- CreateIndex
CREATE INDEX "TrustedDevice_customerAccountId_revokedAt_idx" ON "TrustedDevice"("customerAccountId", "revokedAt");

-- CreateIndex
CREATE INDEX "TrustedDevice_publicKeyThumbprint_idx" ON "TrustedDevice"("publicKeyThumbprint");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_customerAccountId_deviceInstallationId_key" ON "TrustedDevice"("customerAccountId", "deviceInstallationId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSession_refreshTokenHash_key" ON "CustomerSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "CustomerSession_customerAccountId_revokedAt_expiresAt_idx" ON "CustomerSession"("customerAccountId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "CustomerSession_trustedDeviceId_revokedAt_idx" ON "CustomerSession"("trustedDeviceId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAcceptance_customerAccountId_policyKind_policyVersion_key" ON "PolicyAcceptance"("customerAccountId", "policyKind", "policyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "AuthChallenge_tokenHash_key" ON "AuthChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthChallenge_customerAccountId_purpose_expiresAt_idx" ON "AuthChallenge"("customerAccountId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "StepUpAuthorization_customerAccountId_expiresAt_consumedAt_idx" ON "StepUpAuthorization"("customerAccountId", "expiresAt", "consumedAt");

-- CreateIndex
CREATE INDEX "StepUpAuthorization_homeId_membershipId_idx" ON "StepUpAuthorization"("homeId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "StepUpAuthorization_customerAccountId_nonceHash_key" ON "StepUpAuthorization"("customerAccountId", "nonceHash");

-- CreateIndex
CREATE INDEX "Home_lifecycle_installationStatus_idx" ON "Home"("lifecycle", "installationStatus");

-- CreateIndex
CREATE INDEX "Home_postcode_idx" ON "Home"("postcode");

-- CreateIndex
CREATE INDEX "HomeMembership_homeId_role_status_idx" ON "HomeMembership"("homeId", "role", "status");

-- CreateIndex
CREATE INDEX "HomeMembership_customerAccountId_status_idx" ON "HomeMembership"("customerAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HomeMembership_customerAccountId_homeId_key" ON "HomeMembership"("customerAccountId", "homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeMembership_id_homeId_key" ON "HomeMembership"("id", "homeId");

-- CreateIndex
CREATE INDEX "Area_homeId_status_idx" ON "Area"("homeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Area_homeId_osAreaId_key" ON "Area"("homeId", "osAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "Area_id_homeId_key" ON "Area"("id", "homeId");

-- CreateIndex
CREATE INDEX "TenantAreaGrant_areaId_revokedAt_idx" ON "TenantAreaGrant"("areaId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAreaGrant_membershipId_areaId_key" ON "TenantAreaGrant"("membershipId", "areaId");

-- CreateIndex
CREATE INDEX "NativeDevice_homeId_managementClass_lifecycle_idx" ON "NativeDevice"("homeId", "managementClass", "lifecycle");

-- CreateIndex
CREATE INDEX "NativeDevice_ownerMembershipId_lifecycle_idx" ON "NativeDevice"("ownerMembershipId", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "NativeDevice_hubInstallationId_osDeviceId_key" ON "NativeDevice"("hubInstallationId", "osDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "NativeDevice_id_homeId_key" ON "NativeDevice"("id", "homeId");

-- CreateIndex
CREATE INDEX "DeviceAreaAssignment_deviceId_validUntil_idx" ON "DeviceAreaAssignment"("deviceId", "validUntil");

-- CreateIndex
CREATE INDEX "DeviceAreaAssignment_areaId_validFrom_validUntil_idx" ON "DeviceAreaAssignment"("areaId", "validFrom", "validUntil");

-- CreateIndex
CREATE INDEX "DeviceAreaAssignment_homeId_deviceId_validUntil_idx" ON "DeviceAreaAssignment"("homeId", "deviceId", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "HubManufacturingIdentity_signingKeyFingerprint_key" ON "HubManufacturingIdentity"("signingKeyFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "HubManufacturingIdentity_encryptionKeyFingerprint_key" ON "HubManufacturingIdentity"("encryptionKeyFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "HubManufacturingIdentity_serialNumber_identityGeneration_key" ON "HubManufacturingIdentity"("serialNumber", "identityGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyOperationalWorkItem_publicReference_key" ON "CompanyOperationalWorkItem"("publicReference");

-- CreateIndex
CREATE INDEX "CompanyOperationalWorkItem_assignedEmployeeId_state_idx" ON "CompanyOperationalWorkItem"("assignedEmployeeId", "state");

-- CreateIndex
CREATE INDEX "CompanyOperationalWorkItem_homeId_state_idx" ON "CompanyOperationalWorkItem"("homeId", "state");

-- CreateIndex
CREATE INDEX "CompanyOperationalWorkItem_hubInstallationId_state_idx" ON "CompanyOperationalWorkItem"("hubInstallationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstallation_homeId_key" ON "HubInstallation"("homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstallation_manufacturingIdentityId_key" ON "HubInstallation"("manufacturingIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstallation_serialNumberSnapshot_key" ON "HubInstallation"("serialNumberSnapshot");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstallation_permanentResolverHash_key" ON "HubInstallation"("permanentResolverHash");

-- CreateIndex
CREATE INDEX "HubInstallation_state_lastSeenAt_idx" ON "HubInstallation"("state", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstallation_id_homeId_key" ON "HubInstallation"("id", "homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstallation_id_manufacturingIdentityId_key" ON "HubInstallation"("id", "manufacturingIdentityId");

-- CreateIndex
CREATE INDEX "HubCredentialVersion_hubInstallationId_state_idx" ON "HubCredentialVersion"("hubInstallationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "HubCredentialVersion_hubInstallationId_version_key" ON "HubCredentialVersion"("hubInstallationId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "HubProvisioningAttempt_attemptId_key" ON "HubProvisioningAttempt"("attemptId");

-- CreateIndex
CREATE INDEX "HubProvisioningAttempt_manufacturingIdentityId_state_expire_idx" ON "HubProvisioningAttempt"("manufacturingIdentityId", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "HubProvisioningAttempt_companyWorkItemId_state_idx" ON "HubProvisioningAttempt"("companyWorkItemId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "HubProvisioningAttempt_manufacturingIdentityId_idempotencyK_key" ON "HubProvisioningAttempt"("manufacturingIdentityId", "idempotencyKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipInvitation_tokenHash_key" ON "MembershipInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "MembershipInvitation_targetEmailNormalized_state_expiresAt_idx" ON "MembershipInvitation"("targetEmailNormalized", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "MembershipInvitation_homeId_state_expiresAt_idx" ON "MembershipInvitation"("homeId", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "MembershipInvitation_inviterMembershipId_state_idx" ON "MembershipInvitation"("inviterMembershipId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipInvitation_id_homeId_key" ON "MembershipInvitation"("id", "homeId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipInvitationArea_invitationId_areaId_key" ON "MembershipInvitationArea"("invitationId", "areaId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaQrCredential_resolverHash_key" ON "AreaQrCredential"("resolverHash");

-- CreateIndex
CREATE INDEX "AreaQrCredential_areaId_status_idx" ON "AreaQrCredential"("areaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AreaQrCredential_areaId_generation_key" ON "AreaQrCredential"("areaId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "AreaQrCredential_id_areaId_key" ON "AreaQrCredential"("id", "areaId");

-- CreateIndex
CREATE INDEX "AreaAccessRequest_requesterAccountId_status_expiresAt_idx" ON "AreaAccessRequest"("requesterAccountId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AreaAccessRequest_areaId_status_expiresAt_idx" ON "AreaAccessRequest"("areaId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AreaAccessRequest_areaQrCredentialId_status_idx" ON "AreaAccessRequest"("areaQrCredentialId", "status");

-- CreateIndex
CREATE INDEX "HomeClaimReference_hubInstallationId_purpose_state_idx" ON "HomeClaimReference"("hubInstallationId", "purpose", "state");

-- CreateIndex
CREATE UNIQUE INDEX "HomeClaimReference_hubInstallationId_generation_key" ON "HomeClaimReference"("hubInstallationId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "HomeClaimReference_id_homeId_hubInstallationId_key" ON "HomeClaimReference"("id", "homeId", "hubInstallationId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeClaimReference_companyQrReferenceHash_key" ON "HomeClaimReference"("companyQrReferenceHash");

-- CreateIndex
CREATE INDEX "HomeClaimChallenge_hubInstallationId_expiresAt_consumedAt_idx" ON "HomeClaimChallenge"("hubInstallationId", "expiresAt", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HomeClaimChallenge_claimReferenceId_nonceHash_key" ON "HomeClaimChallenge"("claimReferenceId", "nonceHash");

-- CreateIndex
CREATE INDEX "HomeClaimReservation_claimReferenceId_state_expiresAt_idx" ON "HomeClaimReservation"("claimReferenceId", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "HomeClaimReservation_customerAccountId_state_idx" ON "HomeClaimReservation"("customerAccountId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "PendingHomeSetup_reservationId_key" ON "PendingHomeSetup"("reservationId");

-- CreateIndex
CREATE INDEX "PendingHomeSetup_claimReferenceId_state_idx" ON "PendingHomeSetup"("claimReferenceId", "state");

-- CreateIndex
CREATE INDEX "PendingHomeSetup_customerAccountId_state_idx" ON "PendingHomeSetup"("customerAccountId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "HomeDocument_homeId_kind_key" ON "HomeDocument"("homeId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MemberPreferenceDocument_membershipId_kind_key" ON "MemberPreferenceDocument"("membershipId", "kind");

-- CreateIndex
CREATE INDEX "AuditEvent_homeId_occurredAt_idx" ON "AuditEvent"("homeId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorType_actorId_occurredAt_idx" ON "AuditEvent"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_purgeAt_idx" ON "AuditEvent"("purgeAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeletionSecurityReceipt_anonymousReference_key" ON "DeletionSecurityReceipt"("anonymousReference");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_homeId_expiresAt_idx" ON "IdempotencyRecord"("homeId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_namespace_keyHash_key" ON "IdempotencyRecord"("namespace", "keyHash");

-- CreateIndex
CREATE INDEX "ReplayNonce_expiresAt_idx" ON "ReplayNonce"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplayNonce_principalKind_principalId_nonceHash_key" ON "ReplayNonce"("principalKind", "principalId", "nonceHash");

-- AddForeignKey
ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_lastUsedHomeId_fkey" FOREIGN KEY ("lastUsedHomeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_trustedDeviceId_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAcceptance" ADD CONSTRAINT "PolicyAcceptance_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthChallenge" ADD CONSTRAINT "AuthChallenge_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpAuthorization" ADD CONSTRAINT "StepUpAuthorization_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpAuthorization" ADD CONSTRAINT "StepUpAuthorization_trustedDeviceId_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeMembership" ADD CONSTRAINT "HomeMembership_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeMembership" ADD CONSTRAINT "HomeMembership_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAreaGrant" ADD CONSTRAINT "TenantAreaGrant_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAreaGrant" ADD CONSTRAINT "TenantAreaGrant_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDevice" ADD CONSTRAINT "NativeDevice_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDevice" ADD CONSTRAINT "NativeDevice_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDevice" ADD CONSTRAINT "NativeDevice_ownerMembershipId_fkey" FOREIGN KEY ("ownerMembershipId") REFERENCES "HomeMembership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAreaAssignment" ADD CONSTRAINT "DeviceAreaAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAreaAssignment" ADD CONSTRAINT "DeviceAreaAssignment_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyOperationalWorkItem" ADD CONSTRAINT "CompanyOperationalWorkItem_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyOperationalWorkItem" ADD CONSTRAINT "CompanyOperationalWorkItem_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyOperationalWorkItem" ADD CONSTRAINT "CompanyOperationalWorkItem_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyOperationalWorkItem" ADD CONSTRAINT "CompanyOperationalWorkItem_createdByEmployeeId_fkey" FOREIGN KEY ("createdByEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubInstallation" ADD CONSTRAINT "HubInstallation_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubInstallation" ADD CONSTRAINT "HubInstallation_manufacturingIdentityId_fkey" FOREIGN KEY ("manufacturingIdentityId") REFERENCES "HubManufacturingIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubCredentialVersion" ADD CONSTRAINT "HubCredentialVersion_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubProvisioningAttempt" ADD CONSTRAINT "HubProvisioningAttempt_manufacturingIdentityId_fkey" FOREIGN KEY ("manufacturingIdentityId") REFERENCES "HubManufacturingIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubProvisioningAttempt" ADD CONSTRAINT "HubProvisioningAttempt_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubProvisioningAttempt" ADD CONSTRAINT "HubProvisioningAttempt_companyWorkItemId_fkey" FOREIGN KEY ("companyWorkItemId") REFERENCES "CompanyOperationalWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubProvisioningAttempt" ADD CONSTRAINT "HubProvisioningAttempt_redeemerEmployeeId_fkey" FOREIGN KEY ("redeemerEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipInvitation" ADD CONSTRAINT "MembershipInvitation_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipInvitation" ADD CONSTRAINT "MembershipInvitation_inviterMembershipId_fkey" FOREIGN KEY ("inviterMembershipId") REFERENCES "HomeMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipInvitation" ADD CONSTRAINT "MembershipInvitation_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipInvitationArea" ADD CONSTRAINT "MembershipInvitationArea_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "MembershipInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipInvitationArea" ADD CONSTRAINT "MembershipInvitationArea_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaQrCredential" ADD CONSTRAINT "AreaQrCredential_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaAccessRequest" ADD CONSTRAINT "AreaAccessRequest_areaQrCredentialId_fkey" FOREIGN KEY ("areaQrCredentialId") REFERENCES "AreaQrCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaAccessRequest" ADD CONSTRAINT "AreaAccessRequest_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaAccessRequest" ADD CONSTRAINT "AreaAccessRequest_requesterAccountId_fkey" FOREIGN KEY ("requesterAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimReference" ADD CONSTRAINT "HomeClaimReference_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimReference" ADD CONSTRAINT "HomeClaimReference_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimReference" ADD CONSTRAINT "HomeClaimReference_claimedAccountId_fkey" FOREIGN KEY ("claimedAccountId") REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimChallenge" ADD CONSTRAINT "HomeClaimChallenge_claimReferenceId_fkey" FOREIGN KEY ("claimReferenceId") REFERENCES "HomeClaimReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimChallenge" ADD CONSTRAINT "HomeClaimChallenge_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimChallenge" ADD CONSTRAINT "HomeClaimChallenge_trustedDeviceId_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimReservation" ADD CONSTRAINT "HomeClaimReservation_claimReferenceId_fkey" FOREIGN KEY ("claimReferenceId") REFERENCES "HomeClaimReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimReservation" ADD CONSTRAINT "HomeClaimReservation_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeClaimReservation" ADD CONSTRAINT "HomeClaimReservation_releasedByEmployeeId_fkey" FOREIGN KEY ("releasedByEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingHomeSetup" ADD CONSTRAINT "PendingHomeSetup_claimReferenceId_fkey" FOREIGN KEY ("claimReferenceId") REFERENCES "HomeClaimReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingHomeSetup" ADD CONSTRAINT "PendingHomeSetup_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "HomeClaimReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingHomeSetup" ADD CONSTRAINT "PendingHomeSetup_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeDocument" ADD CONSTRAINT "HomeDocument_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeDocument" ADD CONSTRAINT "HomeDocument_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPreferenceDocument" ADD CONSTRAINT "MemberPreferenceDocument_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Native V2 same-home integrity. The single-column foreign keys above retain
-- Prisma relation metadata; these composite constraints prevent a valid UUID
-- from another home being substituted into an authority relationship.
ALTER TABLE "TenantAreaGrant"
  ADD CONSTRAINT "TenantAreaGrant_membership_home_fkey"
  FOREIGN KEY ("membershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TenantAreaGrant_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NativeDevice"
  ADD CONSTRAINT "NativeDevice_hub_home_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "NativeDevice_owner_home_fkey"
  FOREIGN KEY ("ownerMembershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DeviceAreaAssignment"
  ADD CONSTRAINT "DeviceAreaAssignment_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DeviceAreaAssignment_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MembershipInvitation"
  ADD CONSTRAINT "MembershipInvitation_inviter_home_fkey"
  FOREIGN KEY ("inviterMembershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MembershipInvitationArea"
  ADD CONSTRAINT "MembershipInvitationArea_invitation_home_fkey"
  FOREIGN KEY ("invitationId", "homeId") REFERENCES "MembershipInvitation"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MembershipInvitationArea_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AreaAccessRequest"
  ADD CONSTRAINT "AreaAccessRequest_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AreaAccessRequest_qr_area_fkey"
  FOREIGN KEY ("areaQrCredentialId", "areaId") REFERENCES "AreaQrCredential"("id", "areaId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AreaAccessRequest_approver_home_fkey"
  FOREIGN KEY ("approvedByMembershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "HomeClaimReference_id_hubInstallationId_key"
  ON "HomeClaimReference" ("id", "hubInstallationId");

ALTER TABLE "HomeClaimReference"
  ADD CONSTRAINT "HomeClaimReference_hub_home_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HomeClaimChallenge"
  ADD CONSTRAINT "HomeClaimChallenge_claim_hub_fkey"
  FOREIGN KEY ("claimReferenceId", "hubInstallationId") REFERENCES "HomeClaimReference"("id", "hubInstallationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StepUpAuthorization"
  ADD CONSTRAINT "StepUpAuthorization_session_fkey"
  FOREIGN KEY ("customerSessionId") REFERENCES "CustomerSession"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "StepUpAuthorization_home_fkey"
  FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "StepUpAuthorization_membership_fkey"
  FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "AuthChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MembershipInvitation"
  ADD CONSTRAINT "MembershipInvitation_replacementOfId_fkey"
  FOREIGN KEY ("replacementOfId") REFERENCES "MembershipInvitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IdempotencyRecord"
  ADD CONSTRAINT "IdempotencyRecord_homeId_fkey"
  FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "HubManufacturingIdentity_active_serial_unique"
  ON "HubManufacturingIdentity" ("serialNumber")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "MembershipInvitation_pending_target_unique"
  ON "MembershipInvitation" ("homeId", "targetEmailNormalized", "role")
  WHERE "state" = 'PENDING';

CREATE UNIQUE INDEX "AreaAccessRequest_pending_requester_area_unique"
  ON "AreaAccessRequest" ("requesterAccountId", "areaId")
  WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX "HomeMembership_active_owner_unique"
  ON "HomeMembership" ("homeId")
  WHERE "status" = 'ACTIVE' AND "role" = 'OWNER';

CREATE UNIQUE INDEX "DeviceAreaAssignment_current_unique"
  ON "DeviceAreaAssignment" ("deviceId")
  WHERE "validUntil" IS NULL;

CREATE UNIQUE INDEX "AreaQrCredential_active_unique"
  ON "AreaQrCredential" ("areaId")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "HomeClaimReference_current_unique"
  ON "HomeClaimReference" ("hubInstallationId")
  WHERE "state" IN ('AVAILABLE', 'RESERVED', 'PENDING_INSTALLATION');

CREATE UNIQUE INDEX "HomeClaimReservation_active_unique"
  ON "HomeClaimReservation" ("claimReferenceId")
  WHERE "state" = 'ACTIVE';

CREATE OR REPLACE FUNCTION dinodia_validate_device_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_role "MembershipRole";
  owner_home uuid;
BEGIN
  IF NEW."managementClass" = 'TENANT_DEVICE' THEN
    IF NEW."ownerMembershipId" IS NULL OR NEW."technicalLabel" <> 'tenant_device' THEN
      RAISE EXCEPTION 'tenant device requires tenant_device technical label and owner membership';
    END IF;
    SELECT "role", "homeId" INTO owner_role, owner_home
      FROM "HomeMembership" WHERE "id" = NEW."ownerMembershipId";
    IF owner_role IS NULL OR owner_role <> 'TENANT' OR owner_home <> NEW."homeId" THEN
      RAISE EXCEPTION 'tenant device owner must be a tenant membership in the device home';
    END IF;
  ELSIF NEW."ownerMembershipId" IS NOT NULL OR NEW."technicalLabel" = 'tenant_device' THEN
    RAISE EXCEPTION 'property device cannot carry tenant ownership or tenant_device technical label';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_device_assignment_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  device_record record;
  current_assignment_count integer;
  device_id_value uuid;
BEGIN
  device_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD."deviceId" ELSE NEW."deviceId" END;
  SELECT "managementClass", "lifecycle" INTO device_record
    FROM "NativeDevice" WHERE "id" = device_id_value;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF device_record."managementClass" = 'TENANT_DEVICE'
     AND device_record."lifecycle" IN ('INSTALLED', 'VIEW_ONLY') THEN
    SELECT COUNT(*)::integer INTO current_assignment_count
      FROM "DeviceAreaAssignment"
      WHERE "deviceId" = device_id_value AND "validUntil" IS NULL;
    IF current_assignment_count <> 1 THEN
      RAISE EXCEPTION 'installed or view-only tenant device requires exactly one current area assignment';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_native_device_assignment_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  device_record record;
  current_assignment_count integer;
  device_id_value uuid;
BEGIN
  device_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  SELECT "managementClass", "lifecycle" INTO device_record
    FROM "NativeDevice" WHERE "id" = device_id_value;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF device_record."managementClass" = 'TENANT_DEVICE'
     AND device_record."lifecycle" IN ('INSTALLED', 'VIEW_ONLY') THEN
    SELECT COUNT(*)::integer INTO current_assignment_count
      FROM "DeviceAreaAssignment"
      WHERE "deviceId" = device_id_value AND "validUntil" IS NULL;
    IF current_assignment_count <> 1 THEN
      RAISE EXCEPTION 'installed or view-only tenant device requires exactly one current area assignment';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_tenant_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  membership_record record;
  area_status "AreaStatus";
BEGIN
  IF NEW."revokedAt" IS NULL THEN
    SELECT "role", "status" INTO membership_record
      FROM "HomeMembership"
      WHERE "id" = NEW."membershipId" AND "homeId" = NEW."homeId";
    SELECT "status" INTO area_status
      FROM "Area" WHERE "id" = NEW."areaId" AND "homeId" = NEW."homeId";
    IF membership_record."role" IS DISTINCT FROM 'TENANT'
       OR membership_record."status" IS DISTINCT FROM 'ACTIVE'
       OR area_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'active tenant area grant requires an active tenant and active area in the same home';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_invitation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invitation_id_value uuid;
  invitation_record record;
  area_count integer;
  predecessor record;
BEGIN
  IF TG_TABLE_NAME = 'MembershipInvitation' THEN
    invitation_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  ELSE
    invitation_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD."invitationId" ELSE NEW."invitationId" END;
  END IF;
  SELECT * INTO invitation_record FROM "MembershipInvitation" WHERE "id" = invitation_id_value;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF invitation_record."state" = 'PENDING' THEN
    SELECT COUNT(*)::integer INTO area_count
      FROM "MembershipInvitationArea" mia
      JOIN "Area" a ON a."id" = mia."areaId" AND a."homeId" = mia."homeId"
      WHERE mia."invitationId" = invitation_record."id" AND mia."homeId" = invitation_record."homeId" AND a."status" = 'ACTIVE';
    IF invitation_record."role" = 'TENANT' AND area_count < 1 THEN
      RAISE EXCEPTION 'pending tenant invitation requires at least one active area';
    END IF;
    IF invitation_record."role" = 'PROPERTY_MANAGER' AND (invitation_record."temporaryCredentialHash" IS NOT NULL OR area_count <> 0) THEN
      RAISE EXCEPTION 'property manager invitation cannot contain tenant areas or temporary credential';
    END IF;
  END IF;
  IF invitation_record."replacementOfId" IS NOT NULL THEN
    SELECT "homeId", "targetEmailNormalized", "role" INTO predecessor
      FROM "MembershipInvitation" WHERE "id" = invitation_record."replacementOfId";
    IF predecessor."homeId" IS DISTINCT FROM invitation_record."homeId"
       OR predecessor."targetEmailNormalized" IS DISTINCT FROM invitation_record."targetEmailNormalized"
       OR predecessor."role" IS DISTINCT FROM invitation_record."role" THEN
      RAISE EXCEPTION 'invitation replacement must retain home, recipient and role';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_area_access_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  qr_area uuid;
  qr_status "AreaQrStatus";
  requester_verified timestamp;
  approver_role "MembershipRole";
BEGIN
  SELECT "areaId", "status" INTO qr_area, qr_status
    FROM "AreaQrCredential" WHERE "id" = NEW."areaQrCredentialId";
  IF qr_area IS DISTINCT FROM NEW."areaId" THEN
    RAISE EXCEPTION 'area access request QR does not belong to requested area';
  END IF;
  IF NEW."status" = 'PENDING' THEN
    IF qr_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'pending area access request requires current active room QR';
    END IF;
    SELECT "emailVerifiedAt" INTO requester_verified
      FROM "CustomerAccount" WHERE "id" = NEW."requesterAccountId";
    IF requester_verified IS NULL THEN
      RAISE EXCEPTION 'area access requester email must be verified';
    END IF;
  END IF;
  IF NEW."approvedByMembershipId" IS NOT NULL THEN
    SELECT "role" INTO approver_role
      FROM "HomeMembership"
      WHERE "id" = NEW."approvedByMembershipId" AND "homeId" = NEW."homeId" AND "status" = 'ACTIVE';
    IF approver_role IS DISTINCT FROM 'OWNER' AND approver_role IS DISTINCT FROM 'PROPERTY_MANAGER' THEN
      RAISE EXCEPTION 'area access approver must be an active owner or property manager in the same home';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_home_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  hub_home uuid;
  owner_home uuid;
BEGIN
  SELECT "homeId" INTO hub_home FROM "HubInstallation" WHERE "id" = NEW."hubInstallationId";
  IF hub_home IS DISTINCT FROM NEW."homeId" THEN
    RAISE EXCEPTION 'home claim reference and hub installation belong to different homes';
  END IF;
  IF NEW."outgoingOwnerMembershipId" IS NOT NULL THEN
    SELECT "homeId" INTO owner_home FROM "HomeMembership" WHERE "id" = NEW."outgoingOwnerMembershipId";
    IF owner_home IS DISTINCT FROM NEW."homeId" THEN
      RAISE EXCEPTION 'outgoing owner membership belongs to a different home';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_work_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  hub_home uuid;
BEGIN
  IF NEW."hubInstallationId" IS NOT NULL THEN
    SELECT "homeId" INTO hub_home FROM "HubInstallation" WHERE "id" = NEW."hubInstallationId";
    IF NEW."homeId" IS NULL OR hub_home IS DISTINCT FROM NEW."homeId" THEN
      RAISE EXCEPTION 'operational work item and hub installation belong to different homes';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_provisioning_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  hub_identity uuid;
  work_hub uuid;
BEGIN
  IF NEW."hubInstallationId" IS NOT NULL THEN
    SELECT "manufacturingIdentityId" INTO hub_identity FROM "HubInstallation" WHERE "id" = NEW."hubInstallationId";
    IF hub_identity IS DISTINCT FROM NEW."manufacturingIdentityId" THEN
      RAISE EXCEPTION 'provisioning attempt identity does not match hub installation identity';
    END IF;
  END IF;
  SELECT "hubInstallationId" INTO work_hub FROM "CompanyOperationalWorkItem" WHERE "id" = NEW."companyWorkItemId";
  IF work_hub IS NOT NULL AND NEW."hubInstallationId" IS DISTINCT FROM work_hub THEN
    RAISE EXCEPTION 'provisioning attempt and operational work item target different hubs';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_step_up()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_account uuid;
  membership_home uuid;
BEGIN
  IF NEW."customerSessionId" IS NOT NULL THEN
    SELECT "customerAccountId" INTO session_account FROM "CustomerSession" WHERE "id" = NEW."customerSessionId";
    IF session_account IS DISTINCT FROM NEW."customerAccountId" THEN
      RAISE EXCEPTION 'step-up session belongs to a different customer account';
    END IF;
  END IF;
  IF NEW."membershipId" IS NOT NULL THEN
    SELECT "homeId" INTO membership_home FROM "HomeMembership" WHERE "id" = NEW."membershipId";
    IF NEW."homeId" IS NULL OR membership_home IS DISTINCT FROM NEW."homeId" THEN
      RAISE EXCEPTION 'step-up membership and home do not agree';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "NativeDevice_record_guard"
AFTER INSERT OR UPDATE ON "NativeDevice"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_device_record();

CREATE CONSTRAINT TRIGGER "DeviceAreaAssignment_current_guard"
AFTER INSERT OR UPDATE OR DELETE ON "DeviceAreaAssignment"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_device_assignment_state();

CREATE CONSTRAINT TRIGGER "NativeDevice_assignment_guard"
AFTER INSERT OR UPDATE ON "NativeDevice"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_native_device_assignment_state();

CREATE CONSTRAINT TRIGGER "TenantAreaGrant_active_guard"
AFTER INSERT OR UPDATE ON "TenantAreaGrant"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_tenant_grant();

CREATE CONSTRAINT TRIGGER "MembershipInvitation_state_guard"
AFTER INSERT OR UPDATE ON "MembershipInvitation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_invitation();

CREATE CONSTRAINT TRIGGER "MembershipInvitationArea_state_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MembershipInvitationArea"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_invitation();

CREATE CONSTRAINT TRIGGER "AreaAccessRequest_state_guard"
AFTER INSERT OR UPDATE ON "AreaAccessRequest"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_area_access_request();

CREATE CONSTRAINT TRIGGER "HomeClaimReference_home_guard"
AFTER INSERT OR UPDATE ON "HomeClaimReference"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_home_claim();

CREATE CONSTRAINT TRIGGER "CompanyOperationalWorkItem_home_guard"
AFTER INSERT OR UPDATE ON "CompanyOperationalWorkItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_work_item();

CREATE CONSTRAINT TRIGGER "HubProvisioningAttempt_identity_guard"
AFTER INSERT OR UPDATE ON "HubProvisioningAttempt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_provisioning_attempt();

CREATE CONSTRAINT TRIGGER "StepUpAuthorization_scope_guard"
AFTER INSERT OR UPDATE ON "StepUpAuthorization"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_step_up();

ALTER TABLE "NativeDevice"
  ADD CONSTRAINT "NativeDevice_technical_label_check"
  CHECK (("managementClass" = 'TENANT_DEVICE' AND "technicalLabel" = 'tenant_device' AND "ownerMembershipId" IS NOT NULL)
      OR ("managementClass" = 'PROPERTY_DEVICE' AND "technicalLabel" <> 'tenant_device' AND "ownerMembershipId" IS NULL));

ALTER TABLE "Home"
  ADD CONSTRAINT "Home_address_status_check"
  CHECK ("addressStatus" = 'NOT_PROVIDED'
      OR ("addressLine1" IS NOT NULL AND "city" IS NOT NULL AND "postcode" IS NOT NULL AND "country" IS NOT NULL AND "timezone" IS NOT NULL));

ALTER TABLE "AuthChallenge"
  ADD CONSTRAINT "AuthChallenge_expiry_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "HomeClaimChallenge"
  ADD CONSTRAINT "HomeClaimChallenge_expiry_check"
  CHECK ("expiresAt" > "issuedAt");

ALTER TABLE "HomeClaimReservation"
  ADD CONSTRAINT "HomeClaimReservation_expiry_check"
  CHECK ("expiresAt" > "createdAt" OR "state" <> 'ACTIVE');

ALTER TABLE "MembershipInvitation"
  ADD CONSTRAINT "MembershipInvitation_expiry_check"
  CHECK ("expiresAt" > "createdAt");

ALTER TABLE "HomeClaimReference"
  ADD CONSTRAINT "HomeClaimReference_purpose_check"
  CHECK (("purpose" = 'INITIAL_OWNER' AND "transferCodeHash" IS NULL AND "outgoingOwnerMembershipId" IS NULL)
      OR "purpose" = 'OWNERSHIP_TRANSFER');

CREATE OR REPLACE FUNCTION dinodia_validate_active_home_id(p_home_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  active_area_count integer;
  verified_cloud boolean;
  home_record record;
BEGIN
  SELECT * INTO home_record FROM "Home" WHERE "id" = p_home_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF home_record."lifecycle" = 'ACTIVE' THEN
    IF home_record."addressStatus" = 'NOT_PROVIDED'
      OR home_record."addressLine1" IS NULL OR home_record."city" IS NULL
      OR home_record."postcode" IS NULL OR home_record."country" IS NULL
      OR home_record."timezone" IS NULL OR home_record."installationStatus" <> 'COMPLETE' THEN
      RAISE EXCEPTION 'active home requires a complete verified address and installation';
    END IF;
    SELECT COUNT(*)::integer INTO active_area_count FROM "Area" WHERE "homeId" = p_home_id AND "status" = 'ACTIVE';
    IF active_area_count < 1 THEN RAISE EXCEPTION 'active home requires at least one active area'; END IF;
    SELECT EXISTS(SELECT 1 FROM "HubInstallation" WHERE "homeId" = p_home_id AND "cloudUrlVerifiedAt" IS NOT NULL AND "remoteVerificationAt" IS NOT NULL) INTO verified_cloud;
    IF NOT verified_cloud THEN RAISE EXCEPTION 'active home requires independently verified CloudURL'; END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION dinodia_validate_active_home()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM dinodia_validate_active_home_id(NEW."id"); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_active_area_home()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN PERFORM dinodia_validate_active_home_id(OLD."homeId"); RETURN OLD; END IF; PERFORM dinodia_validate_active_home_id(NEW."homeId"); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_active_hub_home()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN PERFORM dinodia_validate_active_home_id(OLD."homeId"); RETURN OLD; END IF; PERFORM dinodia_validate_active_home_id(NEW."homeId"); RETURN NEW; END; $$;

CREATE CONSTRAINT TRIGGER "Home_active_lifecycle_guard"
AFTER INSERT OR UPDATE ON "Home" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dinodia_validate_active_home();

CREATE CONSTRAINT TRIGGER "Area_active_lifecycle_guard"
AFTER INSERT OR UPDATE OR DELETE ON "Area" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dinodia_validate_active_area_home();

CREATE CONSTRAINT TRIGGER "HubInstallation_active_lifecycle_guard"
AFTER INSERT OR UPDATE OR DELETE ON "HubInstallation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dinodia_validate_active_hub_home();

-- Supabase direct table access is not the V2 application interface.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
