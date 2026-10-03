-- CreateEnum
CREATE TYPE "HubInstallationLifecycle" AS ENUM ('PENDING', 'ACTIVE', 'REPLACED', 'REVOKED');

-- CreateEnum
CREATE TYPE "NativeCommissioningState" AS ENUM ('REQUESTED', 'ADVERTISING', 'READY', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "PermanentDeviceInstallationRequestStatus" AS ENUM ('SUBMITTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PermanentDeviceInstallationCategory" AS ENUM ('LIGHTING', 'HEATING', 'SECURITY', 'OTHER');

-- CreateEnum
CREATE TYPE "NativeAutomationStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'NEEDS_ATTENTION', 'RETIRED');

-- CreateEnum
CREATE TYPE "NativeAutomationExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AlexaNativeLinkStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AlexaNativeEndpointStatus" AS ENUM ('ACTIVE', 'NEEDS_ATTENTION', 'REVOKED');

-- CreateEnum
CREATE TYPE "NativeNotificationChannel" AS ENUM ('PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "NativeNotificationFamily" AS ENUM ('OWNER_HUB_AVAILABILITY', 'OWNER_PERMANENT_DEVICE_OUTAGE', 'OWNER_NEW_PERMANENT_DEVICE', 'OWNER_TENANT_ACCESS_REQUEST', 'OWNER_INSTALLATION_UPDATE', 'OWNER_AUTOMATION_ACTIVITY', 'TENANT_HUB_AVAILABILITY', 'TENANT_AUTHORIZED_AREA_DEVICE_OUTAGE', 'TENANT_OWN_DEVICE_OUTAGE', 'TENANT_NEW_PERMANENT_DEVICE', 'TENANT_AUTOMATION_FAILURE', 'TENANT_ACCESS_REQUEST_DECISION');

-- CreateEnum
CREATE TYPE "NativeNotificationDestinationKind" AS ENUM ('DEVICE_INFORMATION', 'TENANT_DEVICE_DETAIL');

-- CreateEnum
CREATE TYPE "NativeDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NativeApnsEnvironment" AS ENUM ('DEVELOPMENT', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "ExceptionalOwnershipTransferStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'DENIED', 'CANCELLED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NativeTaskDispatcher" AS ENUM ('OPERATIONS', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "NativeSupportCategory" AS ENUM ('ACCOUNT_OR_SIGN_IN', 'ACCESS_OR_PERMISSIONS', 'DEVICE_PROBLEM', 'HUB_OR_CONNECTION', 'AUTOMATION', 'ALEXA', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HomeLifecycle" ADD VALUE 'SUSPENDED';
ALTER TYPE "HomeLifecycle" ADD VALUE 'RETIRED';

-- AlterEnum
ALTER TYPE "InstallationStatus" ADD VALUE 'PROVISIONING';

-- AlterEnum
ALTER TYPE "DeviceLifecycleState" ADD VALUE 'RECOMMISSION_REQUIRED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SupportTicketStatus" ADD VALUE 'NEW';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'REVIEWING';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'WAITING_FOR_CUSTOMER';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'ACCESS_REQUESTED';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'ACCESS_APPROVED';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'INVESTIGATING';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'WAITING_FOR_VISIT';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'RESOLVED';

-- DropIndex
DROP INDEX "HubInstallation_homeId_key";

-- AlterTable
ALTER TABLE "TrustedDevice" ADD COLUMN     "apnsEnvironment" "NativeApnsEnvironment",
ADD COLUMN     "apnsKeyVersion" INTEGER,
ADD COLUMN     "apnsTokenCiphertext" TEXT,
ADD COLUMN     "apnsTokenRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDeliveryHealth" VARCHAR(40),
ADD COLUMN     "pushEnabledAt" TIMESTAMP(3),
ADD COLUMN     "pushRevokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Home" ADD COLUMN     "activeHubInstallationId" UUID,
ADD COLUMN     "installationCompletedByEmployeeId" UUID,
ADD COLUMN     "installationReopenReason" VARCHAR(500),
ADD COLUMN     "installationReopenedAt" TIMESTAMP(3),
ADD COLUMN     "installationReopenedByEmployeeId" UUID;

-- AlterTable
ALTER TABLE "NativeDevice" ALTER COLUMN "customerLabel" SET DATA TYPE VARCHAR(40);

-- AlterTable
ALTER TABLE "HubInstallation" ADD COLUMN     "cloudUrlReportedAt" TIMESTAMP(3),
ADD COLUMN     "installationGeneration" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "lifecycleStatus" "HubInstallationLifecycle" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "replacedAt" TIMESTAMP(3),
ADD COLUMN     "replacesHubInstallationId" UUID,
ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PendingHomeSetup" ADD COLUMN     "retainedAddressConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "retainedAddressConfirmedByAccountId" UUID,
ADD COLUMN     "retainedAddressDigest" VARCHAR(128),
ADD COLUMN     "retainedAddressRevision" INTEGER;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "areaId" UUID,
ADD COLUMN     "customerResolution" VARCHAR(2000),
ADD COLUMN     "deviceId" UUID,
ADD COLUMN     "nativeCategory" "NativeSupportCategory",
ADD COLUMN     "purgeAt" TIMESTAMP(3),
ADD COLUMN     "requesterEmailHash" VARCHAR(128),
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "safeDiagnostics" JSONB,
ADD COLUMN     "title" VARCHAR(200),
ALTER COLUMN "customerAccountId" DROP NOT NULL,
ALTER COLUMN "homeId" DROP NOT NULL,
ALTER COLUMN "selectedMembershipId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AreaSourceAlias" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "hubInstallationId" UUID NOT NULL,
    "sourceAreaId" VARCHAR(160) NOT NULL,
    "protocol" VARCHAR(40) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "AreaSourceAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeDeviceSourceAlias" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "hubInstallationId" UUID NOT NULL,
    "sourceDeviceId" VARCHAR(200) NOT NULL,
    "protocol" VARCHAR(40) NOT NULL,
    "protocolIdentityHash" VARCHAR(128),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "NativeDeviceSourceAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermanentDeviceInstallationRequest" (
    "id" UUID NOT NULL,
    "customerReference" VARCHAR(32) NOT NULL,
    "homeId" UUID NOT NULL,
    "requestedAreaId" UUID,
    "requesterMembershipId" UUID NOT NULL,
    "category" "PermanentDeviceInstallationCategory" NOT NULL,
    "customerNotes" VARCHAR(1000),
    "status" "PermanentDeviceInstallationRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "operationsEmailKey" VARCHAR(128) NOT NULL,
    "operationsEmailSentAt" TIMESTAMP(3),
    "workStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermanentDeviceInstallationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeCommissioningSession" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "hubInstallationId" UUID NOT NULL,
    "requestingMembershipId" UUID NOT NULL,
    "requestedAreaId" UUID,
    "requestedName" VARCHAR(160) NOT NULL,
    "customerLabel" VARCHAR(40),
    "managementClass" "DeviceManagementClass" NOT NULL,
    "protocol" VARCHAR(40) NOT NULL,
    "state" "NativeCommissioningState" NOT NULL DEFAULT 'REQUESTED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "finalDeviceId" UUID,
    "idempotencyKeyHash" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeCommissioningSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeDeviceUsageBucket" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "analyticsCategory" "DeviceAnalyticsCategory" NOT NULL,
    "controlId" VARCHAR(160) NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sourceGeneration" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "onSeconds" INTEGER NOT NULL DEFAULT 0,
    "offSeconds" INTEGER NOT NULL DEFAULT 0,
    "unknownSeconds" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "purgeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeDeviceUsageBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeTemperatureSample" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "temperature" DECIMAL(6,2) NOT NULL,
    "sourceObservedAt" TIMESTAMP(3) NOT NULL,
    "sourceGeneration" INTEGER NOT NULL,
    "purgeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeTemperatureSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomation" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "createdByMembershipId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "NativeAutomationStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "definitionChecksum" VARCHAR(128) NOT NULL,
    "timezone" VARCHAR(80) NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "purgeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationTrigger" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "configuration" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAutomationTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationAction" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "controlId" VARCHAR(160) NOT NULL,
    "descriptorRevision" INTEGER NOT NULL,
    "actionValue" JSONB NOT NULL,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "lastValidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAutomationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeAutomationExecution" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "status" "NativeAutomationExecutionStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "safeOutcome" JSONB,
    "purgeAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeAutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaNativeLink" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "providerSubjectHash" VARCHAR(128) NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL,
    "status" "AlexaNativeLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlexaNativeLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaNativeHomeScope" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "areaIds" JSONB NOT NULL,
    "exposureGeneration" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlexaNativeHomeScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaNativeEndpointProjection" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "areaId" UUID NOT NULL,
    "endpointId" VARCHAR(180) NOT NULL,
    "descriptorRevision" INTEGER NOT NULL,
    "exposureGeneration" INTEGER NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "capabilities" JSONB NOT NULL,
    "status" "AlexaNativeEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlexaNativeEndpointProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlexaNativeDirectiveReceipt" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "requestId" VARCHAR(180) NOT NULL,
    "eventTokenHash" VARCHAR(128),
    "responseStatus" INTEGER NOT NULL,
    "responseDigest" VARCHAR(128),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlexaNativeDirectiveReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeBackgroundTaskState" (
    "taskId" VARCHAR(80) NOT NULL,
    "dispatcher" "NativeTaskDispatcher" NOT NULL,
    "nextDueAt" TIMESTAMP(3),
    "cursor" JSONB,
    "leaseOwner" VARCHAR(120),
    "leaseExpiresAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "lastOutcome" JSONB,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeBackgroundTaskState_pkey" PRIMARY KEY ("taskId")
);

-- CreateTable
CREATE TABLE "NativeDomainOutbox" (
    "id" UUID NOT NULL,
    "homeId" UUID,
    "hubInstallationId" UUID,
    "aggregateType" VARCHAR(60) NOT NULL,
    "aggregateId" VARCHAR(160) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "idempotencyKey" VARCHAR(180) NOT NULL,
    "payload" JSONB NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeDomainOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeNotificationDeliveryReceipt" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "trustedDeviceId" UUID,
    "membershipId" UUID,
    "homeId" UUID NOT NULL,
    "family" "NativeNotificationFamily" NOT NULL,
    "channel" "NativeNotificationChannel" NOT NULL,
    "idempotencyKey" VARCHAR(180) NOT NULL,
    "destinationKind" "NativeNotificationDestinationKind",
    "destinationHomeId" UUID,
    "destinationDeviceId" UUID,
    "deliverAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "NativeDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeNotificationDeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeDeviceOutageIncident" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "deviceId" UUID,
    "hubInstallationId" UUID,
    "causedByHubIncidentId" UUID,
    "offlineObservedAt" TIMESTAMP(3) NOT NULL,
    "alertEligibleAt" TIMESTAMP(3) NOT NULL,
    "alertSentAt" TIMESTAMP(3),
    "recoveredAt" TIMESTAMP(3),
    "recoverySentAt" TIMESTAMP(3),
    "state" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeDeviceOutageIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeSupportTicketTimeline" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "homeId" UUID,
    "eventCode" VARCHAR(80) NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" UUID,
    "customerVisible" BOOLEAN NOT NULL DEFAULT false,
    "safeSummary" VARCHAR(500),
    "safeMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeSupportTicketTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionalOwnershipTransfer" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "outgoingOwnerMembershipId" UUID NOT NULL,
    "proposedIncomingEmailCiphertext" TEXT NOT NULL,
    "contactKeyVersion" INTEGER NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "verificationMethod" VARCHAR(80) NOT NULL,
    "verificationReference" VARCHAR(200) NOT NULL,
    "staffAttestation" VARCHAR(1000) NOT NULL,
    "createdByEmployeeId" UUID NOT NULL,
    "claimReferenceId" UUID,
    "status" "ExceptionalOwnershipTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "ExceptionalOwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeTenantDeviceRecovery" (
    "id" UUID NOT NULL,
    "homeId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "ownerMembershipId" UUID NOT NULL,
    "replacementHubId" UUID NOT NULL,
    "recoverySnapshotCiphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "recommissionExpiresAt" TIMESTAMP(3) NOT NULL,
    "recoveredAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeTenantDeviceRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AreaSourceAlias_homeId_areaId_retiredAt_idx" ON "AreaSourceAlias"("homeId", "areaId", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AreaSourceAlias_hubInstallationId_protocol_sourceAreaId_key" ON "AreaSourceAlias"("hubInstallationId", "protocol", "sourceAreaId");

-- CreateIndex
CREATE INDEX "NativeDeviceSourceAlias_homeId_deviceId_retiredAt_idx" ON "NativeDeviceSourceAlias"("homeId", "deviceId", "retiredAt");

-- CreateIndex
CREATE INDEX "NativeDeviceSourceAlias_protocolIdentityHash_idx" ON "NativeDeviceSourceAlias"("protocolIdentityHash");

-- CreateIndex
CREATE UNIQUE INDEX "NativeDeviceSourceAlias_hubInstallationId_protocol_sourceDe_key" ON "NativeDeviceSourceAlias"("hubInstallationId", "protocol", "sourceDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PermanentDeviceInstallationRequest_customerReference_key" ON "PermanentDeviceInstallationRequest"("customerReference");

-- CreateIndex
CREATE UNIQUE INDEX "PermanentDeviceInstallationRequest_operationsEmailKey_key" ON "PermanentDeviceInstallationRequest"("operationsEmailKey");

-- CreateIndex
CREATE INDEX "PermanentDeviceInstallationRequest_status_createdAt_idx" ON "PermanentDeviceInstallationRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PermanentDeviceInstallationRequest_homeId_createdAt_idx" ON "PermanentDeviceInstallationRequest"("homeId", "createdAt");

-- CreateIndex
CREATE INDEX "PermanentDeviceInstallationRequest_requesterMembershipId_st_idx" ON "PermanentDeviceInstallationRequest"("requesterMembershipId", "status");

-- CreateIndex
CREATE INDEX "NativeCommissioningSession_hubInstallationId_state_expiresA_idx" ON "NativeCommissioningSession"("hubInstallationId", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "NativeCommissioningSession_requestingMembershipId_state_idx" ON "NativeCommissioningSession"("requestingMembershipId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "NativeCommissioningSession_homeId_idempotencyKeyHash_key" ON "NativeCommissioningSession"("homeId", "idempotencyKeyHash");

-- CreateIndex
CREATE INDEX "NativeDeviceUsageBucket_homeId_bucketStart_analyticsCategor_idx" ON "NativeDeviceUsageBucket"("homeId", "bucketStart", "analyticsCategory");

-- CreateIndex
CREATE INDEX "NativeDeviceUsageBucket_purgeAt_idx" ON "NativeDeviceUsageBucket"("purgeAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeDeviceUsageBucket_deviceId_areaId_analyticsCategory_c_key" ON "NativeDeviceUsageBucket"("deviceId", "areaId", "analyticsCategory", "controlId", "bucketStart", "sourceGeneration");

-- CreateIndex
CREATE INDEX "NativeTemperatureSample_homeId_sourceObservedAt_idx" ON "NativeTemperatureSample"("homeId", "sourceObservedAt");

-- CreateIndex
CREATE INDEX "NativeTemperatureSample_deviceId_sourceObservedAt_idx" ON "NativeTemperatureSample"("deviceId", "sourceObservedAt");

-- CreateIndex
CREATE INDEX "NativeTemperatureSample_purgeAt_idx" ON "NativeTemperatureSample"("purgeAt");

-- CreateIndex
CREATE INDEX "NativeAutomation_homeId_status_updatedAt_idx" ON "NativeAutomation"("homeId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "NativeAutomation_purgeAt_idx" ON "NativeAutomation"("purgeAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomation_id_homeId_key" ON "NativeAutomation"("id", "homeId");

-- CreateIndex
CREATE INDEX "NativeAutomationTrigger_automationId_kind_idx" ON "NativeAutomationTrigger"("automationId", "kind");

-- CreateIndex
CREATE INDEX "NativeAutomationAction_homeId_deviceId_controlId_idx" ON "NativeAutomationAction"("homeId", "deviceId", "controlId");

-- CreateIndex
CREATE INDEX "NativeAutomationAction_automationId_needsAttention_idx" ON "NativeAutomationAction"("automationId", "needsAttention");

-- CreateIndex
CREATE UNIQUE INDEX "NativeAutomationExecution_idempotencyKey_key" ON "NativeAutomationExecution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NativeAutomationExecution_homeId_startedAt_idx" ON "NativeAutomationExecution"("homeId", "startedAt");

-- CreateIndex
CREATE INDEX "NativeAutomationExecution_purgeAt_idx" ON "NativeAutomationExecution"("purgeAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaNativeLink_providerSubjectHash_key" ON "AlexaNativeLink"("providerSubjectHash");

-- CreateIndex
CREATE INDEX "AlexaNativeLink_customerAccountId_status_idx" ON "AlexaNativeLink"("customerAccountId", "status");

-- CreateIndex
CREATE INDEX "AlexaNativeHomeScope_homeId_membershipId_revokedAt_idx" ON "AlexaNativeHomeScope"("homeId", "membershipId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaNativeHomeScope_linkId_membershipId_key" ON "AlexaNativeHomeScope"("linkId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaNativeEndpointProjection_endpointId_key" ON "AlexaNativeEndpointProjection"("endpointId");

-- CreateIndex
CREATE INDEX "AlexaNativeEndpointProjection_homeId_membershipId_status_idx" ON "AlexaNativeEndpointProjection"("homeId", "membershipId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaNativeEndpointProjection_linkId_deviceId_key" ON "AlexaNativeEndpointProjection"("linkId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AlexaNativeDirectiveReceipt_requestId_key" ON "AlexaNativeDirectiveReceipt"("requestId");

-- CreateIndex
CREATE INDEX "AlexaNativeDirectiveReceipt_linkId_expiresAt_idx" ON "AlexaNativeDirectiveReceipt"("linkId", "expiresAt");

-- CreateIndex
CREATE INDEX "NativeBackgroundTaskState_dispatcher_nextDueAt_idx" ON "NativeBackgroundTaskState"("dispatcher", "nextDueAt");

-- CreateIndex
CREATE INDEX "NativeBackgroundTaskState_leaseExpiresAt_idx" ON "NativeBackgroundTaskState"("leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeDomainOutbox_idempotencyKey_key" ON "NativeDomainOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NativeDomainOutbox_state_nextAttemptAt_idx" ON "NativeDomainOutbox"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NativeDomainOutbox_homeId_createdAt_idx" ON "NativeDomainOutbox"("homeId", "createdAt");

-- CreateIndex
CREATE INDEX "NativeDomainOutbox_expiresAt_idx" ON "NativeDomainOutbox"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeNotificationDeliveryReceipt_idempotencyKey_key" ON "NativeNotificationDeliveryReceipt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NativeNotificationDeliveryReceipt_customerAccountId_status__idx" ON "NativeNotificationDeliveryReceipt"("customerAccountId", "status", "deliverAfter");

-- CreateIndex
CREATE INDEX "NativeNotificationDeliveryReceipt_homeId_expiresAt_idx" ON "NativeNotificationDeliveryReceipt"("homeId", "expiresAt");

-- CreateIndex
CREATE INDEX "NativeDeviceOutageIncident_homeId_state_alertEligibleAt_idx" ON "NativeDeviceOutageIncident"("homeId", "state", "alertEligibleAt");

-- CreateIndex
CREATE INDEX "NativeDeviceOutageIncident_deviceId_offlineObservedAt_idx" ON "NativeDeviceOutageIncident"("deviceId", "offlineObservedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeDeviceOutageIncident_id_homeId_key" ON "NativeDeviceOutageIncident"("id", "homeId");

-- CreateIndex
CREATE INDEX "NativeSupportTicketTimeline_ticketId_createdAt_idx" ON "NativeSupportTicketTimeline"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "NativeSupportTicketTimeline_homeId_createdAt_idx" ON "NativeSupportTicketTimeline"("homeId", "createdAt");

-- CreateIndex
CREATE INDEX "NativeSupportTicketTimeline_purgeAt_idx" ON "NativeSupportTicketTimeline"("purgeAt");

-- CreateIndex
CREATE INDEX "ExceptionalOwnershipTransfer_homeId_status_createdAt_idx" ON "ExceptionalOwnershipTransfer"("homeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "NativeTenantDeviceRecovery_ownerMembershipId_recommissionEx_idx" ON "NativeTenantDeviceRecovery"("ownerMembershipId", "recommissionExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NativeTenantDeviceRecovery_deviceId_replacementHubId_key" ON "NativeTenantDeviceRecovery"("deviceId", "replacementHubId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_id_customerAccountId_key" ON "TrustedDevice"("id", "customerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeMembership_id_homeId_customerAccountId_key" ON "HomeMembership"("id", "homeId", "customerAccountId");

-- CreateIndex
CREATE INDEX "HubInstallation_homeId_lifecycleStatus_idx" ON "HubInstallation"("homeId", "lifecycleStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AreaAccessRequest_id_areaId_homeId_key" ON "AreaAccessRequest"("id", "areaId", "homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeClaimReference_id_homeId_key" ON "HomeClaimReference"("id", "homeId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeClaimReservation_id_claimReferenceId_customerAccountId_key" ON "HomeClaimReservation"("id", "claimReferenceId", "customerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_id_homeId_key" ON "SupportTicket"("id", "homeId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportAccessRequest_id_homeId_key" ON "SupportAccessRequest"("id", "homeId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSession_id_homeId_key" ON "SupportSession"("id", "homeId");

-- AddForeignKey
ALTER TABLE "Home" ADD CONSTRAINT "Home_activeHubInstallationId_fkey" FOREIGN KEY ("activeHubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubInstallation" ADD CONSTRAINT "HubInstallation_replacesHubInstallationId_fkey" FOREIGN KEY ("replacesHubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaSourceAlias" ADD CONSTRAINT "AreaSourceAlias_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaSourceAlias" ADD CONSTRAINT "AreaSourceAlias_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaSourceAlias" ADD CONSTRAINT "AreaSourceAlias_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceSourceAlias" ADD CONSTRAINT "NativeDeviceSourceAlias_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceSourceAlias" ADD CONSTRAINT "NativeDeviceSourceAlias_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceSourceAlias" ADD CONSTRAINT "NativeDeviceSourceAlias_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermanentDeviceInstallationRequest" ADD CONSTRAINT "PermanentDeviceInstallationRequest_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermanentDeviceInstallationRequest" ADD CONSTRAINT "PermanentDeviceInstallationRequest_requestedAreaId_fkey" FOREIGN KEY ("requestedAreaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermanentDeviceInstallationRequest" ADD CONSTRAINT "PermanentDeviceInstallationRequest_requesterMembershipId_fkey" FOREIGN KEY ("requesterMembershipId") REFERENCES "HomeMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioningSession_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioningSession_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioningSession_requestingMembershipId_fkey" FOREIGN KEY ("requestingMembershipId") REFERENCES "HomeMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioningSession_requestedAreaId_fkey" FOREIGN KEY ("requestedAreaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioningSession_finalDeviceId_fkey" FOREIGN KEY ("finalDeviceId") REFERENCES "NativeDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "NativeDeviceUsageBucket_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "NativeDeviceUsageBucket_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "NativeDeviceUsageBucket_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperatureSample_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperatureSample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperatureSample_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomation" ADD CONSTRAINT "NativeAutomation_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomation" ADD CONSTRAINT "NativeAutomation_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "HomeMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationTrigger" ADD CONSTRAINT "NativeAutomationTrigger_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "NativeAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationAction" ADD CONSTRAINT "NativeAutomationAction_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "NativeAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationAction" ADD CONSTRAINT "NativeAutomationAction_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationAction" ADD CONSTRAINT "NativeAutomationAction_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationExecution" ADD CONSTRAINT "NativeAutomationExecution_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "NativeAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeAutomationExecution" ADD CONSTRAINT "NativeAutomationExecution_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeLink" ADD CONSTRAINT "AlexaNativeLink_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeHomeScope" ADD CONSTRAINT "AlexaNativeHomeScope_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AlexaNativeLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeHomeScope" ADD CONSTRAINT "AlexaNativeHomeScope_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeHomeScope" ADD CONSTRAINT "AlexaNativeHomeScope_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaNativeEndpointProjection_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AlexaNativeLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaNativeEndpointProjection_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaNativeEndpointProjection_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaNativeEndpointProjection_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaNativeEndpointProjection_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlexaNativeDirectiveReceipt" ADD CONSTRAINT "AlexaNativeDirectiveReceipt_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AlexaNativeLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDomainOutbox" ADD CONSTRAINT "NativeDomainOutbox_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDomainOutbox" ADD CONSTRAINT "NativeDomainOutbox_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotificationDeliveryReceipt_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotificationDeliveryReceipt_trustedDeviceId_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotificationDeliveryReceipt_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotificationDeliveryReceipt_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeDeviceOutageIncident_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeDeviceOutageIncident_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeDeviceOutageIncident_hubInstallationId_fkey" FOREIGN KEY ("hubInstallationId") REFERENCES "HubInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeDeviceOutageIncident_causedByHubIncidentId_homeId_fkey" FOREIGN KEY ("causedByHubIncidentId", "homeId") REFERENCES "NativeDeviceOutageIncident"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeSupportTicketTimeline" ADD CONSTRAINT "NativeSupportTicketTimeline_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeSupportTicketTimeline" ADD CONSTRAINT "NativeSupportTicketTimeline_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionalOwnershipTransfer" ADD CONSTRAINT "ExceptionalOwnershipTransfer_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionalOwnershipTransfer" ADD CONSTRAINT "ExceptionalOwnershipTransfer_createdByEmployeeId_fkey" FOREIGN KEY ("createdByEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionalOwnershipTransfer" ADD CONSTRAINT "ExceptionalOwnershipTransfer_claimReferenceId_fkey" FOREIGN KEY ("claimReferenceId") REFERENCES "HomeClaimReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeTenantDeviceRecovery" ADD CONSTRAINT "NativeTenantDeviceRecovery_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeTenantDeviceRecovery" ADD CONSTRAINT "NativeTenantDeviceRecovery_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NativeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeTenantDeviceRecovery" ADD CONSTRAINT "NativeTenantDeviceRecovery_ownerMembershipId_fkey" FOREIGN KEY ("ownerMembershipId") REFERENCES "HomeMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeTenantDeviceRecovery" ADD CONSTRAINT "NativeTenantDeviceRecovery_replacementHubId_fkey" FOREIGN KEY ("replacementHubId") REFERENCES "HubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Native V2 Stage 3 invariants that Prisma cannot express. This file is
-- appended verbatim to the generated additive migration by the guarded local
-- generator. It contains no environment-specific values or secrets.

ALTER TABLE "TenantAreaGrant" ADD CONSTRAINT "TenantAreaGrant_membership_home_stage3_fkey"
  FOREIGN KEY ("membershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantAreaGrant" ADD CONSTRAINT "TenantAreaGrant_area_home_stage3_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDevice" ADD CONSTRAINT "NativeDevice_hub_home_stage3_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipInvitation" ADD CONSTRAINT "MembershipInvitation_inviter_home_stage3_fkey"
  FOREIGN KEY ("inviterMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MembershipInvitationArea" ADD CONSTRAINT "MembershipInvitationArea_invitation_home_stage3_fkey"
  FOREIGN KEY ("invitationId", "homeId") REFERENCES "MembershipInvitation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipInvitationArea" ADD CONSTRAINT "MembershipInvitationArea_area_home_stage3_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AreaAccessRequest" ADD CONSTRAINT "AreaAccessRequest_area_home_stage3_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AreaAccessRequest" ADD CONSTRAINT "AreaAccessRequest_qr_area_stage3_fkey"
  FOREIGN KEY ("areaQrCredentialId", "areaId") REFERENCES "AreaQrCredential" ("id", "areaId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AreaAccessRequest" ADD CONSTRAINT "AreaAccessRequest_approver_home_stage3_fkey"
  FOREIGN KEY ("approvedByMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE SET NULL ("approvedByMembershipId") ON UPDATE CASCADE;
ALTER TABLE "HomeClaimReference" ADD CONSTRAINT "HomeClaimReference_hub_home_stage3_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HomeClaimReference" ADD CONSTRAINT "HomeClaimReference_owner_home_stage3_fkey"
  FOREIGN KEY ("outgoingOwnerMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE SET NULL ("outgoingOwnerMembershipId") ON UPDATE CASCADE;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_membership_home_customer_stage3_fkey"
  FOREIGN KEY ("selectedMembershipId", "homeId", "customerAccountId") REFERENCES "HomeMembership" ("id", "homeId", "customerAccountId") ON DELETE SET NULL ("selectedMembershipId") ON UPDATE CASCADE;
ALTER TABLE "SupportAccessRequest" ADD CONSTRAINT "SupportRequest_ticket_home_stage3_fkey"
  FOREIGN KEY ("ticketId", "homeId") REFERENCES "SupportTicket" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportAccessRequest" ADD CONSTRAINT "SupportRequest_hub_home_stage3_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportAccessRequest" ADD CONSTRAINT "SupportRequest_target_membership_home_stage3_fkey"
  FOREIGN KEY ("targetMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE SET NULL ("targetMembershipId") ON UPDATE CASCADE;
ALTER TABLE "SupportAccessRequest" ADD CONSTRAINT "SupportRequest_approver_membership_home_stage3_fkey"
  FOREIGN KEY ("approvedByMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE SET NULL ("approvedByMembershipId") ON UPDATE CASCADE;
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_request_home_stage3_fkey"
  FOREIGN KEY ("accessRequestId", "homeId") REFERENCES "SupportAccessRequest" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_ticket_home_stage3_fkey"
  FOREIGN KEY ("ticketId", "homeId") REFERENCES "SupportTicket" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_hub_home_stage3_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_target_membership_home_stage3_fkey"
  FOREIGN KEY ("targetMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE SET NULL ("targetMembershipId") ON UPDATE CASCADE;
ALTER TABLE "SupportAccessNotification" ADD CONSTRAINT "SupportNotification_ticket_home_stage3_fkey"
  FOREIGN KEY ("ticketId", "homeId") REFERENCES "SupportTicket" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportAccessNotification" ADD CONSTRAINT "SupportNotification_request_home_stage3_fkey"
  FOREIGN KEY ("accessRequestId", "homeId") REFERENCES "SupportAccessRequest" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportAccessNotification" ADD CONSTRAINT "SupportNotification_session_home_stage3_fkey"
  FOREIGN KEY ("sessionId", "homeId") REFERENCES "SupportSession" ("id", "homeId") ON DELETE SET NULL ("sessionId") ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AreaQrCredential_one_active_generation_idx"
  ON "AreaQrCredential" ("areaId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "AreaAccessRequest_one_pending_requester_area_idx"
  ON "AreaAccessRequest" ("requesterAccountId", "homeId", "areaId") WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX "HubInstallation_one_active_per_home_idx"
  ON "HubInstallation" ("homeId") WHERE "lifecycleStatus" = 'ACTIVE';

ALTER TABLE "AreaSourceAlias" ADD CONSTRAINT "AreaSourceAlias_area_home_stage3_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AreaSourceAlias" ADD CONSTRAINT "AreaSourceAlias_hub_home_stage3_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceSourceAlias" ADD CONSTRAINT "NativeDeviceSourceAlias_device_home_stage3_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceSourceAlias" ADD CONSTRAINT "NativeDeviceSourceAlias_hub_home_stage3_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PermanentDeviceInstallationRequest" ADD CONSTRAINT "PermanentInstallRequest_area_home_fkey"
  FOREIGN KEY ("requestedAreaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PermanentDeviceInstallationRequest" ADD CONSTRAINT "PermanentInstallRequest_requester_home_fkey"
  FOREIGN KEY ("requesterMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioning_hub_home_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioning_membership_home_fkey"
  FOREIGN KEY ("requestingMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioning_area_home_fkey"
  FOREIGN KEY ("requestedAreaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeCommissioningSession" ADD CONSTRAINT "NativeCommissioning_final_device_home_fkey"
  FOREIGN KEY ("finalDeviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE SET NULL ("finalDeviceId") ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "NativeUsage_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "NativeUsage_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperature_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperature_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeAutomation" ADD CONSTRAINT "NativeAutomation_creator_home_fkey"
  FOREIGN KEY ("createdByMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeAutomationAction" ADD CONSTRAINT "NativeAutomationAction_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeAutomationAction" ADD CONSTRAINT "NativeAutomationAction_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeAutomationAction" ADD CONSTRAINT "NativeAutomationAction_automation_home_fkey"
  FOREIGN KEY ("automationId", "homeId") REFERENCES "NativeAutomation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeAutomationExecution" ADD CONSTRAINT "NativeAutomationExecution_automation_home_fkey"
  FOREIGN KEY ("automationId", "homeId") REFERENCES "NativeAutomation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlexaNativeHomeScope" ADD CONSTRAINT "AlexaHomeScope_membership_home_fkey"
  FOREIGN KEY ("membershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaEndpoint_membership_home_fkey"
  FOREIGN KEY ("membershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaEndpoint_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaEndpoint_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeOutage_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeOutage_hub_home_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeOutage_parent_home_fkey"
  FOREIGN KEY ("causedByHubIncidentId", "homeId") REFERENCES "NativeDeviceOutageIncident" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeSupportTicketTimeline" ADD CONSTRAINT "NativeSupportTimeline_ticket_home_fkey"
  FOREIGN KEY ("ticketId", "homeId") REFERENCES "SupportTicket" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExceptionalOwnershipTransfer" ADD CONSTRAINT "ExceptionalTransfer_owner_home_fkey"
  FOREIGN KEY ("outgoingOwnerMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExceptionalOwnershipTransfer" ADD CONSTRAINT "ExceptionalTransfer_claim_home_fkey"
  FOREIGN KEY ("claimReferenceId", "homeId") REFERENCES "HomeClaimReference" ("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NativeTenantDeviceRecovery" ADD CONSTRAINT "NativeRecovery_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeTenantDeviceRecovery" ADD CONSTRAINT "NativeRecovery_owner_home_fkey"
  FOREIGN KEY ("ownerMembershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeTenantDeviceRecovery" ADD CONSTRAINT "NativeRecovery_hub_home_fkey"
  FOREIGN KEY ("replacementHubId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDomainOutbox" ADD CONSTRAINT "NativeDomainOutbox_hub_home_fkey"
  FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation" ("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_area_home_fkey"
  FOREIGN KEY ("areaId", "homeId") REFERENCES "Area" ("id", "homeId") ON DELETE SET NULL ("areaId") ON UPDATE CASCADE;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_device_home_fkey"
  FOREIGN KEY ("deviceId", "homeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE SET NULL ("deviceId") ON UPDATE CASCADE;
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotification_membership_home_fkey"
  FOREIGN KEY ("membershipId", "homeId") REFERENCES "HomeMembership" ("id", "homeId") ON DELETE SET NULL ("membershipId") ON UPDATE CASCADE;
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotification_target_device_home_fkey"
  FOREIGN KEY ("destinationDeviceId", "destinationHomeId") REFERENCES "NativeDevice" ("id", "homeId") ON DELETE SET NULL ("destinationDeviceId") ON UPDATE CASCADE;
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotification_membership_owner_fkey"
  FOREIGN KEY ("membershipId", "homeId", "customerAccountId") REFERENCES "HomeMembership" ("id", "homeId", "customerAccountId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotification_trusted_device_owner_fkey"
  FOREIGN KEY ("trustedDeviceId", "customerAccountId") REFERENCES "TrustedDevice" ("id", "customerAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeOutage_exactly_one_source_check"
  CHECK (("deviceId" IS NOT NULL)::int + ("hubInstallationId" IS NOT NULL)::int = 1);
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeOutage_hub_parent_semantics_check"
  CHECK ("causedByHubIncidentId" IS NULL OR "deviceId" IS NOT NULL);
ALTER TABLE "NativeDeviceOutageIncident" ADD CONSTRAINT "NativeOutage_deadline_check"
  CHECK ("alertEligibleAt" = "offlineObservedAt" + INTERVAL '60 minutes');
CREATE UNIQUE INDEX "NativeOutage_one_open_device_idx"
  ON "NativeDeviceOutageIncident" ("deviceId") WHERE "deviceId" IS NOT NULL AND "state" = 'OPEN';
CREATE UNIQUE INDEX "NativeOutage_one_open_hub_idx"
  ON "NativeDeviceOutageIncident" ("hubInstallationId") WHERE "hubInstallationId" IS NOT NULL AND "state" = 'OPEN';
CREATE UNIQUE INDEX "ExceptionalTransfer_one_open_case_idx"
  ON "ExceptionalOwnershipTransfer" ("homeId") WHERE "status" IN ('DRAFT','SUBMITTED','UNDER_REVIEW');

ALTER TABLE "DeviceAreaAssignment" ADD CONSTRAINT "DeviceAreaAssignment_valid_interval_check"
  CHECK ("validUntil" IS NULL OR "validUntil" > "validFrom");
ALTER TABLE "NativeDevice" ADD CONSTRAINT "NativeDevice_management_owner_check"
  CHECK (("managementClass" = 'PROPERTY_DEVICE' AND "ownerMembershipId" IS NULL) OR ("managementClass" = 'TENANT_DEVICE' AND "ownerMembershipId" IS NOT NULL));
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "NativeUsage_duration_check"
  CHECK ("onSeconds" >= 0 AND "offSeconds" >= 0 AND "unknownSeconds" >= 0 AND "onSeconds" + "offSeconds" + "unknownSeconds" <= 3600 AND ("closedAt" IS NULL OR "onSeconds" + "offSeconds" + "unknownSeconds" = 3600));
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "NativeUsage_purge_after_bucket_check"
  CHECK ("purgeAt" > "bucketStart");
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperature_purge_after_source_check"
  CHECK ("purgeAt" > "sourceObservedAt");
ALTER TABLE "NativeBackgroundTaskState" ADD CONSTRAINT "NativeTask_fixed_registry_check"
  CHECK (("taskId" IN ('operator_credential_lifecycle','support_expiry_and_revocation','claim_reservation_expiry') AND "dispatcher" = 'OPERATIONS') OR ("taskId" = 'expired_dispatch_lease_cleanup' AND "dispatcher" = 'MAINTENANCE'));
ALTER TABLE "NativeBackgroundTaskState" ADD CONSTRAINT "NativeTask_lease_pair_check"
  CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL) AND "consecutiveFailures" >= 0 AND ("cursor" IS NULL OR octet_length("cursor"::text) <= 16384) AND ("lastOutcome" IS NULL OR octet_length("lastOutcome"::text) <= 16384));
ALTER TABLE "NativeDomainOutbox" ADD CONSTRAINT "NativeOutbox_bounds_check"
  CHECK ("state" IN ('PENDING','PROCESSING','DELIVERED','FAILED','CANCELLED') AND "attempts" BETWEEN 0 AND 12 AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '30 days' AND octet_length("payload"::text) <= 16384 AND ("hubInstallationId" IS NULL OR "homeId" IS NOT NULL));
ALTER TABLE "NativeNotificationDeliveryReceipt" ADD CONSTRAINT "NativeNotification_bounds_check"
  CHECK ("attemptCount" BETWEEN 0 AND 8 AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '30 days' AND (("destinationDeviceId" IS NULL) = ("destinationHomeId" IS NULL)) AND (("destinationDeviceId" IS NULL) = ("destinationKind" IS NULL)));
ALTER TABLE "AlexaNativeEndpointProjection" ADD CONSTRAINT "AlexaEndpoint_revision_check"
  CHECK ("descriptorRevision" > 0 AND "exposureGeneration" > 0 AND jsonb_typeof("capabilities") IN ('object','array'));
INSERT INTO "NativeBackgroundTaskState" ("taskId", "dispatcher", "updatedAt") VALUES
  ('operator_credential_lifecycle', 'OPERATIONS', CURRENT_TIMESTAMP),
  ('support_expiry_and_revocation', 'OPERATIONS', CURRENT_TIMESTAMP),
  ('claim_reservation_expiry', 'OPERATIONS', CURRENT_TIMESTAMP),
  ('expired_dispatch_lease_cleanup', 'MAINTENANCE', CURRENT_TIMESTAMP)
ON CONFLICT ("taskId") DO NOTHING;

CREATE FUNCTION "enforce_native_device_tenant_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."managementClass" = 'TENANT_DEVICE' AND NOT EXISTS (
    SELECT 1 FROM "HomeMembership" m WHERE m."id" = NEW."ownerMembershipId" AND m."homeId" = NEW."homeId" AND m."role" = 'TENANT' AND m."status" = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'tenant device owner must be an active tenant membership in the same home' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NativeDevice_tenant_owner_guard" BEFORE INSERT OR UPDATE OF "homeId","managementClass","ownerMembershipId" ON "NativeDevice" FOR EACH ROW EXECUTE FUNCTION "enforce_native_device_tenant_owner"();

CREATE FUNCTION "enforce_home_active_hub_pointer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."activeHubInstallationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "HubInstallation" h WHERE h."id" = NEW."activeHubInstallationId" AND h."homeId" = NEW."id" AND h."lifecycleStatus" = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'active hub pointer must reference this home active installation' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "Home_active_hub_pointer_guard" AFTER INSERT OR UPDATE OF "activeHubInstallationId" ON "Home" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_home_active_hub_pointer"();

CREATE FUNCTION "enforce_home_claim_challenge_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim_hub_id UUID;
BEGIN
  SELECT "hubInstallationId" INTO claim_hub_id FROM "HomeClaimReference" WHERE "id" = NEW."claimReferenceId";
  IF NOT FOUND OR claim_hub_id <> NEW."hubInstallationId" THEN
    RAISE EXCEPTION 'home claim challenge must use the claim reference hub' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "HomeClaimChallenge_reference_hub_guard" BEFORE INSERT OR UPDATE OF "claimReferenceId","hubInstallationId" ON "HomeClaimChallenge" FOR EACH ROW EXECUTE FUNCTION "enforce_home_claim_challenge_binding"();

CREATE FUNCTION "enforce_pending_home_setup_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation_claim_id UUID; reservation_account_id UUID;
BEGIN
  SELECT "claimReferenceId", "customerAccountId" INTO reservation_claim_id, reservation_account_id FROM "HomeClaimReservation" WHERE "id" = NEW."reservationId";
  IF NOT FOUND OR reservation_claim_id <> NEW."claimReferenceId" OR reservation_account_id <> NEW."customerAccountId" THEN
    RAISE EXCEPTION 'pending setup must bind the same claim reservation and customer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PendingHomeSetup_reservation_binding_guard" BEFORE INSERT OR UPDATE OF "reservationId","claimReferenceId","customerAccountId" ON "PendingHomeSetup" FOR EACH ROW EXECUTE FUNCTION "enforce_pending_home_setup_binding"();

CREATE FUNCTION "enforce_active_home_single_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_home_id UUID; current_lifecycle "HomeLifecycle";
BEGIN
  IF TG_TABLE_NAME = 'Home' THEN target_home_id := NEW."id";
  ELSE target_home_id := COALESCE(NEW."homeId", OLD."homeId"); END IF;
  SELECT "lifecycle" INTO current_lifecycle FROM "Home" WHERE "id" = target_home_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF current_lifecycle = 'ACTIVE' AND (
    SELECT count(*) FROM "HomeMembership" WHERE "homeId" = target_home_id AND "role" = 'OWNER' AND "status" = 'ACTIVE'
  ) <> 1 THEN
    RAISE EXCEPTION 'active home must have exactly one active owner membership' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Home_single_active_owner_guard" AFTER INSERT OR UPDATE ON "Home" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_active_home_single_owner"();
CREATE CONSTRAINT TRIGGER "HomeMembership_single_active_owner_guard" AFTER INSERT OR UPDATE OR DELETE ON "HomeMembership" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_active_home_single_owner"();

CREATE FUNCTION "enforce_tenant_device_decommission_on_membership_removal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'ACTIVE' AND EXISTS (
    SELECT 1 FROM "NativeDevice" d WHERE d."ownerMembershipId" = NEW."id" AND d."homeId" = NEW."homeId" AND d."managementClass" = 'TENANT_DEVICE' AND d."lifecycle" NOT IN ('RETIRED','REMOVED')
  ) THEN RAISE EXCEPTION 'tenant-owned devices must be decommissioned before membership removal' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "HomeMembership_tenant_device_decommission_guard" AFTER UPDATE OF "status" ON "HomeMembership" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_tenant_device_decommission_on_membership_removal"();

CREATE FUNCTION "enforce_native_history_device_class"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_management "DeviceManagementClass"; current_category "DeviceAnalyticsCategory"; parent_hub UUID;
BEGIN
  SELECT "managementClass", "analyticsCategory", "hubInstallationId" INTO current_management, current_category, parent_hub FROM "NativeDevice" WHERE "id" = COALESCE(NEW."deviceId", OLD."deviceId") AND "homeId" = NEW."homeId";
  IF TG_TABLE_NAME = 'NativeDeviceUsageBucket' THEN
    IF current_management <> 'PROPERTY_DEVICE' OR current_category <> NEW."analyticsCategory" OR NEW."analyticsCategory" = 'NONE' THEN RAISE EXCEPTION 'analytics history requires a matching permanent property-device category' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'NativeTemperatureSample' THEN
    IF current_management <> 'PROPERTY_DEVICE' OR current_category <> 'RADIATOR' THEN RAISE EXCEPTION 'temperature history requires a permanent Radiator device' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'NativeDeviceOutageIncident' THEN
    IF NEW."deviceId" IS NOT NULL AND current_management = 'TENANT_DEVICE' AND NEW."hubInstallationId" IS NOT NULL THEN RAISE EXCEPTION 'device outage cannot identify both a device and a hub' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "NativeUsage_permanent_category_guard" BEFORE INSERT OR UPDATE ON "NativeDeviceUsageBucket" FOR EACH ROW EXECUTE FUNCTION "enforce_native_history_device_class"();
CREATE TRIGGER "NativeTemperature_permanent_radiator_guard" BEFORE INSERT OR UPDATE ON "NativeTemperatureSample" FOR EACH ROW EXECUTE FUNCTION "enforce_native_history_device_class"();

CREATE FUNCTION "enforce_native_alexa_tenant_scope"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_account UUID; member_account UUID; member_role "MembershipRole"; member_status "MembershipStatus";
BEGIN
  SELECT "customerAccountId" INTO link_account FROM "AlexaNativeLink" WHERE "id" = NEW."linkId" AND "status" = 'ACTIVE';
  SELECT "customerAccountId", "role", "status" INTO member_account, member_role, member_status FROM "HomeMembership" WHERE "id" = NEW."membershipId" AND "homeId" = NEW."homeId";
  IF link_account IS NULL OR link_account <> member_account OR member_role <> 'TENANT' OR member_status <> 'ACTIVE' THEN RAISE EXCEPTION 'Native Alexa scope requires the linked account current active tenant membership' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'AlexaNativeHomeScope' THEN
    IF jsonb_typeof(NEW."areaIds") <> 'array' OR jsonb_array_length(NEW."areaIds") > 64 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW."areaIds") AS allowed(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM "TenantAreaGrant" g JOIN "Area" a ON a."id" = g."areaId" AND a."homeId" = g."homeId"
        WHERE g."membershipId" = NEW."membershipId" AND g."homeId" = NEW."homeId" AND g."areaId"::text = allowed.id AND g."revokedAt" IS NULL AND a."status" = 'ACTIVE'
      )
    ) THEN RAISE EXCEPTION 'Native Alexa selected areas must be current tenant grants' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AlexaNativeHomeScope_tenant_guard" BEFORE INSERT OR UPDATE ON "AlexaNativeHomeScope" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_tenant_scope"();

CREATE FUNCTION "json_contains_app_only_security"(candidate JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key TEXT; child JSONB;
BEGIN
  IF jsonb_typeof(candidate) = 'object' THEN
    IF candidate->>'semanticRole' IN ('security_lock','lock_state') THEN RETURN TRUE; END IF;
    FOR key, child IN SELECT * FROM jsonb_each(candidate) LOOP
      IF "json_contains_app_only_security"(child) THEN RETURN TRUE; END IF;
    END LOOP;
  ELSIF jsonb_typeof(candidate) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(candidate) LOOP
      IF "json_contains_app_only_security"(child) THEN RETURN TRUE; END IF;
    END LOOP;
  END IF;
  RETURN FALSE;
END $$;

CREATE FUNCTION "enforce_native_alexa_endpoint_scope"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link_account UUID; member_account UUID; member_role "MembershipRole"; member_status "MembershipStatus"; device_class "DeviceManagementClass"; owner_membership UUID;
BEGIN
  SELECT "customerAccountId" INTO link_account FROM "AlexaNativeLink" WHERE "id" = NEW."linkId" AND "status" = 'ACTIVE';
  SELECT "customerAccountId", "role", "status" INTO member_account, member_role, member_status FROM "HomeMembership" WHERE "id" = NEW."membershipId" AND "homeId" = NEW."homeId";
  SELECT "managementClass", "ownerMembershipId" INTO device_class, owner_membership FROM "NativeDevice" WHERE "id" = NEW."deviceId" AND "homeId" = NEW."homeId" AND "lifecycle" = 'INSTALLED';
  IF link_account IS NULL OR link_account <> member_account OR member_role <> 'TENANT' OR member_status <> 'ACTIVE' THEN RAISE EXCEPTION 'Native Alexa endpoint requires the linked account current active tenant membership' USING ERRCODE = '23514'; END IF;
  IF device_class IS NULL OR (device_class = 'TENANT_DEVICE' AND owner_membership <> NEW."membershipId") THEN RAISE EXCEPTION 'Native Alexa endpoint device is not visible to the linked tenant' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "TenantAreaGrant" g JOIN "Area" a ON a."id" = g."areaId" AND a."homeId" = g."homeId"
    JOIN "AlexaNativeHomeScope" s ON s."linkId" = NEW."linkId" AND s."membershipId" = NEW."membershipId" AND s."homeId" = NEW."homeId" AND s."revokedAt" IS NULL
    WHERE g."membershipId" = NEW."membershipId" AND g."homeId" = NEW."homeId" AND g."areaId" = NEW."areaId" AND g."revokedAt" IS NULL AND a."status" = 'ACTIVE' AND s."areaIds" @> jsonb_build_array(NEW."areaId"::text)
  ) THEN RAISE EXCEPTION 'Native Alexa endpoint area is not in the current selected tenant scope' USING ERRCODE = '23514'; END IF;
  IF "json_contains_app_only_security"(NEW."capabilities") THEN RAISE EXCEPTION 'App-only security controls cannot be exposed through Alexa' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AlexaNativeEndpoint_tenant_scope_guard" BEFORE INSERT OR UPDATE ON "AlexaNativeEndpointProjection" FOR EACH ROW EXECUTE FUNCTION "enforce_native_alexa_endpoint_scope"();

-- Run existing-row backfills after all DDL to avoid mutating tables while
-- their deferred Stage 1 constraint triggers are queued in this transaction.
-- Promote only a previously installed, non-revoked hub. Incomplete or revoked
-- installations remain pending/history and cannot become selected authority.
UPDATE "HubInstallation" AS hub SET "lifecycleStatus" = 'ACTIVE'
FROM "Home" AS home
WHERE hub."homeId" = home."id" AND hub."lifecycleStatus" = 'PENDING'
  AND hub."state" IN ('ACTIVE','MAINTENANCE','DEREGISTRATION_PENDING','WAITING_FOR_CLEANUP')
  AND home."installationStatus" = 'COMPLETE'
  AND home."lifecycle"::text <> 'RETIRED';
UPDATE "Home" AS home
SET "activeHubInstallationId" = hub."id"
FROM "HubInstallation" AS hub
WHERE hub."homeId" = home."id" AND hub."lifecycleStatus" = 'ACTIVE';
