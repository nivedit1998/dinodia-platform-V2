ALTER TABLE "HubInstallation" ADD COLUMN "analyticsWriterEnabled" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "analyticsCollectionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NativeDeviceUsageBucket"
  ADD COLUMN "bindingRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "analyticsPolicyVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "analyticsIntervalId" UUID;
DROP INDEX "NativeDeviceUsageBucket_deviceId_areaId_analyticsCategory_c_key";
CREATE UNIQUE INDEX "NativeDeviceUsageBucket_epoch_key" ON "NativeDeviceUsageBucket"("deviceId", "areaId", "analyticsCategory", "controlId", "bucketStart", "sourceGeneration", "bindingRevision");
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "usage_writer_version" CHECK
  (("bindingRevision" = 0 AND "analyticsPolicyVersion" = 1 AND "analyticsIntervalId" IS NULL)
   OR ("bindingRevision" > 0 AND "analyticsPolicyVersion" = 2 AND "analyticsIntervalId" IS NOT NULL));
CREATE TABLE "NativeAnalyticsInterval" (
  "id" UUID PRIMARY KEY, "homeId" UUID NOT NULL REFERENCES "Home"("id") ON DELETE CASCADE,
  "hubInstallationId" UUID NOT NULL REFERENCES "HubInstallation"("id") ON DELETE CASCADE,
  "deviceId" UUID NOT NULL REFERENCES "NativeDevice"("id") ON DELETE CASCADE,
  "analyticsCategory" "DeviceAnalyticsCategory" NOT NULL, "selectedControlId" VARCHAR(160), "authorizedControls" JSONB NOT NULL,
  "sourceGeneration" INTEGER NOT NULL CHECK ("sourceGeneration" > 0), "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "validFrom" TIMESTAMP(3) NOT NULL, "validUntil" TIMESTAMP(3), "newWriterFrom" TIMESTAMP(3),
  CONSTRAINT "analytics_interval_span" CHECK ("validUntil" IS NULL OR "validUntil" > "validFrom")
);
CREATE UNIQUE INDEX "NativeAnalyticsInterval_deviceId_revision_key" ON "NativeAnalyticsInterval"("deviceId", "revision");
CREATE UNIQUE INDEX "analytics_one_open_interval" ON "NativeAnalyticsInterval"("deviceId") WHERE "validUntil" IS NULL;
CREATE INDEX "NativeAnalyticsInterval_homeId_deviceId_validFrom_idx" ON "NativeAnalyticsInterval"("homeId", "deviceId", "validFrom");
CREATE TABLE "NativeAnalyticsUnallocated" (
  "id" UUID PRIMARY KEY, "homeId" UUID NOT NULL REFERENCES "Home"("id") ON DELETE CASCADE,
  "hubInstallationId" UUID NOT NULL REFERENCES "HubInstallation"("id") ON DELETE CASCADE,
  "deviceId" UUID NOT NULL REFERENCES "NativeDevice"("id") ON DELETE CASCADE,
  "areaId" UUID NOT NULL REFERENCES "Area"("id") ON DELETE CASCADE, "analyticsCategory" "DeviceAnalyticsCategory" NOT NULL,
  "eventId" UUID NOT NULL, "payload" JSONB NOT NULL, "evidenceDigest" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(80) NOT NULL, "coverageStartAt" TIMESTAMP(3) NOT NULL, "coverageEndAt" TIMESTAMP(3) NOT NULL,
  "purgeAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("coverageEndAt" > "coverageStartAt")
);
CREATE UNIQUE INDEX "NativeAnalyticsUnallocated_hubInstallationId_eventId_key" ON "NativeAnalyticsUnallocated"("hubInstallationId", "eventId");
CREATE INDEX "NativeAnalyticsUnallocated_homeId_coverageStartAt_idx" ON "NativeAnalyticsUnallocated"("homeId", "coverageStartAt");
CREATE INDEX "NativeAnalyticsUnallocated_purgeAt_idx" ON "NativeAnalyticsUnallocated"("purgeAt");

CREATE FUNCTION "enforce_analytics_interval_authority"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."deviceId"::text, 0));
  IF NOT EXISTS (SELECT 1 FROM "NativeDevice" d WHERE d.id = NEW."deviceId" AND d."homeId" = NEW."homeId"
    AND d."hubInstallationId" = NEW."hubInstallationId" AND d."managementClass" = 'PROPERTY_DEVICE' AND d."ownerMembershipId" IS NULL) THEN
    RAISE EXCEPTION 'analytics interval requires matching permanent Home authority' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'NativeAnalyticsInterval' THEN
    IF EXISTS (SELECT 1 FROM "NativeAnalyticsInterval" i WHERE i."deviceId" = NEW."deviceId"
      AND i.id <> NEW.id AND tsrange(i."validFrom", i."validUntil", '[)') && tsrange(NEW."validFrom", NEW."validUntil", '[)')) THEN
      RAISE EXCEPTION 'analytics intervals cannot overlap' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM "Area" WHERE id = NEW."areaId" AND "homeId" = NEW."homeId") THEN
    RAISE EXCEPTION 'unallocated evidence requires the same Home Area' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "analytics_interval_authority" BEFORE INSERT OR UPDATE ON "NativeAnalyticsInterval" FOR EACH ROW EXECUTE FUNCTION "enforce_analytics_interval_authority"();
CREATE TRIGGER "analytics_unallocated_authority" BEFORE INSERT OR UPDATE ON "NativeAnalyticsUnallocated" FOR EACH ROW EXECUTE FUNCTION "enforce_analytics_interval_authority"();

CREATE FUNCTION "enforce_native_usage_interval"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d "NativeDevice"; i "NativeAnalyticsInterval";
BEGIN
  SELECT * INTO d FROM "NativeDevice" WHERE id = NEW."deviceId" AND "homeId" = NEW."homeId" FOR UPDATE;
  IF d.id IS NULL OR d."managementClass" <> 'PROPERTY_DEVICE' OR d."ownerMembershipId" IS NOT NULL OR NEW."analyticsCategory" = 'NONE' THEN
    RAISE EXCEPTION 'usage requires permanent Home authority' USING ERRCODE = '23514';
  END IF;
  IF NEW."bindingRevision" > 0 THEN
    SELECT * INTO i FROM "NativeAnalyticsInterval" WHERE id = NEW."analyticsIntervalId" AND "deviceId" = d.id
      AND "homeId" = NEW."homeId" AND "hubInstallationId" = d."hubInstallationId" AND revision = NEW."bindingRevision"
      AND "sourceGeneration" = NEW."sourceGeneration" AND "analyticsCategory" = NEW."analyticsCategory"
      AND "validFrom" <= NEW."coverageStartAt" AND ("validUntil" IS NULL OR "validUntil" >= NEW."coverageEndAt")
      AND ("selectedControlId" IS NULL OR "selectedControlId" = NEW."controlId");
    IF i.id IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i."authorizedControls") c WHERE c->>'controlId' = NEW."controlId" AND c->>'observable' = 'true') THEN
      RAISE EXCEPTION 'usage requires its exact authorized analytics interval' USING ERRCODE = '23514';
    END IF;
  ELSIF d."analyticsCategory" <> NEW."analyticsCategory" AND NOT EXISTS (SELECT 1 FROM "NativeAnalyticsInterval" history
    WHERE history."deviceId" = d.id AND history."analyticsCategory" = NEW."analyticsCategory" AND history."sourceGeneration" = NEW."sourceGeneration"
      AND history."validFrom" <= NEW."coverageStartAt" AND (history."validUntil" IS NULL OR history."validUntil" >= NEW."coverageEndAt")) THEN
    RAISE EXCEPTION 'legacy usage requires authorized category coverage' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "NativeDeviceUsageBucket" b WHERE b."deviceId" = d.id AND b.id <> NEW.id
    AND b."sourceGeneration" = NEW."sourceGeneration" AND b."coverageStartAt" < NEW."coverageEndAt" AND b."coverageEndAt" > NEW."coverageStartAt") THEN
    RAISE EXCEPTION 'physical-device usage coverage cannot overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER "NativeUsage_permanent_category_guard" ON "NativeDeviceUsageBucket";
CREATE TRIGGER "NativeUsage_permanent_category_guard" BEFORE INSERT OR UPDATE ON "NativeDeviceUsageBucket" FOR EACH ROW EXECUTE FUNCTION "enforce_native_usage_interval"();
