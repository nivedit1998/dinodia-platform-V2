-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'SENIOR_CUSTOMER_SUPPORT', 'CXO', 'TENANT');

-- CreateEnum
CREATE TYPE "AlexaLinkScope" AS ENUM ('TENANT', 'HOMEOWNER');

-- CreateEnum
CREATE TYPE "AlexaNativeConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'LINKED', 'ERROR');

-- CreateEnum
CREATE TYPE "AlexaProjectionSource" AS ENUM ('HA_LEGACY', 'DINODIA_OS_NATIVE');

-- CreateEnum
CREATE TYPE "HomeStatus" AS ENUM ('ACTIVE', 'TRANSFER_PENDING', 'UNCLAIMED');

-- CreateEnum
CREATE TYPE "MatterCommissioningStatus" AS ENUM ('CREATED', 'IN_PROGRESS', 'NEEDS_INPUT', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CommissioningKind" AS ENUM ('MATTER', 'DISCOVERY');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('SELL_INITIATED', 'CLAIM_CODE_GENERATED', 'HOME_CLAIM_ATTEMPTED', 'HOME_RESET', 'OWNER_TRANSFERRED', 'TENANT_DELETED', 'HOME_CLAIMED', 'AUTOMATION_CREATED', 'AUTOMATION_UPDATED', 'AUTOMATION_DELETED', 'HOMEOWNER_POLICY_ACCEPTED', 'HOMEOWNER_POLICY_EMAIL_RESEND_REQUESTED', 'SUPPORT_REQUEST_CREATED', 'SUPPORT_REQUEST_APPROVED', 'SUPPORT_REQUEST_REVOKED', 'SUPPORT_CREDENTIALS_VIEWED', 'SUPPORT_IMPERSONATION_STARTED', 'SUPPORT_IMPERSONATION_STOPPED', 'SUPPORT_HA_CODE_ISSUED', 'SUPPORT_HA_CODE_CONSUMED', 'SUPPORT_HA_SESSION_STARTED', 'SUPPORT_HA_SESSION_FAILED', 'SUPPORT_HA_SESSION_EXPIRED', 'ROOM_ACCESS_REQUESTED', 'ROOM_ACCESS_APPROVED', 'ROOM_ACCESS_REJECTED', 'PROPERTY_MANAGER_UPDATED', 'ROOM_QR_REKEYED', 'ROOM_HA_AREA_RESYNCED', 'OS_OPERATOR_SESSION_LAUNCHED', 'OS_OPERATOR_CREDENTIAL_ROTATION_REQUESTED', 'OS_OPERATOR_CREDENTIAL_REVOKED', 'OS_PROVISIONING_PAIRING_REDEEMED', 'SUPPORT_V2_ACCESS_REDEEMED', 'SUPPORT_V2_CODE_ISSUED', 'SUPPORT_V2_ACCESS_CLOSED', 'SUPPORT_V2_REVOCATION_ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "HomeownerPolicyNotificationRecipientType" AS ENUM ('HOMEOWNER', 'INSTALLER');

-- CreateEnum
CREATE TYPE "HomeownerPolicyNotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "PolicyKind" AS ENUM ('PRIVACY_NOTICE', 'TERMS');

-- CreateEnum
CREATE TYPE "HomeContactType" AS ENUM ('PROPERTY_MANAGER');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'REKEYED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RoomAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "RoomAccessApprovalKind" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "HomeownerOnboardingFlowType" AS ENUM ('SETUP_QR', 'CLAIM_CODE');

-- CreateEnum
CREATE TYPE "AuthChallengePurpose" AS ENUM ('ADMIN_EMAIL_VERIFY', 'TENANT_ENABLE_2FA', 'LOGIN_NEW_DEVICE', 'REMOTE_ACCESS_SETUP', 'PASSWORD_RESET', 'SUPPORT_HOME_ACCESS', 'SUPPORT_USER_REMOTE_SUPPORT');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'STOLEN', 'BLOCKED');

-- CreateEnum
CREATE TYPE "StepUpPurpose" AS ENUM ('REMOTE_ACCESS_SETUP', 'SENSITIVE_OPERATION');

-- CreateEnum
CREATE TYPE "SupportRequestKind" AS ENUM ('HOME_ACCESS', 'USER_REMOTE_ACCESS');

-- CreateEnum
CREATE TYPE "SupportAccessScope" AS ENUM ('VIEW_HOME_STATUS', 'VIEW_CREDENTIALS', 'CONNECT_HA_BACKEND', 'IMPERSONATE_USER');

-- CreateEnum
CREATE TYPE "SupportApprovalRecipientType" AS ENUM ('HOMEOWNER', 'PROPERTY_MANAGER');

-- CreateEnum
CREATE TYPE "HomeAutomationSource" AS ENUM ('DINODIA_UI');

-- CreateEnum
CREATE TYPE "TenantDeviceCleanupStatus" AS ENUM ('ACTIVE', 'PENDING_DEVICE_CLEANUP', 'CLEANED_UP');

-- CreateEnum
CREATE TYPE "TenantDeviceCleanupReason" AS ENUM ('TENANT_DELETED', 'AREA_ACCESS_REMOVED', 'DEVICE_MOVE_FAILED', 'MANUAL_RETRY');

-- CreateEnum
CREATE TYPE "HubTokenStatus" AS ENUM ('PENDING', 'ACTIVE', 'GRACE', 'REVOKED');

-- CreateEnum
CREATE TYPE "HubOperatorCredentialStatus" AS ENUM ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'ACTIVE', 'GRACE', 'REVOKED');

-- CreateEnum
CREATE TYPE "HomeMembershipRole" AS ENUM ('OWNER', 'PROPERTY_MANAGER', 'TENANT');

-- CreateEnum
CREATE TYPE "HomeMembershipStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateTable
CREATE TABLE "Home" (
    "id" SERIAL NOT NULL,
    "status" "HomeStatus" NOT NULL DEFAULT 'ACTIVE',
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postcode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'Europe/London',
    "haConnectionId" INTEGER NOT NULL,
    "claimCodeHash" TEXT,
    "claimCodeIssuedAt" TIMESTAMP(3),
    "claimCodeConsumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Home_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "type" "AuditEventType" NOT NULL,
    "metadata" JSONB,
    "homeId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEventArchive" (
    "id" TEXT NOT NULL,
    "type" "AuditEventType" NOT NULL,
    "metadata" JSONB,
    "homeId" INTEGER,
    "actorUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEventArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" TIMESTAMP(3),
    "email" TEXT,
    "emailPending" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "phoneNumber" TEXT,
    "homeownerPolicyAcceptedVersion" TEXT,
    "homeownerPolicyAcceptedAt" TIMESTAMP(3),
    "email2faEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "role" "Role" NOT NULL DEFAULT 'TENANT',
    "homeId" INTEGER,
    "haConnectionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEmployeePrincipal" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "recentAuthAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyEmployeePrincipal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeMembership" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "homeId" INTEGER NOT NULL,
    "role" "HomeMembershipRole" NOT NULL,
    "status" "HomeMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "policyRevision" INTEGER NOT NULL DEFAULT 1,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeMembershipAreaGrant" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeMembershipAreaGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyAcceptance" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "policyKind" "PolicyKind" NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "deviceFingerprintHash" TEXT,

    CONSTRAINT "PolicyAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginIntent" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "label" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceRegistry" (
    "deviceId" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "label" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRegistry_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "purpose" "AuthChallengePurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "deviceId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "supersededTokenHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepUpApproval" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT,
    "purpose" "StepUpPurpose" NOT NULL,
    "operationKind" TEXT,
    "operationDigest" TEXT,
    "trustedSessionId" TEXT,
    "membershipId" TEXT,
    "hubInstallId" TEXT,
    "targetIds" JSONB,
    "homeId" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepUpApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemoteAccessLease" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "purpose" "StepUpPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteAccessLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HaConnection" (
    "id" SERIAL NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "cloudUrl" TEXT,
    "haUsername" TEXT,
    "haUsernameCiphertext" TEXT,
    "haPassword" TEXT,
    "haPasswordCiphertext" TEXT,
    "longLivedToken" TEXT,
    "longLivedTokenCiphertext" TEXT,
    "longLivedTokenHash" TEXT,
    "devicesVersion" INTEGER NOT NULL DEFAULT 0,
    "ownerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubInstall" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "bootstrapSecretCiphertext" TEXT NOT NULL,
    "syncSecretCiphertext" TEXT,
    "platformSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "platformSyncIntervalMinutes" INTEGER NOT NULL DEFAULT 2,
    "rotateEveryMinutes" INTEGER NOT NULL DEFAULT 60,
    "graceMinutes" INTEGER NOT NULL DEFAULT 20,
    "publishedHubTokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastAckedHubTokenVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedOperatorCredentialVersion" INTEGER NOT NULL DEFAULT 0,
    "deliveredOperatorCredentialVersion" INTEGER NOT NULL DEFAULT 0,
    "lastAckedOperatorCredentialVersion" INTEGER NOT NULL DEFAULT 0,
    "activeOperatorCredentialVersion" INTEGER NOT NULL DEFAULT 0,
    "operatorRotateEveryMinutes" INTEGER NOT NULL DEFAULT 60,
    "operatorGraceMinutes" INTEGER NOT NULL DEFAULT 20,
    "accessPolicyRevision" INTEGER NOT NULL DEFAULT 1,
    "manufacturingIdentityId" TEXT,
    "provisioningOperatorId" INTEGER,
    "provisioningWorkflowStatus" TEXT,
    "heatingUsageResetRequestedAt" TIMESTAMP(3),
    "heatingUsageResetCompletedAt" TIMESTAMP(3),
    "lastReportedLanBaseUrl" TEXT,
    "lastReportedLanBaseUrlAt" TIMESTAMP(3),
    "lastReportedCloudUrl" TEXT,
    "lastReportedCloudUrlAt" TIMESTAMP(3),
    "cloudUrlVerifiedAt" TIMESTAMP(3),
    "lastReportedHaAreas" JSONB,
    "lastReportedHaAreasAt" TIMESTAMP(3),
    "runtimeKind" TEXT,
    "runtimeVersion" TEXT,
    "runtimeCapabilities" JSONB,
    "runtimeCapabilitiesReportedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "homeId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubInstall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubManufacturingIdentity" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "signingPublicKey" TEXT NOT NULL,
    "encryptionPublicKey" TEXT,
    "publicKeyFingerprint" TEXT NOT NULL,
    "encryptionKeyFingerprint" TEXT,
    "identityGeneration" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubManufacturingIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubProvisioningAttempt" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "provisioningOperatorId" INTEGER,
    "provisioningWorkflowId" TEXT,
    "operatorBoundAt" TIMESTAMP(3),
    "cloudUrl" TEXT,
    "cloudUrlReportedAt" TIMESTAMP(3),
    "cloudUrlVerifiedAt" TIMESTAMP(3),
    "challengeHash" TEXT,
    "challengeCiphertext" TEXT,
    "challengeExpiresAt" TIMESTAMP(3),
    "hubProofAt" TIMESTAMP(3),
    "machineCredentialVersion" INTEGER,
    "machineCredentialHash" TEXT,
    "machineCredentialCiphertext" TEXT,
    "machineCredentialEnvelope" JSONB,
    "machineCredentialDeliveredAt" TIMESTAMP(3),
    "machineCredentialAcknowledgedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "challengeIssuedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "installationCompletedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "homeQrReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubProvisioningAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OsOperatorWorkflow" (
    "id" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "workflowType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "assignedEmployeeId" INTEGER NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OsOperatorWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubIncident" (
    "id" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "incidentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "deviceId" TEXT,
    "deviceName" TEXT,
    "deviceProtocol" TEXT,
    "deviceModel" TEXT,
    "areaName" TEXT,
    "labels" JSONB,
    "details" JSONB,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeownerPolicyAcceptance" (
    "id" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "homeownerUserId" INTEGER NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureName" TEXT NOT NULL,
    "acceptedStatements" JSONB NOT NULL,
    "addressReference" TEXT NOT NULL,
    "approvedSupportContacts" JSONB,
    "notificationPreference" TEXT,
    "ipHash" TEXT,
    "deviceFingerprintHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeownerPolicyAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeownerPolicyNotificationDelivery" (
    "id" TEXT NOT NULL,
    "acceptanceId" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "recipientType" "HomeownerPolicyNotificationRecipientType" NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "status" "HomeownerPolicyNotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeownerPolicyNotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingHomeownerOnboarding" (
    "id" TEXT NOT NULL,
    "flowType" "HomeownerOnboardingFlowType" NOT NULL,
    "policyVersionRequired" TEXT NOT NULL DEFAULT '2026-V1',
    "claimCodeHash" TEXT,
    "hubInstallId" TEXT,
    "homeId" INTEGER,
    "userId" INTEGER,
    "proposedUsername" TEXT NOT NULL,
    "proposedPasswordHash" TEXT NOT NULL,
    "proposedEmail" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "policyAcceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingHomeownerOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubOperatorCredential" (
    "id" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "HubOperatorCredentialStatus" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryError" TEXT,

    CONSTRAINT "HubOperatorCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorSessionHandoff" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "homeId" INTEGER NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorSessionHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubToken" (
    "id" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "HubTokenStatus" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubAgentNonce" (
    "id" SERIAL NOT NULL,
    "serial" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "ts" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HubAgentNonce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRule" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "area" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeContact" (
    "id" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "type" "HomeContactType" NOT NULL,
    "email" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "haAreaName" TEXT NOT NULL,
    "haAreaNameOriginal" TEXT NOT NULL,
    "qrKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "qrSecretHash" TEXT NOT NULL,
    "qrSecretCiphertext" TEXT NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomAccessRequest" (
    "id" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "homeIdSnapshot" INTEGER,
    "requestedName" TEXT NOT NULL,
    "requestedEmail" TEXT NOT NULL,
    "requestedPhoneNumber" TEXT,
    "tenantUserId" INTEGER,
    "status" "RoomAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomAccessApprovalToken" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" "RoomAccessApprovalKind" NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomAccessApprovalToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "label" TEXT,
    "blindTravelSeconds" INTEGER,
    "boilerPowerKw" DOUBLE PRECISION,
    "heatingPricePerKwh" DOUBLE PRECISION,
    "boilerEfficiencyBand" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringReading" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "numericValue" DOUBLE PRECISION,
    "unit" TEXT,
    "hubOnline" BOOLEAN,
    "hubOfflineGraceSeconds" INTEGER,
    "hubStatusSource" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoilerTemperatureReading" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "numericValue" DOUBLE PRECISION NOT NULL,
    "currentTemperature" DOUBLE PRECISION NOT NULL,
    "targetTemperature" DOUBLE PRECISION,
    "onForSeconds" INTEGER,
    "offForSeconds" INTEGER,
    "unknownForSeconds" INTEGER,
    "averageEfficiencyPercent" DOUBLE PRECISION,
    "kwhOnEstimated" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT '°C',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoilerTemperatureReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoilerUsageAccumulator" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "onSeconds" INTEGER NOT NULL DEFAULT 0,
    "offSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownSeconds" INTEGER NOT NULL DEFAULT 0,
    "efficiencyWeightedOnSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "efficiencyOnSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "lastWasOn" BOOLEAN,
    "lastWasKnown" BOOLEAN,
    "lastSnapshotOnSeconds" INTEGER,
    "lastSnapshotOffSeconds" INTEGER,
    "lastSnapshotUnknownSeconds" INTEGER,
    "lastSnapshotEfficiencyWeightedOnSeconds" DOUBLE PRECISION,
    "lastSnapshotEfficiencyOnSeconds" INTEGER,
    "lastSnapshotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoilerUsageAccumulator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadiatorUsageAccumulator" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "onSeconds" INTEGER NOT NULL DEFAULT 0,
    "offSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "lastWasOn" BOOLEAN,
    "lastWasKnown" BOOLEAN,
    "lastSnapshotOnSeconds" INTEGER,
    "lastSnapshotOffSeconds" INTEGER,
    "lastSnapshotUnknownSeconds" INTEGER,
    "lastSnapshotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadiatorUsageAccumulator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ElectricUsageAccumulator" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "trackingStartedAt" TIMESTAMP(3),
    "trackingEpoch" TEXT NOT NULL,
    "assignmentStartedAt" TIMESTAMP(3),
    "assignmentEpoch" TEXT NOT NULL,
    "sourceAreaId" TEXT,
    "sourceAreaName" TEXT,
    "onSeconds" INTEGER NOT NULL DEFAULT 0,
    "offSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "lastWasOn" BOOLEAN,
    "lastWasKnown" BOOLEAN,
    "retiredAt" TIMESTAMP(3),
    "lastSnapshotOnSeconds" INTEGER,
    "lastSnapshotOffSeconds" INTEGER,
    "lastSnapshotUnknownSeconds" INTEGER,
    "lastSnapshotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ElectricUsageAccumulator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ElectricUsageReading" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "trackingEpoch" TEXT NOT NULL,
    "assignmentEpoch" TEXT NOT NULL,
    "sourceAreaId" TEXT,
    "sourceAreaName" TEXT,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "windowEndedAt" TIMESTAMP(3) NOT NULL,
    "onForSeconds" INTEGER NOT NULL DEFAULT 0,
    "offForSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownForSeconds" INTEGER NOT NULL DEFAULT 0,
    "averageWattsApplied" DOUBLE PRECISION,
    "electricPricePerKwh" DOUBLE PRECISION,
    "estimatedKwh" DOUBLE PRECISION,
    "estimatedCostGbp" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ElectricUsageReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ElectricUsageDailyRollup" (
    "id" SERIAL NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "trackingEpoch" TEXT NOT NULL,
    "assignmentEpoch" TEXT NOT NULL,
    "sourceAreaId" TEXT,
    "sourceAreaName" TEXT,
    "localDate" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "onForSeconds" INTEGER NOT NULL DEFAULT 0,
    "offForSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownForSeconds" INTEGER NOT NULL DEFAULT 0,
    "estimatedKwh" DOUBLE PRECISION,
    "estimatedCostGbp" DOUBLE PRECISION,
    "averageWattsApplied" DOUBLE PRECISION,
    "electricPricePerKwh" DOUBLE PRECISION,
    "configurationMixed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ElectricUsageDailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaAuthCode" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlexaAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomation" (
    "id" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending_delivery',
    "definitionError" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationAction" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "targetValue" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "NativeAutomationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationDelivery" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "bundleRevision" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" JSONB,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "NativeAutomationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationExecution" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "definitionRevision" INTEGER NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeAutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationRequest" (
    "id" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeAutomationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationTrigger" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "NativeAutomationTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaRefreshToken" (
    "id" SERIAL NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlexaRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaSkillUserLink" (
    "id" SERIAL NOT NULL,
    "alexaUserId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "homeId" INTEGER,
    "scope" "AlexaLinkScope" NOT NULL DEFAULT 'TENANT',
    "skillId" TEXT,
    "marketplace" TEXT,
    "locale" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastEventRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlexaSkillUserLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaHomeConnection" (
    "id" TEXT NOT NULL,
    "homeId" INTEGER NOT NULL,
    "hubInstallId" TEXT,
    "status" "AlexaNativeConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "projectionSource" "AlexaProjectionSource" NOT NULL DEFAULT 'HA_LEGACY',
    "linkedByUserId" INTEGER,
    "catalogRevision" TEXT,
    "catalogUpdatedAt" TIMESTAMP(3),
    "stateUpdatedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlexaHomeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaNativeEndpointProjection" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "originalDeviceName" TEXT NOT NULL,
    "originalAreaName" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "manufacturerName" TEXT NOT NULL,
    "modelName" TEXT,
    "description" TEXT NOT NULL,
    "displayCategories" JSONB NOT NULL,
    "controlBindings" JSONB NOT NULL,
    "capabilities" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "catalogRevision" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlexaNativeEndpointProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaConnectIntent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlexaConnectIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaDirectiveReceipt" (
    "id" TEXT NOT NULL,
    "messageIdHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "homeId" INTEGER NOT NULL,
    "endpointId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlexaDirectiveReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaEventToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlexaEventToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewDeviceCommissioningSession" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "requestedArea" TEXT NOT NULL,
    "requestedName" TEXT,
    "requestedDinodiaType" TEXT,
    "requestedHaLabelId" TEXT,
    "requestedDisplayLabel" TEXT,
    "requestedDisplayLabelKey" TEXT,
    "requestedParentHaAreaId" TEXT,
    "requestedVirtualAreaId" TEXT,
    "requestedNewVirtualAreaName" TEXT,
    "haTechnicalName" TEXT,
    "cleanupStatus" "TenantDeviceCleanupStatus" NOT NULL DEFAULT 'ACTIVE',
    "cleanupLastError" TEXT,
    "setupPayloadHash" TEXT,
    "manualPairingCodeHash" TEXT,
    "haFlowId" TEXT,
    "status" "MatterCommissioningStatus" NOT NULL DEFAULT 'CREATED',
    "kind" "CommissioningKind" NOT NULL DEFAULT 'MATTER',
    "error" TEXT,
    "lastHaStep" JSONB,
    "beforeDeviceIds" JSONB,
    "beforeEntityIds" JSONB,
    "afterDeviceIds" JSONB,
    "afterEntityIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewDeviceCommissioningSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaDisplayOverride" (
    "id" TEXT NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "haAreaId" TEXT,
    "haAreaName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayKey" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaDisplayOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelDisplayOverride" (
    "id" TEXT NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "sourceTechnicalLabel" TEXT NOT NULL,
    "canonicalLabel" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayKey" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabelDisplayOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantVirtualArea" (
    "id" TEXT NOT NULL,
    "tenantUserId" INTEGER NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "parentHaAreaId" TEXT,
    "parentHaAreaName" TEXT NOT NULL,
    "parentAreaDisplaySnapshot" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantVirtualArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantDeviceDisplayOverride" (
    "id" TEXT NOT NULL,
    "tenantUserId" INTEGER NOT NULL,
    "tenantUserIdKey" TEXT NOT NULL,
    "haConnectionId" INTEGER NOT NULL,
    "haDeviceId" TEXT,
    "entityId" TEXT,
    "displayName" TEXT NOT NULL,
    "displayNameKey" TEXT NOT NULL,
    "haTechnicalName" TEXT NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "displayLabelKey" TEXT NOT NULL,
    "canonicalLabel" TEXT,
    "parentHaAreaId" TEXT,
    "parentHaAreaName" TEXT NOT NULL,
    "parentAreaDisplaySnapshot" TEXT NOT NULL,
    "tenantVirtualAreaId" TEXT,
    "cleanupStatus" "TenantDeviceCleanupStatus" NOT NULL DEFAULT 'ACTIVE',
    "cleanupReason" "TenantDeviceCleanupReason",
    "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "cleanupLastAttemptAt" TIMESTAMP(3),
    "cleanupLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantDeviceDisplayOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationOwnership" (
    "id" SERIAL NOT NULL,
    "homeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "automationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeAutomation" (
    "homeId" INTEGER NOT NULL,
    "automationId" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "source" "HomeAutomationSource" NOT NULL DEFAULT 'DINODIA_UI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeAutomation_pkey" PRIMARY KEY ("homeId","automationId")
);

-- CreateTable
CREATE TABLE "SupportRequest" (
    "id" TEXT NOT NULL,
    "kind" "SupportRequestKind" NOT NULL,
    "homeId" INTEGER NOT NULL,
    "targetUserId" INTEGER,
    "installerUserId" INTEGER NOT NULL,
    "authChallengeId" TEXT,
    "reason" TEXT,
    "scope" "SupportAccessScope",
    "approvedByUserId" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "approvalValidUntil" TIMESTAMP(3),
    "approvalRecipientType" "SupportApprovalRecipientType",
    "approvalRecipientEmail" TEXT,
    "approvalRecipientName" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" INTEGER,
    "consumedAt" TIMESTAMP(3),
    "haSecurityCodeHash" TEXT,
    "haSecurityCodeIssuedAt" TIMESTAMP(3),
    "haSecurityCodeExpiresAt" TIMESTAMP(3),
    "haSecurityCodeConsumedAt" TIMESTAMP(3),
    "connectButtonClickedAt" TIMESTAMP(3),
    "haSessionStartedAt" TIMESTAMP(3),
    "haSessionExpiresAt" TIMESTAMP(3),
    "haSessionEndedAt" TIMESTAMP(3),
    "haSessionFailureAt" TIMESTAMP(3),
    "haSessionFailureCode" TEXT,
    "haSessionRevokedAt" TIMESTAMP(3),
    "notificationSentAt" TIMESTAMP(3),
    "notificationFailedAt" TIMESTAMP(3),
    "notificationFailureReason" TEXT,
    "supportGatewayHostname" TEXT,
    "launchTicketHash" TEXT,
    "launchTicketExpiresAt" TIMESTAMP(3),
    "gatewaySessionHash" TEXT,
    "gatewaySessionBoundAt" TIMESTAMP(3),
    "gatewaySessionUserAgentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAccessSession" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "assignedEmployeeId" INTEGER NOT NULL,
    "assignedEmployeePrincipalId" TEXT,
    "homeId" INTEGER NOT NULL,
    "targetUserId" INTEGER,
    "scope" TEXT NOT NULL,
    "areaIds" JSONB NOT NULL,
    "includesTenantDevices" BOOLEAN NOT NULL DEFAULT false,
    "codeHash" TEXT,
    "codeIssuedAt" TIMESTAMP(3),
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "codeRevealedAt" TIMESTAMP(3),
    "employeeProofHash" TEXT,
    "employeeProofExpiresAt" TIMESTAMP(3),
    "hubLeaseTokenHash" TEXT,
    "hubLeaseExpiresAt" TIMESTAMP(3),
    "hubRevokePending" BOOLEAN NOT NULL DEFAULT false,
    "hubRevocationDesiredAt" TIMESTAMP(3),
    "hubRevocationAcknowledgedAt" TIMESTAMP(3),
    "hubRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAccessSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage1ClaimReservation" (
    "id" TEXT NOT NULL,
    "hubInstallId" TEXT NOT NULL,
    "hubLabelReferenceHash" TEXT NOT NULL,
    "reservationTokenHash" TEXT,
    "verifiedAccountId" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "reservedAt" TIMESTAMP(3),
    "reservationExpiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "setupCheckpoint" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stage1ClaimReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage1ClaimAudit" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stage1ClaimAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportRequestApprovalToken" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "recipientType" "SupportApprovalRecipientType" NOT NULL,
    "recipientUserId" INTEGER,
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportRequestApprovalToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Home_haConnectionId_key" ON "Home"("haConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Home_claimCodeHash_key" ON "Home"("claimCodeHash");

-- CreateIndex
CREATE INDEX "AuditEvent_homeId_idx" ON "AuditEvent"("homeId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_idx" ON "AuditEvent"("actorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_homeId_idx" ON "User"("homeId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEmployeePrincipal_userId_key" ON "CompanyEmployeePrincipal"("userId");

-- CreateIndex
CREATE INDEX "CompanyEmployeePrincipal_role_active_idx" ON "CompanyEmployeePrincipal"("role", "active");

-- CreateIndex
CREATE INDEX "HomeMembership_homeId_status_role_idx" ON "HomeMembership"("homeId", "status", "role");

-- CreateIndex
CREATE INDEX "HomeMembership_userId_status_idx" ON "HomeMembership"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HomeMembership_userId_homeId_key" ON "HomeMembership"("userId", "homeId");

-- CreateIndex
CREATE INDEX "HomeMembershipAreaGrant_areaId_revokedAt_idx" ON "HomeMembershipAreaGrant"("areaId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HomeMembershipAreaGrant_membershipId_areaId_key" ON "HomeMembershipAreaGrant"("membershipId", "areaId");

-- CreateIndex
CREATE INDEX "PolicyAcceptance_acceptedAt_idx" ON "PolicyAcceptance"("acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAcceptance_userId_policyKind_policyVersion_key" ON "PolicyAcceptance"("userId", "policyKind", "policyVersion");

-- CreateIndex
CREATE INDEX "LoginIntent_userId_idx" ON "LoginIntent"("userId");

-- CreateIndex
CREATE INDEX "LoginIntent_expiresAt_idx" ON "LoginIntent"("expiresAt");

-- CreateIndex
CREATE INDEX "LoginIntent_revokedAt_idx" ON "LoginIntent"("revokedAt");

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");

-- CreateIndex
CREATE INDEX "TrustedDevice_deviceId_idx" ON "TrustedDevice"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_userId_deviceId_key" ON "TrustedDevice"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthChallenge_tokenHash_key" ON "AuthChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthChallenge_userId_idx" ON "AuthChallenge"("userId");

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthChallenge_approvedAt_idx" ON "AuthChallenge"("approvedAt");

-- CreateIndex
CREATE INDEX "StepUpApproval_userId_deviceId_purpose_idx" ON "StepUpApproval"("userId", "deviceId", "purpose");

-- CreateIndex
CREATE INDEX "StepUpApproval_deviceId_idx" ON "StepUpApproval"("deviceId");

-- CreateIndex
CREATE INDEX "StepUpApproval_homeId_operationDigest_expiresAt_idx" ON "StepUpApproval"("homeId", "operationDigest", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RemoteAccessLease_tokenHash_key" ON "RemoteAccessLease"("tokenHash");

-- CreateIndex
CREATE INDEX "RemoteAccessLease_userId_deviceId_purpose_idx" ON "RemoteAccessLease"("userId", "deviceId", "purpose");

-- CreateIndex
CREATE INDEX "RemoteAccessLease_expiresAt_idx" ON "RemoteAccessLease"("expiresAt");

-- CreateIndex
CREATE INDEX "RemoteAccessLease_deviceId_idx" ON "RemoteAccessLease"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "HaConnection_longLivedTokenHash_key" ON "HaConnection"("longLivedTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "HaConnection_ownerId_key" ON "HaConnection"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstall_serial_key" ON "HubInstall"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstall_manufacturingIdentityId_key" ON "HubInstall"("manufacturingIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "HubInstall_homeId_key" ON "HubInstall"("homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HubManufacturingIdentity_serial_key" ON "HubManufacturingIdentity"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "HubManufacturingIdentity_publicKeyFingerprint_key" ON "HubManufacturingIdentity"("publicKeyFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "HubManufacturingIdentity_encryptionKeyFingerprint_key" ON "HubManufacturingIdentity"("encryptionKeyFingerprint");

-- CreateIndex
CREATE INDEX "HubManufacturingIdentity_status_revokedAt_idx" ON "HubManufacturingIdentity"("status", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HubProvisioningAttempt_attemptId_key" ON "HubProvisioningAttempt"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "HubProvisioningAttempt_codeHash_key" ON "HubProvisioningAttempt"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "HubProvisioningAttempt_challengeHash_key" ON "HubProvisioningAttempt"("challengeHash");

-- CreateIndex
CREATE UNIQUE INDEX "HubProvisioningAttempt_machineCredentialHash_key" ON "HubProvisioningAttempt"("machineCredentialHash");

-- CreateIndex
CREATE INDEX "HubProvisioningAttempt_serial_state_expiresAt_idx" ON "HubProvisioningAttempt"("serial", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "HubProvisioningAttempt_identityId_createdAt_idx" ON "HubProvisioningAttempt"("identityId", "createdAt");

-- CreateIndex
CREATE INDEX "HubProvisioningAttempt_provisioningOperatorId_provisioningW_idx" ON "HubProvisioningAttempt"("provisioningOperatorId", "provisioningWorkflowId", "state");

-- CreateIndex
CREATE INDEX "OsOperatorWorkflow_homeId_workflowType_status_idx" ON "OsOperatorWorkflow"("homeId", "workflowType", "status");

-- CreateIndex
CREATE INDEX "OsOperatorWorkflow_hubInstallId_assignedEmployeeId_status_idx" ON "OsOperatorWorkflow"("hubInstallId", "assignedEmployeeId", "status");

-- CreateIndex
CREATE INDEX "HubIncident_homeId_state_lastObservedAt_idx" ON "HubIncident"("homeId", "state", "lastObservedAt");

-- CreateIndex
CREATE INDEX "HubIncident_hubInstallId_lastObservedAt_idx" ON "HubIncident"("hubInstallId", "lastObservedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HubIncident_hubInstallId_incidentId_key" ON "HubIncident"("hubInstallId", "incidentId");

-- CreateIndex
CREATE INDEX "HomeownerPolicyAcceptance_homeId_idx" ON "HomeownerPolicyAcceptance"("homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeownerPolicyAcceptance_homeownerUserId_policyVersion_key" ON "HomeownerPolicyAcceptance"("homeownerUserId", "policyVersion");

-- CreateIndex
CREATE INDEX "HomeownerPolicyNotificationDelivery_homeId_status_idx" ON "HomeownerPolicyNotificationDelivery"("homeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HomeownerPolicyNotificationDelivery_acceptanceId_recipientT_key" ON "HomeownerPolicyNotificationDelivery"("acceptanceId", "recipientType");

-- CreateIndex
CREATE INDEX "PendingHomeownerOnboarding_flowType_idx" ON "PendingHomeownerOnboarding"("flowType");

-- CreateIndex
CREATE INDEX "PendingHomeownerOnboarding_expiresAt_idx" ON "PendingHomeownerOnboarding"("expiresAt");

-- CreateIndex
CREATE INDEX "PendingHomeownerOnboarding_homeId_idx" ON "PendingHomeownerOnboarding"("homeId");

-- CreateIndex
CREATE INDEX "PendingHomeownerOnboarding_userId_idx" ON "PendingHomeownerOnboarding"("userId");

-- CreateIndex
CREATE INDEX "PendingHomeownerOnboarding_hubInstallId_idx" ON "PendingHomeownerOnboarding"("hubInstallId");

-- CreateIndex
CREATE INDEX "PendingHomeownerOnboarding_claimCodeHash_idx" ON "PendingHomeownerOnboarding"("claimCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "HubOperatorCredential_tokenHash_key" ON "HubOperatorCredential"("tokenHash");

-- CreateIndex
CREATE INDEX "HubOperatorCredential_hubInstallId_status_idx" ON "HubOperatorCredential"("hubInstallId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HubOperatorCredential_hubInstallId_version_key" ON "HubOperatorCredential"("hubInstallId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorSessionHandoff_tokenHash_key" ON "OperatorSessionHandoff"("tokenHash");

-- CreateIndex
CREATE INDEX "OperatorSessionHandoff_employeeId_homeId_expiresAt_idx" ON "OperatorSessionHandoff"("employeeId", "homeId", "expiresAt");

-- CreateIndex
CREATE INDEX "OperatorSessionHandoff_hubInstallId_workflowId_idx" ON "OperatorSessionHandoff"("hubInstallId", "workflowId");

-- CreateIndex
CREATE INDEX "HubToken_hubInstallId_status_idx" ON "HubToken"("hubInstallId", "status");

-- CreateIndex
CREATE INDEX "HubToken_tokenHash_idx" ON "HubToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "HubToken_hubInstallId_version_key" ON "HubToken"("hubInstallId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "HubToken_hubInstallId_tokenHash_key" ON "HubToken"("hubInstallId", "tokenHash");

-- CreateIndex
CREATE INDEX "HubAgentNonce_createdAt_idx" ON "HubAgentNonce"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HubAgentNonce_serial_nonce_key" ON "HubAgentNonce"("serial", "nonce");

-- CreateIndex
CREATE INDEX "HomeContact_homeId_idx" ON "HomeContact"("homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeContact_homeId_type_key" ON "HomeContact"("homeId", "type");

-- CreateIndex
CREATE INDEX "Room_hubInstallId_idx" ON "Room"("hubInstallId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_hubInstallId_haAreaName_key" ON "Room"("hubInstallId", "haAreaName");

-- CreateIndex
CREATE INDEX "RoomAccessRequest_hubInstallId_idx" ON "RoomAccessRequest"("hubInstallId");

-- CreateIndex
CREATE INDEX "RoomAccessRequest_roomId_idx" ON "RoomAccessRequest"("roomId");

-- CreateIndex
CREATE INDEX "RoomAccessRequest_status_idx" ON "RoomAccessRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RoomAccessApprovalToken_tokenHash_key" ON "RoomAccessApprovalToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RoomAccessApprovalToken_requestId_idx" ON "RoomAccessApprovalToken"("requestId");

-- CreateIndex
CREATE INDEX "RoomAccessApprovalToken_expiresAt_idx" ON "RoomAccessApprovalToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_haConnectionId_entityId_key" ON "Device"("haConnectionId", "entityId");

-- CreateIndex
CREATE INDEX "MonitoringReading_haConnectionId_entityId_capturedAt_idx" ON "MonitoringReading"("haConnectionId", "entityId", "capturedAt");

-- CreateIndex
CREATE INDEX "MonitoringReading_haConnectionId_capturedAt_valid_idx" ON "MonitoringReading"("haConnectionId", "capturedAt");

-- CreateIndex
CREATE INDEX "BoilerTemperatureReading_haConnectionId_entityId_capturedAt_idx" ON "BoilerTemperatureReading"("haConnectionId", "entityId", "capturedAt");

-- CreateIndex
CREATE INDEX "BoilerTemperatureReading_haConnectionId_capturedAt_idx" ON "BoilerTemperatureReading"("haConnectionId", "capturedAt");

-- CreateIndex
CREATE INDEX "BoilerUsageAccumulator_haConnectionId_idx" ON "BoilerUsageAccumulator"("haConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "BoilerUsageAccumulator_haConnectionId_entityId_key" ON "BoilerUsageAccumulator"("haConnectionId", "entityId");

-- CreateIndex
CREATE INDEX "RadiatorUsageAccumulator_haConnectionId_idx" ON "RadiatorUsageAccumulator"("haConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "RadiatorUsageAccumulator_haConnectionId_entityId_key" ON "RadiatorUsageAccumulator"("haConnectionId", "entityId");

-- CreateIndex
CREATE INDEX "ElectricUsageAccumulator_haConnectionId_idx" ON "ElectricUsageAccumulator"("haConnectionId");

-- CreateIndex
CREATE INDEX "ElectricUsageAccumulator_haConnectionId_updatedAt_idx" ON "ElectricUsageAccumulator"("haConnectionId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ElectricUsageAccumulator_haConnectionId_entityId_key" ON "ElectricUsageAccumulator"("haConnectionId", "entityId");

-- CreateIndex
CREATE INDEX "ElectricUsageReading_haConnectionId_entityId_capturedAt_idx" ON "ElectricUsageReading"("haConnectionId", "entityId", "capturedAt");

-- CreateIndex
CREATE INDEX "ElectricUsageReading_haConnectionId_capturedAt_idx" ON "ElectricUsageReading"("haConnectionId", "capturedAt");

-- CreateIndex
CREATE INDEX "ElectricUsageReading_haConnectionId_sourceAreaId_capturedAt_idx" ON "ElectricUsageReading"("haConnectionId", "sourceAreaId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ElectricUsageReading_haConnectionId_entityId_windowStartedA_key" ON "ElectricUsageReading"("haConnectionId", "entityId", "windowStartedAt", "assignmentEpoch");

-- CreateIndex
CREATE INDEX "ElectricUsageDailyRollup_haConnectionId_localDate_idx" ON "ElectricUsageDailyRollup"("haConnectionId", "localDate");

-- CreateIndex
CREATE INDEX "ElectricUsageDailyRollup_haConnectionId_sourceAreaId_localD_idx" ON "ElectricUsageDailyRollup"("haConnectionId", "sourceAreaId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "ElectricUsageDailyRollup_haConnectionId_entityId_localDate__key" ON "ElectricUsageDailyRollup"("haConnectionId", "entityId", "localDate", "assignmentEpoch");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaAuthCode_code_key" ON "AlexaAuthCode"("code");

-- CreateIndex
CREATE INDEX "NativeAutomation_homeId_ownerUserId_idx" ON "NativeAutomation"("homeId", "ownerUserId");

-- CreateIndex
CREATE INDEX "NativeAutomation_homeId_status_idx" ON "NativeAutomation"("homeId", "status");

-- CreateIndex
CREATE INDEX "NativeAutomationAction_deviceId_controlId_idx" ON "NativeAutomationAction"("deviceId", "controlId");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomationAction_automationId_deviceId_controlId_key" ON "NativeAutomationAction"("automationId", "deviceId", "controlId");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomationAction_automationId_sortOrder_key" ON "NativeAutomationAction"("automationId", "sortOrder");

-- CreateIndex
CREATE INDEX "NativeAutomationDelivery_hubInstallId_bundleRevision_idx" ON "NativeAutomationDelivery"("hubInstallId", "bundleRevision");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomationDelivery_automationId_hubInstallId_revision_key" ON "NativeAutomationDelivery"("automationId", "hubInstallId", "revision");

-- CreateIndex
CREATE INDEX "NativeAutomationExecution_automationId_triggeredAt_idx" ON "NativeAutomationExecution"("automationId", "triggeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomationExecution_homeId_occurrenceId_key" ON "NativeAutomationExecution"("homeId", "occurrenceId");

-- CreateIndex
CREATE INDEX "NativeAutomationRequest_createdAt_idx" ON "NativeAutomationRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomationRequest_homeId_userId_idempotencyKey_key" ON "NativeAutomationRequest"("homeId", "userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomationTrigger_automationId_sortOrder_key" ON "NativeAutomationTrigger"("automationId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaRefreshToken_tokenHash_key" ON "AlexaRefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaSkillUserLink_alexaUserId_key" ON "AlexaSkillUserLink"("alexaUserId");

-- CreateIndex
CREATE INDEX "AlexaSkillUserLink_userId_idx" ON "AlexaSkillUserLink"("userId");

-- CreateIndex
CREATE INDEX "AlexaSkillUserLink_homeId_scope_idx" ON "AlexaSkillUserLink"("homeId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaHomeConnection_homeId_key" ON "AlexaHomeConnection"("homeId");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaHomeConnection_hubInstallId_key" ON "AlexaHomeConnection"("hubInstallId");

-- CreateIndex
CREATE INDEX "AlexaHomeConnection_status_updatedAt_idx" ON "AlexaHomeConnection"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AlexaHomeConnection_linkedByUserId_idx" ON "AlexaHomeConnection"("linkedByUserId");

-- CreateIndex
CREATE INDEX "AlexaNativeEndpointProjection_endpointId_idx" ON "AlexaNativeEndpointProjection"("endpointId");

-- CreateIndex
CREATE INDEX "AlexaNativeEndpointProjection_connectionId_areaId_idx" ON "AlexaNativeEndpointProjection"("connectionId", "areaId");

-- CreateIndex
CREATE INDEX "AlexaNativeEndpointProjection_connectionId_deviceId_idx" ON "AlexaNativeEndpointProjection"("connectionId", "deviceId");

-- CreateIndex
CREATE INDEX "AlexaNativeEndpointProjection_connectionId_retiredAt_idx" ON "AlexaNativeEndpointProjection"("connectionId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaNativeEndpointProjection_connectionId_endpointId_key" ON "AlexaNativeEndpointProjection"("connectionId", "endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaConnectIntent_tokenHash_key" ON "AlexaConnectIntent"("tokenHash");

-- CreateIndex
CREATE INDEX "AlexaConnectIntent_connectionId_expiresAt_idx" ON "AlexaConnectIntent"("connectionId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaDirectiveReceipt_messageIdHash_key" ON "AlexaDirectiveReceipt"("messageIdHash");

-- CreateIndex
CREATE INDEX "AlexaDirectiveReceipt_expiresAt_idx" ON "AlexaDirectiveReceipt"("expiresAt");

-- CreateIndex
CREATE INDEX "AlexaDirectiveReceipt_homeId_createdAt_idx" ON "AlexaDirectiveReceipt"("homeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaEventToken_userId_key" ON "AlexaEventToken"("userId");

-- CreateIndex
CREATE INDEX "NewDeviceCommissioningSession_userId_idx" ON "NewDeviceCommissioningSession"("userId");

-- CreateIndex
CREATE INDEX "NewDeviceCommissioningSession_haConnectionId_idx" ON "NewDeviceCommissioningSession"("haConnectionId");

-- CreateIndex
CREATE INDEX "NewDeviceCommissioningSession_haFlowId_idx" ON "NewDeviceCommissioningSession"("haFlowId");

-- CreateIndex
CREATE INDEX "NewDeviceCommissioningSession_kind_idx" ON "NewDeviceCommissioningSession"("kind");

-- CreateIndex
CREATE INDEX "AreaDisplayOverride_haConnectionId_displayKey_idx" ON "AreaDisplayOverride"("haConnectionId", "displayKey");

-- CreateIndex
CREATE UNIQUE INDEX "AreaDisplayOverride_haConnectionId_haAreaName_key" ON "AreaDisplayOverride"("haConnectionId", "haAreaName");

-- CreateIndex
CREATE INDEX "LabelDisplayOverride_haConnectionId_displayKey_idx" ON "LabelDisplayOverride"("haConnectionId", "displayKey");

-- CreateIndex
CREATE UNIQUE INDEX "LabelDisplayOverride_haConnectionId_sourceTechnicalLabel_key" ON "LabelDisplayOverride"("haConnectionId", "sourceTechnicalLabel");

-- CreateIndex
CREATE INDEX "TenantVirtualArea_tenantUserId_haConnectionId_idx" ON "TenantVirtualArea"("tenantUserId", "haConnectionId");

-- CreateIndex
CREATE INDEX "TenantVirtualArea_haConnectionId_parentHaAreaName_idx" ON "TenantVirtualArea"("haConnectionId", "parentHaAreaName");

-- CreateIndex
CREATE UNIQUE INDEX "TenantVirtualArea_tenantUserId_haConnectionId_parentHaAreaN_key" ON "TenantVirtualArea"("tenantUserId", "haConnectionId", "parentHaAreaName", "displayKey");

-- CreateIndex
CREATE INDEX "TenantDeviceDisplayOverride_tenantUserId_haConnectionId_idx" ON "TenantDeviceDisplayOverride"("tenantUserId", "haConnectionId");

-- CreateIndex
CREATE INDEX "TenantDeviceDisplayOverride_haConnectionId_haDeviceId_idx" ON "TenantDeviceDisplayOverride"("haConnectionId", "haDeviceId");

-- CreateIndex
CREATE INDEX "TenantDeviceDisplayOverride_haConnectionId_entityId_idx" ON "TenantDeviceDisplayOverride"("haConnectionId", "entityId");

-- CreateIndex
CREATE INDEX "TenantDeviceDisplayOverride_haConnectionId_cleanupStatus_idx" ON "TenantDeviceDisplayOverride"("haConnectionId", "cleanupStatus");

-- CreateIndex
CREATE UNIQUE INDEX "TenantDeviceDisplayOverride_tenantUserId_haConnectionId_dis_key" ON "TenantDeviceDisplayOverride"("tenantUserId", "haConnectionId", "displayNameKey");

-- CreateIndex
CREATE INDEX "AutomationOwnership_homeId_idx" ON "AutomationOwnership"("homeId");

-- CreateIndex
CREATE INDEX "AutomationOwnership_userId_idx" ON "AutomationOwnership"("userId");

-- CreateIndex
CREATE INDEX "AutomationOwnership_automationId_idx" ON "AutomationOwnership"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationOwnership_automationId_homeId_key" ON "AutomationOwnership"("automationId", "homeId");

-- CreateIndex
CREATE INDEX "HomeAutomation_homeId_idx" ON "HomeAutomation"("homeId");

-- CreateIndex
CREATE INDEX "HomeAutomation_createdByUserId_idx" ON "HomeAutomation"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportRequest_authChallengeId_key" ON "SupportRequest"("authChallengeId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportRequest_launchTicketHash_key" ON "SupportRequest"("launchTicketHash");

-- CreateIndex
CREATE UNIQUE INDEX "SupportRequest_gatewaySessionHash_key" ON "SupportRequest"("gatewaySessionHash");

-- CreateIndex
CREATE INDEX "SupportRequest_homeId_idx" ON "SupportRequest"("homeId");

-- CreateIndex
CREATE INDEX "SupportRequest_targetUserId_idx" ON "SupportRequest"("targetUserId");

-- CreateIndex
CREATE INDEX "SupportRequest_installerUserId_idx" ON "SupportRequest"("installerUserId");

-- CreateIndex
CREATE INDEX "SupportRequest_approvedByUserId_idx" ON "SupportRequest"("approvedByUserId");

-- CreateIndex
CREATE INDEX "SupportRequest_revokedByUserId_idx" ON "SupportRequest"("revokedByUserId");

-- CreateIndex
CREATE INDEX "SupportRequest_approvalValidUntil_idx" ON "SupportRequest"("approvalValidUntil");

-- CreateIndex
CREATE INDEX "SupportRequest_haSessionExpiresAt_idx" ON "SupportRequest"("haSessionExpiresAt");

-- CreateIndex
CREATE INDEX "SupportRequest_supportGatewayHostname_idx" ON "SupportRequest"("supportGatewayHostname");

-- CreateIndex
CREATE UNIQUE INDEX "SupportAccessSession_codeHash_key" ON "SupportAccessSession"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "SupportAccessSession_employeeProofHash_key" ON "SupportAccessSession"("employeeProofHash");

-- CreateIndex
CREATE UNIQUE INDEX "SupportAccessSession_hubLeaseTokenHash_key" ON "SupportAccessSession"("hubLeaseTokenHash");

-- CreateIndex
CREATE INDEX "SupportAccessSession_supportRequestId_status_idx" ON "SupportAccessSession"("supportRequestId", "status");

-- CreateIndex
CREATE INDEX "SupportAccessSession_assignedEmployeeId_status_idx" ON "SupportAccessSession"("assignedEmployeeId", "status");

-- CreateIndex
CREATE INDEX "SupportAccessSession_homeId_status_idx" ON "SupportAccessSession"("homeId", "status");

-- CreateIndex
CREATE INDEX "SupportAccessSession_expiresAt_idx" ON "SupportAccessSession"("expiresAt");

-- CreateIndex
CREATE INDEX "SupportAccessSession_approvedByUserId_idx" ON "SupportAccessSession"("approvedByUserId");

-- CreateIndex
CREATE INDEX "SupportAccessSession_assignedEmployeePrincipalId_status_idx" ON "SupportAccessSession"("assignedEmployeePrincipalId", "status");

-- CreateIndex
CREATE INDEX "SupportAccessSession_hubLeaseExpiresAt_idx" ON "SupportAccessSession"("hubLeaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Stage1ClaimReservation_hubLabelReferenceHash_key" ON "Stage1ClaimReservation"("hubLabelReferenceHash");

-- CreateIndex
CREATE UNIQUE INDEX "Stage1ClaimReservation_reservationTokenHash_key" ON "Stage1ClaimReservation"("reservationTokenHash");

-- CreateIndex
CREATE INDEX "Stage1ClaimReservation_hubInstallId_state_idx" ON "Stage1ClaimReservation"("hubInstallId", "state");

-- CreateIndex
CREATE INDEX "Stage1ClaimReservation_reservationExpiresAt_idx" ON "Stage1ClaimReservation"("reservationExpiresAt");

-- CreateIndex
CREATE INDEX "Stage1ClaimAudit_reservationId_createdAt_idx" ON "Stage1ClaimAudit"("reservationId", "createdAt");

-- CreateIndex
CREATE INDEX "Stage1ClaimAudit_actorUserId_createdAt_idx" ON "Stage1ClaimAudit"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportRequestApprovalToken_tokenHash_key" ON "SupportRequestApprovalToken"("tokenHash");

-- CreateIndex
CREATE INDEX "SupportRequestApprovalToken_supportRequestId_idx" ON "SupportRequestApprovalToken"("supportRequestId");

-- CreateIndex
CREATE INDEX "SupportRequestApprovalToken_expiresAt_idx" ON "SupportRequestApprovalToken"("expiresAt");

-- CreateIndex
CREATE INDEX "SupportRequestApprovalToken_recipientUserId_idx" ON "SupportRequestApprovalToken"("recipientUserId");

-- AddForeignKey
ALTER TABLE "Home" ADD CONSTRAINT "Home_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEmployeePrincipal" ADD CONSTRAINT "CompanyEmployeePrincipal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeMembership" ADD CONSTRAINT "HomeMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeMembership" ADD CONSTRAINT "HomeMembership_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeMembershipAreaGrant" ADD CONSTRAINT "HomeMembershipAreaGrant_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAcceptance" ADD CONSTRAINT "PolicyAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginIntent" ADD CONSTRAINT "LoginIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthChallenge" ADD CONSTRAINT "AuthChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpApproval" ADD CONSTRAINT "StepUpApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpApproval" ADD CONSTRAINT "StepUpApproval_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteAccessLease" ADD CONSTRAINT "RemoteAccessLease_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HaConnection" ADD CONSTRAINT "HaConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubInstall" ADD CONSTRAINT "HubInstall_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubInstall" ADD CONSTRAINT "HubInstall_manufacturingIdentityId_fkey" FOREIGN KEY ("manufacturingIdentityId") REFERENCES "HubManufacturingIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubProvisioningAttempt" ADD CONSTRAINT "HubProvisioningAttempt_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "HubManufacturingIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubIncident" ADD CONSTRAINT "HubIncident_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubIncident" ADD CONSTRAINT "HubIncident_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeownerPolicyAcceptance" ADD CONSTRAINT "HomeownerPolicyAcceptance_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeownerPolicyAcceptance" ADD CONSTRAINT "HomeownerPolicyAcceptance_homeownerUserId_fkey" FOREIGN KEY ("homeownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeownerPolicyNotificationDelivery" ADD CONSTRAINT "HomeownerPolicyNotificationDelivery_acceptanceId_fkey" FOREIGN KEY ("acceptanceId") REFERENCES "HomeownerPolicyAcceptance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeownerPolicyNotificationDelivery" ADD CONSTRAINT "HomeownerPolicyNotificationDelivery_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingHomeownerOnboarding" ADD CONSTRAINT "PendingHomeownerOnboarding_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingHomeownerOnboarding" ADD CONSTRAINT "PendingHomeownerOnboarding_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingHomeownerOnboarding" ADD CONSTRAINT "PendingHomeownerOnboarding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubOperatorCredential" ADD CONSTRAINT "HubOperatorCredential_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubToken" ADD CONSTRAINT "HubToken_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRule" ADD CONSTRAINT "AccessRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeContact" ADD CONSTRAINT "HomeContact_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAccessRequest" ADD CONSTRAINT "RoomAccessRequest_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAccessRequest" ADD CONSTRAINT "RoomAccessRequest_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAccessRequest" ADD CONSTRAINT "RoomAccessRequest_tenantUserId_fkey" FOREIGN KEY ("tenantUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomAccessApprovalToken" ADD CONSTRAINT "RoomAccessApprovalToken_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RoomAccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringReading" ADD CONSTRAINT "MonitoringReading_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoilerTemperatureReading" ADD CONSTRAINT "BoilerTemperatureReading_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoilerUsageAccumulator" ADD CONSTRAINT "BoilerUsageAccumulator_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadiatorUsageAccumulator" ADD CONSTRAINT "RadiatorUsageAccumulator_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectricUsageAccumulator" ADD CONSTRAINT "ElectricUsageAccumulator_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectricUsageReading" ADD CONSTRAINT "ElectricUsageReading_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectricUsageDailyRollup" ADD CONSTRAINT "ElectricUsageDailyRollup_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaAuthCode" ADD CONSTRAINT "AlexaAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomation" ADD CONSTRAINT "NativeAutomation_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomation" ADD CONSTRAINT "NativeAutomation_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationAction" ADD CONSTRAINT "NativeAutomationAction_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "NativeAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationDelivery" ADD CONSTRAINT "NativeAutomationDelivery_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "NativeAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationDelivery" ADD CONSTRAINT "NativeAutomationDelivery_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationExecution" ADD CONSTRAINT "NativeAutomationExecution_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "NativeAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationExecution" ADD CONSTRAINT "NativeAutomationExecution_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationRequest" ADD CONSTRAINT "NativeAutomationRequest_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationRequest" ADD CONSTRAINT "NativeAutomationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationTrigger" ADD CONSTRAINT "NativeAutomationTrigger_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "NativeAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaRefreshToken" ADD CONSTRAINT "AlexaRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaSkillUserLink" ADD CONSTRAINT "AlexaSkillUserLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaSkillUserLink" ADD CONSTRAINT "AlexaSkillUserLink_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaHomeConnection" ADD CONSTRAINT "AlexaHomeConnection_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaHomeConnection" ADD CONSTRAINT "AlexaHomeConnection_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaHomeConnection" ADD CONSTRAINT "AlexaHomeConnection_linkedByUserId_fkey" FOREIGN KEY ("linkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaNativeEndpointProjection_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AlexaHomeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaConnectIntent" ADD CONSTRAINT "AlexaConnectIntent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AlexaHomeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaEventToken" ADD CONSTRAINT "AlexaEventToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewDeviceCommissioningSession" ADD CONSTRAINT "NewDeviceCommissioningSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewDeviceCommissioningSession" ADD CONSTRAINT "NewDeviceCommissioningSession_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaDisplayOverride" ADD CONSTRAINT "AreaDisplayOverride_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaDisplayOverride" ADD CONSTRAINT "AreaDisplayOverride_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelDisplayOverride" ADD CONSTRAINT "LabelDisplayOverride_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelDisplayOverride" ADD CONSTRAINT "LabelDisplayOverride_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantVirtualArea" ADD CONSTRAINT "TenantVirtualArea_tenantUserId_fkey" FOREIGN KEY ("tenantUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantVirtualArea" ADD CONSTRAINT "TenantVirtualArea_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantDeviceDisplayOverride" ADD CONSTRAINT "TenantDeviceDisplayOverride_tenantUserId_fkey" FOREIGN KEY ("tenantUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantDeviceDisplayOverride" ADD CONSTRAINT "TenantDeviceDisplayOverride_haConnectionId_fkey" FOREIGN KEY ("haConnectionId") REFERENCES "HaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantDeviceDisplayOverride" ADD CONSTRAINT "TenantDeviceDisplayOverride_tenantVirtualAreaId_fkey" FOREIGN KEY ("tenantVirtualAreaId") REFERENCES "TenantVirtualArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOwnership" ADD CONSTRAINT "AutomationOwnership_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationOwnership" ADD CONSTRAINT "AutomationOwnership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeAutomation" ADD CONSTRAINT "HomeAutomation_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeAutomation" ADD CONSTRAINT "HomeAutomation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessSession" ADD CONSTRAINT "SupportAccessSession_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage1ClaimReservation" ADD CONSTRAINT "Stage1ClaimReservation_hubInstallId_fkey" FOREIGN KEY ("hubInstallId") REFERENCES "HubInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage1ClaimAudit" ADD CONSTRAINT "Stage1ClaimAudit_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Stage1ClaimReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage1ClaimAudit" ADD CONSTRAINT "Stage1ClaimAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequestApprovalToken" ADD CONSTRAINT "SupportRequestApprovalToken_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
