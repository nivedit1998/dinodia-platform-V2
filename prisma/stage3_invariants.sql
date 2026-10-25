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
