-- Native V2 Stage 1 additive security authorities.
-- This migration never edits or resets the foundation migration.

CREATE TYPE "EmployeeSessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SupportAccessScope" AS ENUM ('TENANT_SCOPE', 'PROPERTY_SCOPE');
CREATE TYPE "SupportAccessRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'ISSUED', 'REDEEMED', 'EXPIRED', 'REVOKED', 'ENDED');
CREATE TYPE "SupportSessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'ENDED', 'PENDING_HUB_REVOKE');
CREATE TYPE "CloudUrlVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

ALTER TABLE "HubProvisioningAttempt" ALTER COLUMN "companyWorkItemId" DROP NOT NULL;

ALTER TYPE "ProvisioningState" ADD VALUE IF NOT EXISTS 'EMPLOYEE_APPROVED';
ALTER TYPE "ProvisioningState" ADD VALUE IF NOT EXISTS 'CHALLENGE_ISSUED';
ALTER TYPE "ProvisioningState" ADD VALUE IF NOT EXISTS 'HUB_PROVED';
ALTER TYPE "ProvisioningState" ADD VALUE IF NOT EXISTS 'CREDENTIAL_DELIVERED';
ALTER TYPE "ProvisioningState" ADD VALUE IF NOT EXISTS 'CONSUMED';

ALTER TABLE "HubCredentialVersion"
  ADD COLUMN "ciphertextKeyVersion" INTEGER,
  ADD COLUMN "revokedReason" VARCHAR(160),
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDeliveryError" VARCHAR(500),
  ADD COLUMN "purpose" VARCHAR(40) NOT NULL DEFAULT 'operator-credential';

-- OperatorHandoff binds a workflow to the selected home.  The foundation
-- model already has a stable workflow id, but PostgreSQL requires the
-- referenced (id, home_id) pair to be unique before it can enforce that
-- relationship.  This additive index is also represented in Prisma above.
CREATE UNIQUE INDEX "CompanyOperationalWorkItem_id_homeId_key"
  ON "CompanyOperationalWorkItem"("id", "homeId");

CREATE INDEX "HubCredentialVersion_hub_purpose_state_idx"
  ON "HubCredentialVersion"("hubInstallationId", "purpose", "state");

CREATE TABLE "EmployeeSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "employeeId" UUID NOT NULL,
  "tokenHash" VARCHAR(128) NOT NULL,
  "status" "EmployeeSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "recentAuthenticatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeSession_employee_fkey" FOREIGN KEY ("employeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmployeeSession_tokenHash_key" ON "EmployeeSession"("tokenHash");
CREATE INDEX "EmployeeSession_employeeId_status_expiresAt_idx" ON "EmployeeSession"("employeeId", "status", "expiresAt");

CREATE TABLE "OperatorHandoff" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "employeeId" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "attemptId" UUID,
  "handoffHash" VARCHAR(128) NOT NULL,
  "scope" JSONB NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperatorHandoff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OperatorHandoff_employee_fkey" FOREIGN KEY ("employeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OperatorHandoff_workflow_fkey" FOREIGN KEY ("workflowId") REFERENCES "CompanyOperationalWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OperatorHandoff_home_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OperatorHandoff_hub_home_fkey" FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OperatorHandoff_workflow_home_fkey" FOREIGN KEY ("workflowId", "homeId") REFERENCES "CompanyOperationalWorkItem"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OperatorHandoff_handoffHash_key" ON "OperatorHandoff"("handoffHash");
CREATE INDEX "OperatorHandoff_employeeId_expiresAt_consumedAt_idx" ON "OperatorHandoff"("employeeId", "expiresAt", "consumedAt");
CREATE INDEX "OperatorHandoff_hubInstallationId_expiresAt_consumedAt_idx" ON "OperatorHandoff"("hubInstallationId", "expiresAt", "consumedAt");

CREATE TABLE "StepUpChallenge" (
  "id" UUID NOT NULL,
  "customerAccountId" UUID NOT NULL,
  "customerSessionId" UUID NOT NULL,
  "trustedDeviceId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "operationKind" VARCHAR(120) NOT NULL,
  "targetDigest" VARCHAR(128) NOT NULL,
  "normalizedValueDigest" VARCHAR(128) NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "nonceHash" VARCHAR(128) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "StepUpChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StepUpChallenge_account_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StepUpChallenge_session_fkey" FOREIGN KEY ("customerSessionId") REFERENCES "CustomerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StepUpChallenge_device_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StepUpChallenge_membership_home_fkey" FOREIGN KEY ("membershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StepUpChallenge_hub_home_fkey" FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StepUpChallenge_nonceHash_key" ON "StepUpChallenge"("nonceHash");
CREATE INDEX "StepUpChallenge_session_expiry_idx" ON "StepUpChallenge"("customerSessionId", "expiresAt", "consumedAt");
CREATE INDEX "StepUpChallenge_account_home_membership_idx" ON "StepUpChallenge"("customerAccountId", "homeId", "membershipId");

CREATE TABLE "SupportTicket" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "publicReference" VARCHAR(32) NOT NULL,
  "customerAccountId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "selectedMembershipId" UUID NOT NULL,
  "assignedEmployeeId" UUID,
  "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
  "category" VARCHAR(80) NOT NULL,
  "description" VARCHAR(4000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportTicket_customer_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportTicket_home_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportTicket_membership_home_fkey" FOREIGN KEY ("selectedMembershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupportTicket_employee_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SupportTicket_publicReference_key" ON "SupportTicket"("publicReference");
CREATE INDEX "SupportTicket_customerAccountId_status_idx" ON "SupportTicket"("customerAccountId", "status");
CREATE INDEX "SupportTicket_homeId_status_idx" ON "SupportTicket"("homeId", "status");
CREATE INDEX "SupportTicket_assignedEmployeeId_status_idx" ON "SupportTicket"("assignedEmployeeId", "status");

CREATE TABLE "SupportAccessRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ticketId" UUID NOT NULL,
  "requestedByEmployeeId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "requestedScope" "SupportAccessScope" NOT NULL,
  "targetMembershipId" UUID,
  "targetUserId" UUID,
  "canonicalAreaIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "targetIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "touchesPropertyInfrastructure" BOOLEAN NOT NULL DEFAULT false,
  "status" "SupportAccessRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "approvedByMembershipId" UUID,
  "approvedAt" TIMESTAMP(3),
  "deniedAt" TIMESTAMP(3),
  "denialReason" VARCHAR(500),
  "codeHash" VARCHAR(128),
  "codeIssuedAt" TIMESTAMP(3),
  "codeExpiresAt" TIMESTAMP(3),
  "codeConsumedAt" TIMESTAMP(3),
  "codeAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "sessionHardStopAt" TIMESTAMP(3),
  "desiredRevokedAt" TIMESTAMP(3),
  "hubRevokedAt" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportAccessRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportAccessRequest_ticket_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessRequest_employee_fkey" FOREIGN KEY ("requestedByEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessRequest_hub_home_fkey" FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessRequest_membership_home_fkey" FOREIGN KEY ("approvedByMembershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessRequest_target_membership_home_fkey" FOREIGN KEY ("targetMembershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "SupportAccessRequest_ticketId_status_idx" ON "SupportAccessRequest"("ticketId", "status");
CREATE INDEX "SupportAccessRequest_homeId_status_idx" ON "SupportAccessRequest"("homeId", "status");
CREATE INDEX "SupportAccessRequest_employee_status_idx" ON "SupportAccessRequest"("requestedByEmployeeId", "status");
CREATE INDEX "SupportAccessRequest_code_idx" ON "SupportAccessRequest"("codeHash", "codeExpiresAt");
CREATE UNIQUE INDEX "SupportAccessRequest_one_open_per_ticket_scope_idx" ON "SupportAccessRequest"("ticketId", "requestedScope") WHERE "status" IN ('REQUESTED', 'APPROVED', 'ISSUED', 'REDEEMED');

CREATE TABLE "SupportSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accessRequestId" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "scope" "SupportAccessScope" NOT NULL,
  "areaIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "targetUserId" UUID,
  "status" "SupportSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "leaseHash" VARCHAR(128) NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "desiredRevokedAt" TIMESTAMP(3),
  "hubAcknowledgedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportSession_access_request_fkey" FOREIGN KEY ("accessRequestId") REFERENCES "SupportAccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportSession_ticket_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportSession_employee_fkey" FOREIGN KEY ("employeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupportSession_hub_home_fkey" FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SupportSession_leaseHash_key" ON "SupportSession"("leaseHash");
CREATE INDEX "SupportSession_ticketId_status_idx" ON "SupportSession"("ticketId", "status");
CREATE INDEX "SupportSession_hub_status_expiry_idx" ON "SupportSession"("hubInstallationId", "status", "expiresAt");

CREATE TABLE "OfflineMembershipAuthorisation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "trustedDeviceId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "publicKey" TEXT NOT NULL,
  "publicKeyThumbprint" VARCHAR(128) NOT NULL,
  "areaIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "scopes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "policyRevision" INTEGER NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" VARCHAR(160),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OfflineMembershipAuthorisation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfflineMembershipAuthorisation_device_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OfflineMembershipAuthorisation_membership_home_fkey" FOREIGN KEY ("membershipId", "homeId") REFERENCES "HomeMembership"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OfflineMembershipAuthorisation_hub_home_fkey" FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OfflineMembershipAuthorisation_device_membership_hub_key" ON "OfflineMembershipAuthorisation"("trustedDeviceId", "membershipId", "hubInstallationId");
CREATE INDEX "OfflineMembershipAuthorisation_home_membership_revoked_idx" ON "OfflineMembershipAuthorisation"("homeId", "membershipId", "revokedAt");
CREATE INDEX "OfflineMembershipAuthorisation_thumbprint_idx" ON "OfflineMembershipAuthorisation"("publicKeyThumbprint", "revokedAt");

CREATE TABLE "CloudUrlVerification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hubInstallationId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "reservedHostname" VARCHAR(255) NOT NULL,
  "tunnelId" VARCHAR(200) NOT NULL,
  "tunnelName" VARCHAR(200) NOT NULL,
  "cloudUrl" VARCHAR(500) NOT NULL,
  "challengeHash" VARCHAR(128) NOT NULL,
  "signedResponseDigest" VARCHAR(128),
  "status" "CloudUrlVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CloudUrlVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CloudUrlVerification_hub_home_fkey" FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CloudUrlVerification_hub_tunnel_key" ON "CloudUrlVerification"("hubInstallationId", "tunnelId");
CREATE INDEX "CloudUrlVerification_hub_status_idx" ON "CloudUrlVerification"("hubInstallationId", "status");

ALTER TABLE "HubCredentialVersion"
  ADD CONSTRAINT "HubCredentialVersion_purpose_check"
  CHECK ("purpose" IN ('operator-credential', 'machine-credential'));

ALTER TABLE "SupportAccessRequest"
  ADD CONSTRAINT "SupportAccessRequest_scope_shape_check"
  CHECK (("requestedScope" = 'TENANT_SCOPE' AND "targetMembershipId" IS NOT NULL)
      OR ("requestedScope" = 'PROPERTY_SCOPE' AND "targetMembershipId" IS NULL));

CREATE OR REPLACE FUNCTION dinodia_validate_stage1_support_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_role "MembershipRole";
BEGIN
  IF NEW."requestedScope" = 'TENANT_SCOPE' THEN
    SELECT "role" INTO target_role FROM "HomeMembership"
      WHERE "id" = NEW."targetMembershipId" AND "homeId" = NEW."homeId" AND "status" = 'ACTIVE';
    IF target_role IS DISTINCT FROM 'TENANT' THEN
      RAISE EXCEPTION 'tenant support scope requires an active tenant membership in the same home';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

-- Composite foreign keys prove home identity. These deferred guards prove
-- the remaining account/employee/workflow relationships without duplicating
-- feature data into the Stage 1 security tables.
CREATE OR REPLACE FUNCTION dinodia_validate_stage1_ticket_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE membership_account uuid; membership_home uuid;
BEGIN
  SELECT "customerAccountId", "homeId" INTO membership_account, membership_home
    FROM "HomeMembership" WHERE "id" = NEW."selectedMembershipId";
  IF membership_home IS DISTINCT FROM NEW."homeId"
     OR membership_account IS DISTINCT FROM NEW."customerAccountId" THEN
    RAISE EXCEPTION 'support ticket membership must belong to the ticket customer and home';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_stage1_support_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ticket_home uuid; ticket_employee uuid; target_account uuid;
BEGIN
  SELECT "homeId", "assignedEmployeeId" INTO ticket_home, ticket_employee
    FROM "SupportTicket" WHERE "id" = NEW."ticketId";
  IF ticket_home IS DISTINCT FROM NEW."homeId"
     OR ticket_employee IS DISTINCT FROM NEW."requestedByEmployeeId" THEN
    RAISE EXCEPTION 'support access request must use its ticket home and assigned employee';
  END IF;
  IF NEW."requestedScope" = 'TENANT_SCOPE' THEN
    SELECT "customerAccountId" INTO target_account FROM "HomeMembership"
      WHERE "id" = NEW."targetMembershipId" AND "homeId" = NEW."homeId";
    IF target_account IS NULL OR NEW."targetUserId" IS DISTINCT FROM target_account THEN
      RAISE EXCEPTION 'tenant support request target must match the tenant membership account';
    END IF;
  ELSIF NEW."targetUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'property support request cannot contain a tenant target account';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_stage1_support_session()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_record record; ticket_home uuid;
BEGIN
  SELECT "ticketId", "requestedByEmployeeId", "homeId", "hubInstallationId", "requestedScope", "targetUserId"
    INTO request_record FROM "SupportAccessRequest" WHERE "id" = NEW."accessRequestId";
  IF request_record."ticketId" IS NULL
     OR request_record."ticketId" IS DISTINCT FROM NEW."ticketId"
     OR request_record."requestedByEmployeeId" IS DISTINCT FROM NEW."employeeId"
     OR request_record."homeId" IS DISTINCT FROM NEW."homeId"
     OR request_record."hubInstallationId" IS DISTINCT FROM NEW."hubInstallationId"
     OR request_record."requestedScope" IS DISTINCT FROM NEW."scope"
     OR request_record."targetUserId" IS DISTINCT FROM NEW."targetUserId" THEN
    RAISE EXCEPTION 'support session must match its approved access request';
  END IF;
  SELECT "homeId" INTO ticket_home FROM "SupportTicket" WHERE "id" = NEW."ticketId";
  IF ticket_home IS DISTINCT FROM NEW."homeId" THEN
    RAISE EXCEPTION 'support session must match its ticket home';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_stage1_offline_authorisation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE device_account uuid; membership_account uuid;
BEGIN
  SELECT "customerAccountId" INTO device_account FROM "TrustedDevice" WHERE "id" = NEW."trustedDeviceId";
  SELECT "customerAccountId" INTO membership_account FROM "HomeMembership"
    WHERE "id" = NEW."membershipId" AND "homeId" = NEW."homeId";
  IF device_account IS NULL OR membership_account IS NULL OR device_account IS DISTINCT FROM membership_account THEN
    RAISE EXCEPTION 'offline authorisation trusted device and membership must belong to the same account and home';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_stage1_operator_handoff()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE work_record record;
BEGIN
  SELECT "assignedEmployeeId", "homeId", "hubInstallationId" INTO work_record
    FROM "CompanyOperationalWorkItem" WHERE "id" = NEW."workflowId";
  IF work_record."assignedEmployeeId" IS DISTINCT FROM NEW."employeeId"
     OR work_record."homeId" IS DISTINCT FROM NEW."homeId"
     OR work_record."hubInstallationId" IS DISTINCT FROM NEW."hubInstallationId" THEN
    RAISE EXCEPTION 'operator handoff must match the assigned workflow employee, home and hub';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_stage1_claim_challenge()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim_hub uuid;
BEGIN
  SELECT "hubInstallationId" INTO claim_hub FROM "HomeClaimReference" WHERE "id" = NEW."claimReferenceId";
  IF claim_hub IS DISTINCT FROM NEW."hubInstallationId" THEN
    RAISE EXCEPTION 'home claim challenge and claim reference must use the same hub';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION dinodia_validate_stage1_area_access()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE qr_home uuid; area_home uuid;
BEGIN
  SELECT a."homeId" INTO qr_home FROM "AreaQrCredential" q JOIN "Area" a ON a."id" = q."areaId"
    WHERE q."id" = NEW."areaQrCredentialId";
  SELECT "homeId" INTO area_home FROM "Area" WHERE "id" = NEW."areaId";
  IF qr_home IS DISTINCT FROM NEW."homeId" OR area_home IS DISTINCT FROM NEW."homeId" THEN
    RAISE EXCEPTION 'area access request QR, area and home must agree';
  END IF;
  RETURN NEW;
END; $$;

CREATE CONSTRAINT TRIGGER "SupportTicket_scope_guard"
AFTER INSERT OR UPDATE ON "SupportTicket" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_ticket_scope();
CREATE CONSTRAINT TRIGGER "SupportAccessRequest_scope_relationship_guard"
AFTER INSERT OR UPDATE ON "SupportAccessRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_support_request();
CREATE CONSTRAINT TRIGGER "SupportSession_scope_guard"
AFTER INSERT OR UPDATE ON "SupportSession" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_support_session();
CREATE CONSTRAINT TRIGGER "OfflineMembershipAuthorisation_scope_guard"
AFTER INSERT OR UPDATE ON "OfflineMembershipAuthorisation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_offline_authorisation();
CREATE CONSTRAINT TRIGGER "OperatorHandoff_workflow_guard"
AFTER INSERT OR UPDATE ON "OperatorHandoff" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_operator_handoff();
CREATE CONSTRAINT TRIGGER "HomeClaimChallenge_hub_guard"
AFTER INSERT OR UPDATE ON "HomeClaimChallenge" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_claim_challenge();
CREATE CONSTRAINT TRIGGER "AreaAccessRequest_scope_guard"
AFTER INSERT OR UPDATE ON "AreaAccessRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_area_access();

CREATE CONSTRAINT TRIGGER "SupportAccessRequest_scope_guard"
AFTER INSERT OR UPDATE ON "SupportAccessRequest"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION dinodia_validate_stage1_support_scope();

REVOKE ALL PRIVILEGES ON "EmployeeSession", "OperatorHandoff", "SupportTicket", "SupportAccessRequest", "SupportSession", "OfflineMembershipAuthorisation", "CloudUrlVerification" FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE "EmployeeSession", "OperatorHandoff", "SupportTicket", "SupportAccessRequest", "SupportSession", "OfflineMembershipAuthorisation", "CloudUrlVerification" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

-- Free-tier scheduling contract. Supabase installations that provide pg_cron,
-- pg_net and Vault receive exactly one idempotent two-minute dispatcher job.
-- Docker/PostgreSQL proofs do not provide those Supabase extensions, so this
-- block deliberately becomes a no-op there. URL and bearer secret values are
-- read only from Vault at execution time and never stored in Git.
DO $dinodia_native_operations_schedule$
DECLARE
  has_cron boolean := EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron');
  has_net boolean := EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net');
  has_vault boolean := EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'supabase_vault');
BEGIN
  IF NOT (has_cron AND has_net AND has_vault) THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_net';
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;
  BEGIN
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1' USING 'dinodia-native-operations';
  EXCEPTION WHEN undefined_table OR undefined_function THEN
    RETURN;
  END;
  EXECUTE 'SELECT cron.schedule($1, $2, $3)'
    USING
      'dinodia-native-operations',
      '*/2 * * * *',
      $$SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_URL'),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'DINODIA_NATIVE_OPERATIONS_CRON_SECRET')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 8000
      )$$;
END $dinodia_native_operations_schedule$;
