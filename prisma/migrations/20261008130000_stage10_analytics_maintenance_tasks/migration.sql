-- Activate only the already allocated Stage 10 analytics and retention work
-- inside the existing daily MAINTENANCE dispatcher. No schedule is added.
-- The existing history guard is a BEFORE row trigger. Returning NULL silently
-- cancelled valid usage/temperature inserts, so preserve its checks and return
-- NEW for accepted rows. Invalid private/mismatched history still raises.
CREATE OR REPLACE FUNCTION "enforce_native_history_device_class"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_management "DeviceManagementClass"; current_category "DeviceAnalyticsCategory"; parent_hub UUID;
BEGIN
  SELECT "managementClass", "analyticsCategory", "hubInstallationId"
    INTO current_management, current_category, parent_hub
    FROM "NativeDevice"
    WHERE "id" = COALESCE(NEW."deviceId", OLD."deviceId") AND "homeId" = NEW."homeId";
  IF TG_TABLE_NAME = 'NativeDeviceUsageBucket' THEN
    IF current_management <> 'PROPERTY_DEVICE' OR current_category <> NEW."analyticsCategory" OR NEW."analyticsCategory" = 'NONE' THEN
      RAISE EXCEPTION 'analytics history requires a matching permanent property-device category' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'NativeTemperatureSample' THEN
    IF current_management <> 'PROPERTY_DEVICE' OR current_category <> 'RADIATOR' THEN
      RAISE EXCEPTION 'temperature history requires a permanent Radiator device' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'NativeDeviceOutageIncident' THEN
    IF NEW."deviceId" IS NOT NULL AND current_management = 'TENANT_DEVICE' AND NEW."hubInstallationId" IS NOT NULL THEN
      RAISE EXCEPTION 'device outage cannot identify both a device and a hub' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "NativeBackgroundTaskState"
  DROP CONSTRAINT "NativeTask_fixed_registry_check";

ALTER TABLE "NativeBackgroundTaskState"
  ADD CONSTRAINT "NativeTask_fixed_registry_check"
  CHECK (
    ("taskId" IN ('operator_credential_lifecycle','support_expiry_and_revocation','claim_reservation_expiry') AND "dispatcher" = 'OPERATIONS')
    OR ("taskId" IN ('expired_dispatch_lease_cleanup','retentionCleanup','analyticsAndStorageMaintenance') AND "dispatcher" = 'MAINTENANCE')
  );

INSERT INTO "NativeBackgroundTaskState" ("taskId", "dispatcher", "updatedAt") VALUES
  ('retentionCleanup', 'MAINTENANCE', CURRENT_TIMESTAMP),
  ('analyticsAndStorageMaintenance', 'MAINTENANCE', CURRENT_TIMESTAMP)
ON CONFLICT ("taskId") DO NOTHING;
